import { MediaError, requireValue } from '../media/errors.mjs';

/** Mount before legacy Android catch-all routes. No browser/Odoo-cookie route is
 * exposed here. Every runtime method verifies the enrolled bearer itself. */
export function mountNativeCallRoutes(app, { runtime, prefix = '/api/operator-android',
  scheduleRecovery = id => setImmediate(() => { runtime.recoverSession(id).catch(() => {}); }) } = {}) {
  requireValue(app && runtime && prefix === '/api/operator-android', 'CALL_RUNTIME_CONFIG', 'The native call router needs its exact authenticated prefix.', 503);
  const wrap = action => async (req, res) => {
    try {
      const body = req.body || {};
      requireValue(body && typeof body === 'object' && !Array.isArray(body) && JSON.stringify(body).length <= 24000,
        'INVALID_INPUT', 'The call action body is invalid or too large.', 400);
      const result = await action(req, body);
      res.set?.('Cache-Control', 'no-store');
      res.status(200).json({ ok: true, ...result });
      if (req.method === 'POST' && result.call?.sessionId) scheduleRecovery(result.call.sessionId);
    } catch (error) {
      const known = error instanceof MediaError;
      res.set?.('Cache-Control', 'no-store');
      res.status(known ? error.statusCode : 503).json({ ok: false,
        code: known ? error.code : 'CALL_SERVICE_UNAVAILABLE',
        error: known ? error.message : 'The call service is temporarily unavailable.',
        ...(known && error.sessionId ? { sessionId: error.sessionId } : {}) });
    }
  };
  app.get(`${prefix}/capabilities`, wrap(async req => {
    const capabilities = await runtime.capabilities(req);
    return { capabilities: { ...capabilities, nativeRoomCalls: capabilities.roomCalling } };
  }));
  app.get(`${prefix}/devices`, wrap(req => runtime.availableDevices(req, String(req.query?.callId || ''))));
  app.post(`${prefix}/calls/outgoing`, wrap((req, body) => runtime.outgoing(req, body)));
  app.post(`${prefix}/calls/outgoing/:requestId/cancel`, wrap((req) => runtime.cancelOutgoing(req, req.params.requestId)));
  app.get(`${prefix}/calls/:callId/status`, wrap(req => runtime.status(req, req.params.callId)));
  app.post(`${prefix}/calls/:callId/accept`, wrap((req, body) => runtime.accept(req, req.params.callId, body)));
  app.post(`${prefix}/calls/:callId/ready`, wrap((req, body) => runtime.ready(req, req.params.callId, body)));
  app.post(`${prefix}/calls/:callId/reject`, wrap((req, body) => runtime.end(req, req.params.callId, { ...body, reject: true })));
  app.post(`${prefix}/calls/:callId/end`, wrap((req, body) => runtime.end(req, req.params.callId, body)));
  app.post(`${prefix}/calls/:callId/transfers`, wrap((req, body) => runtime.transfer(req, req.params.callId, 'invite', body)));
  for (const action of ['accept', 'ready', 'decline', 'cancel']) app.post(`${prefix}/calls/:callId/transfers/:transferId/${action}`,
    wrap((req, body) => runtime.transfer(req, req.params.callId, action, { ...body, transferId: req.params.transferId })));
  return runtime;
}
