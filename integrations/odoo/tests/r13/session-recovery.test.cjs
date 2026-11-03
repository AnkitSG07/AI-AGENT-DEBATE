'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { context, deferred } = require('./production-functions.cjs');
const response = (status, body, url = 'https://www.smarthandicrafts.com/mail/attachment/upload') => ({status, ok: status < 400, url, text: async () => body});
function fixture(replies) {
  const attempts = []; let refreshed = 0, redirected = 0;
  const c = context(['looksLikeSessionError', 'looksLikeCsrfError', 'uploadAttachmentToCurrentThread'], {
    state: {selectedChannel: {id: 73}}, FormData,
    getOdooCsrfToken: () => 'old-token',
    refreshOdooCsrfToken: async () => { refreshed++; return 'new-token'; },
    redirectToOdooLogin: () => { redirected++; },
    appFetch: async (path, options) => { attempts.push({path, token: options.body.get('csrf_token'), thread: options.body.get('thread_id')}); const next = replies.shift(); if (next instanceof Error) throw next; return next; }
  });
  return {c, attempts, get refreshed() { return refreshed; }, get redirected() { return redirected; }};
}
test('explicit expired CSRF rejection refreshes once and retries the same attachment and conversation', async () => {
  const f = fixture([response(400, '<h1>Session expired (invalid CSRF token)</h1>'), response(200, '{"attachment_id":9}')]);
  assert.equal(await f.c.uploadAttachmentToCurrentThread(new Blob(['test'])), 9);
  assert.deepEqual(f.attempts.map(x => x.token), ['old-token', 'new-token']);
  assert.deepEqual(f.attempts.map(x => x.thread), ['73', '73']); assert.equal(f.refreshed, 1); assert.equal(f.redirected, 0);
});
test('ambiguous timeout and server errors never duplicate an upload', async () => {
  for (const reply of [new Error('timeout'), response(500, 'unavailable')]) {
    const f = fixture([reply]); await assert.rejects(f.c.uploadAttachmentToCurrentThread(new Blob(['test'])));
    assert.equal(f.attempts.length, 1); assert.equal(f.refreshed, 0);
  }
});
test('a permission denial is not a session expiry and repeated CSRF errors do not loop', async () => {
  const f = fixture([response(403, '{"error":"Access denied"}')]);
  await assert.rejects(f.c.uploadAttachmentToCurrentThread(new Blob(['test'])), /Access denied/);
  assert.equal(f.redirected, 0);
  const g = fixture([response(400, 'invalid CSRF token'), response(400, 'invalid CSRF token')]);
  await assert.rejects(g.c.uploadAttachmentToCurrentThread(new Blob(['test'])), /refreshed upload token/);
  assert.equal(g.attempts.length, 2); assert.equal(g.refreshed, 1);
});
test('real session expiry asks for sign-in without replaying a message', async () => {
  let redirects = 0, requests = 0;
  const c = context(['jsonRpc', 'looksLikeSessionError', 'looksLikeCsrfError'], {
    appFetch: async () => { requests++; return response(200, '{"error":{"data":{"name":"odoo.http.SessionExpiredException","message":"Session expired"}}}'); },
    redirectToOdooLogin: () => { redirects++; }
  });
  await assert.rejects(c.jsonRpc('/web/dataset/call_kw/mail.message/create', {}));
  assert.equal(requests, 1); assert.equal(redirects, 1);
});
test('concurrent expired uploads share one session and token refresh', async () => {
  const gate = deferred(); let checks = 0, fetches = 0;
  const token = 'fresh-token-with-30-characters000';
  const c = context(['refreshOdooCsrfToken'], {
    state: {session: {uid: 7}}, window: {location: {pathname: '/livechat-api-test'}},
    jsonRpc: async () => { checks++; await gate.promise; return {uid: 7}; },
    appFetch: async () => { fetches++; return response(200, '<page>'); },
    DOMParser: class { parseFromString() { return {querySelector: () => ({value: token})}; } },
    redirectToOdooLogin() { assert.fail('should not redirect a valid session'); }
  });
  const a = c.refreshOdooCsrfToken(), b = c.refreshOdooCsrfToken(); gate.resolve();
  assert.deepEqual(await Promise.all([a, b]), [token, token]); assert.equal(checks, 1); assert.equal(fetches, 1);
});
