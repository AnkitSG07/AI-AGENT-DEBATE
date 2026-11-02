import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperatorAiSwitch } from '../operator-ai-switch.js';

function check(path, { enabled = false, method = 'POST' } = {}) {
  const output = { next: false };
  createOperatorAiSwitch({ enabled })({ path, method }, {
    set() {}, status(status) { output.status = status; return this; }, json(body) { output.body = body; }
  }, () => { output.next = true; });
  return output;
}
test('disabled AI blocks old phone toggles, direct inference and delayed automation replies', () => {
  for (const path of ['/api/ai-mode', '/api/ai-mode/global', '/api/ai-mode/chat', '/api/zapier/reply', '/api/zapier/reply/']) {
    const result = check(path); assert.equal(result.next, false); assert.equal(result.status, 503);
    assert.equal(result.body.code, 'AI_DISABLED'); assert.equal(result.body.aiEnabled, false);
  }
});
test('disabled AI leaves calls, transfers, messages, notifications and mode reads available', () => {
  for (const path of ['/api/operator-android/calls/outgoing', '/api/operator-android/calls/exact/accept',
    '/api/operator-android/calls/exact/end', '/api/operator-android/calls/exact/transfers',
    '/api/operator-android/devices/token', '/api/odoo/chat/send']) assert.equal(check(path).next, true);
  assert.equal(check('/api/ai-mode', { method: 'GET' }).next, true);
});
test('explicit deployment enablement restores the existing authenticated AI handlers', () => {
  assert.equal(check('/api/ai-mode/chat', { enabled: true }).next, true);
});
