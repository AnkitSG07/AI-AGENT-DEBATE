const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { androidDir, backendDir } = require('./source-paths.cjs');
const { chromium } = require(process.env.SH_PLAYWRIGHT_MODULE || 'playwright');
const publicDir = path.join(backendDir, 'public');
const html = fs.readFileSync(path.join(publicDir, 'operator-notifications.html'), 'utf8');
const helper = fs.readFileSync(path.join(publicDir, 'operator-notifications-auth.js'), 'utf8');
const ORIGIN = 'https://ai-agent-debate.onrender.com';
let browser;
test.before(async () => { browser = await chromium.launch({ executablePath: process.env.SH_TEST_CHROMIUM, headless: true, args: ['--no-sandbox'] }); });
test.after(async () => browser?.close());
async function harness({ signedIn = true, pushStatus = 200, pushResult = { ok: true, unsubscribed: true }, permission = 'granted' } = {}) {
  const context = await browser.newContext(), requests = [], errors = [];
  let session = signedIn;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.isNavigationRequest()) return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (url.pathname === '/operator-notifications-auth.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: helper });
    requests.push({ path: url.pathname, method: request.method(), headers: request.headers(), body: request.postDataJSON() });
    if (url.pathname === '/api/profile-session') return route.fulfill({ status: session ? 200 : 401, json: session ? { ok: true, profile: 'Smart handicrafts', expiresAt: new Date(Date.now() + 7200000).toISOString() } : { ok: false } });
    if (url.pathname === '/api/profile-login') { session = true; return route.fulfill({ json: { ok: true } }); }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: { ok: true, configured: true, publicKey: 'AAAA' } });
    if (url.pathname.startsWith('/api/push/')) return route.fulfill({ status: pushStatus, json: pushResult });
    return route.fulfill({ status: 403, json: { ok: false, error: 'This protected operation belongs in SH Chat.' } });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ permission }) => {
    window.localUnsubscribed = 0; window.permissionRequests = 0;
    const data = { endpoint: 'https://push.example.test/browser-1', keys: { auth: 'AAAAAAAAAAAAAAAAAAAAAA', p256dh: 'B' + 'A'.repeat(86) } };
    const subscription = { endpoint: data.endpoint, toJSON: () => data, unsubscribe: async () => { window.localUnsubscribed++; return true; } };
    const registration = { active: {}, pushManager: { getSubscription: async () => subscription, subscribe: async () => subscription } };
    Object.defineProperty(navigator, 'serviceWorker', { value: { register: async () => registration } });
    Object.defineProperty(window, 'PushManager', { value: function () {} });
    Object.defineProperty(window, 'Notification', { value: { permission, requestPermission: async () => { window.permissionRequests++; return 'granted'; } } });
  }, { permission });
  await page.goto(ORIGIN + '/operator-notifications');
  await page.waitForFunction(() => !!window.SHNotificationsAuth && !!document.getElementById('notificationOperatorLogin'));
  await page.evaluate(async () => { try { await SHNotificationsAuth.requireSession(); } catch {} });
  return { page, requests, errors, close: () => context.close() };
}
test('signed-out notification setup shows its operator login without private call polling', async () => {
  const h = await harness({ signedIn: false });
  try {
    assert.equal(await h.page.locator('#notificationOperatorLogin').isVisible(), true);
    assert.equal(h.requests.some(row => row.path.startsWith('/api/whatsapp-calls/') || row.path.startsWith('/api/operator-devices')), false);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
test('notification permission is not requested before operator authorization', async () => {
  const h = await harness({ signedIn: false, permission: 'default' });
  try {
    await h.page.evaluate(() => enable());
    assert.equal(await h.page.evaluate(() => permissionRequests), 0);
    assert.equal(h.requests.filter(row => row.path === '/api/push/subscribe').length, 0);
    assert.match(await h.page.locator('#status').textContent(), /Sign in/);
  } finally { await h.close(); }
});
test('profile sign-in clears its password and does not send a notification automatically', async () => {
  const h = await harness({ signedIn: false });
  try {
    await h.page.locator('#notificationPassword').fill('local-test-password');
    await h.page.locator('#notificationOperatorLogin button').click();
    await h.page.waitForFunction(() => document.getElementById('notificationOperatorLogin').hidden);
    assert.equal(await h.page.locator('#notificationPassword').inputValue(), '');
    assert.equal(h.requests.some(row => row.path === '/api/push/test' || row.path === '/api/push/test-call'), false);
    assert.equal(await h.page.evaluate(() => Object.values(localStorage).some(value => value.includes('local-test-password'))), false);
  } finally { await h.close(); }
});
test('subscription reset sends ownership proof and waits for the server before removing local delivery', async () => {
  const h = await harness();
  try {
    await h.page.evaluate(() => reset());
    const sent = h.requests.find(row => row.path === '/api/push/unsubscribe');
    assert.equal(sent.headers['x-sh-operator-auth'], '1');
    assert.equal(sent.body.subscription.endpoint, sent.body.endpoint);
    assert.ok(sent.body.subscription.keys.auth && sent.body.subscription.keys.p256dh);
    assert.equal(await h.page.evaluate(() => localUnsubscribed), 1);
  } finally { await h.close(); }
});
test('failed unsubscribe preserves the local subscription and reports failure', async () => {
  const h = await harness({ pushStatus: 503, pushResult: { ok: false, error: 'Retry later' } });
  try {
    await h.page.evaluate(() => reset());
    assert.equal(await h.page.evaluate(() => localUnsubscribed), 0);
    assert.match(await h.page.locator('#status').textContent(), /Retry later/);
  } finally { await h.close(); }
});
test('test controls never replay a rejected POST or claim notification delivery', async () => {
  const h = await harness({ pushStatus: 401, pushResult: { ok: false } });
  try {
    await h.page.evaluate(() => testCall());
    assert.equal(h.requests.filter(row => row.path === '/api/push/test-call').length, 1);
    assert.equal(await h.page.locator('#notificationOperatorLogin').isVisible(), true);
    assert.doesNotMatch(await h.page.locator('#status').textContent(), /sent|accepted/i);
  } finally { await h.close(); }
});
test('accepted notification tests still ask the operator to verify the receiving device', async () => {
  const h = await harness();
  try {
    await h.page.evaluate(() => testChat());
    assert.match(await h.page.locator('#status').textContent(), /accepted.*verify delivery/i);
    assert.doesNotMatch(await h.page.locator('#status').textContent(), /notification sent/i);
  } finally { await h.close(); }
});
test('notification helper rejects cross-origin and call-control paths before the network', async () => {
  const h = await harness();
  try {
    const before = h.requests.length;
    const results = await h.page.evaluate(async () => {
      const results = [];
      for (const url of ['https://other.example/api/push/test', '/api/whatsapp-calls/accept', '/api/push/test-call?token=secret']) {
        try { await SHNotificationsAuth.fetch(url, { method: 'POST' }); results.push('bad'); } catch { results.push('denied'); }
      }
      return results;
    });
    assert.deepEqual(results, ['denied', 'denied', 'denied']);
    assert.equal(h.requests.length, before);
  } finally { await h.close(); }
});
test('server error text cannot inject markup into the notification status', async () => {
  const h = await harness({ pushStatus: 503, pushResult: { ok: false, error: '<img src=x onerror="window.injected=true">' } });
  try {
    await h.page.evaluate(() => testChat());
    assert.equal(await h.page.locator('#status img').count(), 0);
    assert.match(await h.page.locator('#status').textContent(), /<img/);
    assert.equal(await h.page.evaluate(() => !!window.injected), false);
  } finally { await h.close(); }
});
test('enable does not report a successful registration after a malformed HTTP 200 acknowledgement', async () => {
  const h = await harness({ pushResult: {} });
  try {
    await h.page.locator('#operatorName').fill('Test operator');
    await h.page.locator('#deviceLabel').fill('Offline browser');
    assert.equal(await h.page.evaluate(() => enable()), false);
    assert.match(await h.page.locator('#status').textContent(), /Could not save subscription/);
    assert.doesNotMatch(await h.page.locator('#status').textContent(), /Notifications enabled/);
  } finally { await h.close(); }
});
