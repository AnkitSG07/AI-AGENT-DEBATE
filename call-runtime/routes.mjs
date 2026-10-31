import { MediaError, requireValue } from '../media/errors.mjs';

/** Mount before legacy Android catch-all routes. No browser/Odoo-cookie route is
 * exposed here. Every runtime method verifies the enrolled bearer itself. */
export function mountNativeCallRoutes(app, { runtime, prefix = '/api/operator-android',
  scheduleRecovery = id => setImmediate(() => { runtime.recoverSession(id).catch(() => {}); }), onTiming = () => {} } = {}) {
  requireValue(app && runtime && prefix === '/api/operator-android', 'CALL_RUNTIME_CONFIG', 'The native call router needs its exact authenticated prefix.', 503);
  const wrap = (name, action) => async (req, res) => {
    const started = performance.now();
    let ok = false, code = '';
    try {
      const body = req.body || {};
      requireValue(body && typeof body === 'object' && !Array.isArray(body) && JSON.stringify(body).length <= 24000,
        'INVALID_INPUT', 'The call action body is invalid or too large.', 400);
      const result = await action(req, body);
      res.set?.('Cache-Control', 'no-store');
      res.set?.('Server-Timing', `sh-call;dur=${(performance.now() - started).toFixed(1)}`);
      res.status(200).json({ ok: true, ...result });
      ok = true;
      if (req.method === 'POST' && result.call?.sessionId) scheduleRecovery(result.call.sessionId);
    } catch (error) {
      if (error instanceof MediaError && typeof error.sessionId === 'string') scheduleRecovery(error.sessionId);
      const known = error instanceof MediaError;
      code = known ? error.code : 'CALL_SERVICE_UNAVAILABLE';
      res.set?.('Cache-Control', 'no-store');
      res.status(known ? error.statusCode : 503).json({ ok: false,
        code: known ? error.code : 'CALL_SERVICE_UNAVAILABLE',
        error: known ? error.message : 'The call service is temporarily unavailable.',
        ...(known && error.sessionId ? { sessionId: error.sessionId } : {}) });
    } finally {
      // No bearer, SDP, token, customer/device identity or request body is logged.
      try { onTiming({ action: name, elapsedMs: Math.round(performance.now() - started), ok, ...(code ? { code } : {}) }); } catch { /* diagnostics cannot affect a call */ }
    }
  };
  app.get(`${prefix}/capabilities`, wrap('capabilities', async req => {
    const capabilities = await runtime.capabilities(req);
    return { capabilities: { ...capabilities, nativeRoomCalls: capabilities.roomCalling } };
  }));
  app.get(`${prefix}/devices`, wrap('devices', req => runtime.availableDevices(req, String(req.query?.callId || ''))));
  app.post(`${prefix}/calls/outgoing`, wrap('outgoing', (req, body) => runtime.outgoing(req, body)));
  app.post(`${prefix}/calls/outgoing/:requestId/cancel`, wrap('outgoing-cancel', (req) => runtime.cancelOutgoing(req, req.params.requestId)));
  app.get(`${prefix}/calls/:callId/status`, wrap('status', req => runtime.status(req, req.params.callId)));
  app.post(`${prefix}/calls/:callId/accept`, wrap('accept', (req, body) => runtime.accept(req, req.params.callId, body)));
  app.post(`${prefix}/calls/:callId/ready`, wrap('ready', (req, body) => runtime.ready(req, req.params.callId, body)));
  app.post(`${prefix}/calls/:callId/reject`, wrap('reject', (req, body) => runtime.end(req, req.params.callId, { ...body, reject: true })));
  app.post(`${prefix}/calls/:callId/end`, wrap('end', (req, body) => runtime.end(req, req.params.callId, body)));
  app.post(`${prefix}/calls/:callId/transfers`, wrap('transfer-invite', (req, body) => runtime.transfer(req, req.params.callId, 'invite', body)));
  for (const action of ['accept', 'ready', 'decline', 'cancel']) app.post(`${prefix}/calls/:callId/transfers/:transferId/${action}`,
    wrap(`transfer-${action}`, (req, body) => runtime.transfer(req, req.params.callId, action, { ...body, transferId: req.params.transferId })));
  return runtime;
}
