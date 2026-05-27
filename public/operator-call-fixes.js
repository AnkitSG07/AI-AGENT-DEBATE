// Intentionally disabled.
// The operator call screen must be controlled only by public/operator-notifications.html.
// Previous versions of this file patched fetch(), call buttons, timers, DOM class changes,
// and history rendering. Those patches interfered with incoming/outgoing WebRTC call flow.
// Keep this file as a no-op while the backend wrapper handles only backend concerns:
// Odoo call persistence, contact lookup, outgoing API route, and webhook filtering.
