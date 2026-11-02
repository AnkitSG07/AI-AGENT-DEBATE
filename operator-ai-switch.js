// Deployment switch for SH Chat automation. Enabling from an old phone, direct
// chat request or delayed Zapier callback cannot bypass this operator decision.
export function createOperatorAiSwitch({ enabled = false } = {}) {
  return (req, res, next) => {
    const path = String(req.path || req.url || '').split('?')[0].replace(/\/$/, '');
    if (!enabled && req.method !== 'GET' &&
        (path === '/api/ai-mode' || path.startsWith('/api/ai-mode/') || path === '/api/zapier/reply')) {
      res.set?.('Cache-Control', 'no-store');
      return res.status(503).json({ ok: false, code: 'AI_DISABLED', aiEnabled: false, mode: 'manual',
        error: 'SH Chat AI is disabled by the administrator. Manual messages and calls remain available.' });
    }
    return next();
  };
}
