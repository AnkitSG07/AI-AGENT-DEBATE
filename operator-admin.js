// Administration uses the existing signed SUDO profile session. A public native
// bearer cannot issue enrollment invitations or inspect another device token.
export function registerOperatorAdminRoutes(app, { firestoreRuntime, mediaGateway,
  authorize, env = process.env, now = Date.now } = {}) {
  const prefix = '/api/operator-android/admin';
  const origin = new URL(env.APP_URL || 'https://ai-agent-debate.onrender.com').origin;
  const registry = firestoreRuntime?.deviceRegistry;
  const rates = new Map();
  const failure = (status, message) => Object.assign(new Error(message), { status, safe: true });
  const route = handler => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (typeof authorize !== 'function' || !authorize(req)) throw failure(401, 'Sign in with the SUDO administrator profile.');
      if (typeof env.PROFILE_SESSION_SECRET !== 'string' || env.PROFILE_SESSION_SECRET.trim().length < 32 ||
          typeof env.PROFILE_PASS_SUDO !== 'string' || !env.PROFILE_PASS_SUDO.trim())
        throw failure(503, 'A strong explicit profile-session secret and SUDO password are required for device administration.');
      if (!registry || !firestoreRuntime.configured) throw failure(503, 'Persistent device storage is not configured.');
      if (req.method !== 'GET') {
        if (req.headers.origin !== origin || req.headers['x-sh-admin-action'] !== '1') throw failure(403, 'Open this action from the device-management page.');
        const key = req.ip || req.socket?.remoteAddress || 'admin', entry = rates.get(key);
        const rate = entry && entry.until > now() ? entry : { count: 0, until: now() + 60000 };
        rate.count++; rates.set(key, rate);
        if (rate.count > 12) throw failure(429, 'Please wait before another administration action.');
        for (const [id, item] of rates) if (item.until < now()) rates.delete(id);
      }
      res.json({ ok: true, ...await handler(req) });
    } catch (error) {
      const status = error.safe || error.registryError ? Number(error.status) || 503 : 503;
      res.status(status).json({ ok: false, error: error.safe || error.registryError && status < 500 ? error.message : 'The administration service is temporarily unavailable.' });
    }
  };
  app.get('/operator-admin', (req, res) => res.redirect(302, '/operator-admin.html'));
  app.get(`${prefix}/status`, route(async () => ({
    storage: firestoreRuntime.backend, storageAvailable: await registry.checkAvailability(),
    metaSignatureConfigured: mediaGateway.appSecretConfigured,
    nativeCallingRequested: env.SH_NATIVE_CALLS_ENABLED === 'true',
    transferPilotRequested: env.SH_NATIVE_TRANSFER_PILOT_ENABLED === 'true',
    pilotDeviceIds: String(env.SH_NATIVE_PILOT_DEVICE_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
    devices: (await registry.listDevices()).map(row => ({ id: row.id, label: row.deviceLabel,
      createdAt: row.createdAt, expiresAt: row.tokenExpiresAt, revoked: !!row.revokedAt,
      receiveCalls: row.receiveCalls !== false, receiveChats: row.receiveChats !== false,
      nativeBuild: row.nativeBuild || 0, mediaProtocol: row.mediaProtocol || '' }))
  })));
  app.post(`${prefix}/verify`, route(async () => {
    const at = now(), ref = firestoreRuntime.firestore.collection(`${firestoreRuntime.collectionPrefix}_metadata`).doc('setup_probe');
    await ref.set({ schema: 1, checkedAt: at, kind: 'administrator_storage_verification' });
    const stored = await ref.get();
    const storageWritable = stored.exists && stored.data().checkedAt === at;
    let mediaControlReachable = false;
    try { mediaControlReachable = (await mediaGateway.verifyConfiguration()).controlApiReachable === true; } catch { /* no provider error/credential details */ }
    return { storageWritable, mediaControlReachable, metaSignatureConfigured: mediaGateway.appSecretConfigured,
      liveAudioVerified: false, checkedAt: at };
  }));
  app.post(`${prefix}/enrollment`, route(async req => {
    const label = req.body?.label;
    if (typeof label !== 'string' || !label.trim() || label.length > 120 || /[\u0000-\u001f\u007f]/.test(label))
      throw failure(400, 'Enter a short name for the phone.');
    return registry.issueEnrollment({ label: label.trim(), expiresInMs: 60 * 60000 });
  }));
  app.post(`${prefix}/devices/:deviceId/revoke`, route(async req => {
    if (req.body?.confirmDeviceId !== req.params.deviceId) throw failure(400, 'Confirm the exact registered device.');
    return registry.revokeDevice(req.params.deviceId);
  }));
}
