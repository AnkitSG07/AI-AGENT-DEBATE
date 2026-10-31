// Actual HTTP requests through complete server.js, plus focused cryptographic
// and lifecycle boundary tests. Never contacts a customer or production service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, hkdfSync } from 'node:crypto';
import { createOperatorDocumentLinks, safeDocumentRedirect } from '../operator-document-links.js';
import { createOperatorBrowserAuth } from '../operator-browser-auth.js';
import { createOperatorAiReplyAuth } from '../operator-ai-reply-auth.js';
import { FirestoreFake } from './operator-r12-helpers.mjs';

const SECRET = 'synthetic-r13-profile-secret-abcdefghijklmnopqrstuvwxyz-1234';
const BACKEND = 'https://ai-agent-debate.onrender.com', HUB = 'https://www.smarthandicrafts.com';
const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');

async function startFixture({ weakSecret = false, callbacks = false, zapier = {} } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'sh-private-r13-'));
  const env = { PATH: process.env.PATH, NODE_ENV: 'test', PORT: '0',
    PROFILE_SESSION_SECRET: weakSecret ? '' : SECRET, PROFILE_PASS_SMART_HANDICRAFTS: 'fixture-profile-password',
    PROFILE_PASS_SUDO: 'fixture-admin-password', PROFILE_PASS_ACCOUNTS: 'fixture-finance-password',
    ODOO_URL: 'https://odoo.fixture.invalid', ODOO_DB: 'fixture-db', ODOO_USERNAME: 'fixture-user', ODOO_API_KEY_OR_PASSWORD: 'fixture-only',
    ZOHO_MAIL_CLIENT_ID: 'fixture', ZOHO_MAIL_CLIENT_SECRET: 'fixture', ZOHO_MAIL_REFRESH_TOKEN: 'fixture',
    ZOHO_MAIL_ACCOUNT_ID: 'fixture-account', ZOHO_MAIL_ACCOUNT_EMAIL: 'care@example.invalid',
    ZOHO_MAIL_API_BASE: 'https://mail.zoho.fixture.invalid', ZOHO_MAIL_ACCOUNTS_BASE: 'https://accounts.zoho.fixture.invalid',
    ZOHO_MAIL_REDIRECT_URI: BACKEND + '/zoho/callback', GOOGLE_CONTACTS_CLIENT_ID: 'fixture',
    GOOGLE_CONTACTS_CLIENT_SECRET: 'fixture', GOOGLE_CONTACTS_REFRESH_TOKEN: 'fixture',
    GOOGLE_CONTACTS_REDIRECT_URI: BACKEND + '/google-contacts/callback', AI_MODE_BACKGROUND_WORKER_ENABLED: 'false',
    SH_ANDROID_REGISTRY_BACKEND: 'file', SH_ANDROID_DEVICES_PATH: join(cwd, 'devices.json'),
    ZAPIER_REPLY_SECRET: zapier.replySecret ?? 'fixture-zapier-secret',
    ZAPIER_INCOMING_WHATSAPP_ENABLED: zapier.enabled === false ? 'false' : 'true',
    ZAPIER_INCOMING_WHATSAPP_WEBHOOK_URL: zapier.legacyAlias ? '' : (zapier.url ?? 'https://zapier.fixture.invalid/incoming'),
    ZAPIER_WEBHOOK_URL: zapier.legacyAlias ? (zapier.url ?? 'https://zapier.fixture.invalid/incoming') : '',
    ODOO_WEBHOOK_SECRET: callbacks ? 'fixture-odoo-secret' : '',
    META_WHATSAPP_APP_SECRET: callbacks ? 'fixture-meta-app-secret' : '', ODOO_WHATSAPP_WEBHOOK_FORWARD_ENABLED: 'false' };
  const child = fork(fileURLToPath(new URL('./fixtures/operator-private-server.mjs', import.meta.url)), [],
    { cwd, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '', sequence = 0;
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Actual server fixture did not start: ' + output.slice(-2000))), 12000);
    child.on('message', message => {
      if (message.type === 'ready') { clearTimeout(timeout); resolve(message.port); }
      if (pending.has(message.id)) { const done = pending.get(message.id); pending.delete(message.id); done(message); }
    });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Actual server fixture exited ${code}: ${output.slice(-2000)}`)); });
  });
  let port;
  try { port = await ready; } catch (error) { child.kill('SIGKILL'); await rm(cwd, { recursive: true, force: true }); throw error; }
  const base = `http://127.0.0.1:${port}`;
  async function request(path, { method = 'GET', body, token, cookie, origin = HUB, headers = {} } = {}) {
    const response = await fetch(base + path, { method, redirect: 'manual', signal: AbortSignal.timeout(8000), headers: {
      ...(origin ? { Origin: origin } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers
    }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await response.text(); let data;
    try { data = JSON.parse(text); } catch {}
    return { status: response.status, headers: response.headers, text, data };
  }
  async function login(profile = 'Smart handicrafts') {
    const password = profile === 'SUDO' ? 'fixture-admin-password' : profile === 'Accounts' ? 'fixture-finance-password' : 'fixture-profile-password';
    const r = await request('/api/profile-login', { method: 'POST', body: { profile, password }, origin: BACKEND });
    assert.equal(r.status, 200); return r.headers.get('set-cookie').split(';')[0];
  }
  async function grant(cookie) {
    const r = await request('/api/operator-browser-auth/token', { method: 'POST', cookie, origin: BACKEND,
      headers: { 'X-SH-Operator-Auth': '1' }, body: { origin: HUB } });
    assert.equal(r.status, 200, r.text); return r.data.token;
  }
  const control = (type, value) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Fixture ${type} acknowledgement timed out.`)); }, 8000);
    pending.set(id, response => { clearTimeout(timer); resolve(response); });
    child.send({ type, value, id }, error => {
      if (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  });
  async function toggle(token, enabled) {
    const current = await request('/api/ai-mode', { token });
    assert.equal(current.status, 200, current.text);
    return request('/api/ai-mode', { method: 'POST', token, body: {
      aiEnabled: enabled, expectedEpoch: current.data.epoch, expectedRevision: current.data.revision
    } });
  }
  const close = async () => {
    child.kill('SIGTERM');
    await new Promise(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2500); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    await rm(cwd, { recursive: true, force: true });
  };
  return { request, login, grant, toggle, scenario: value => control('scenario', value), calls: async () => (await control('calls')).calls, close, output: () => output };
}

test('complete actual server denies all anonymous private integration and alternate ERP routes before provider effects', async t => {
  const f = await startFixture(); t.after(f.close);
  const routes = [
    ['GET','/api/zoho-mail/status'], ['GET','/api/zoho-mail/account'], ['GET','/api/zoho-mail/folders'],
    ['GET','/api/zoho-mail/messages'], ['GET','/api/zoho-mail/message/m1'], ['POST','/api/zoho-mail/send'], ['POST','/api/zoho-mail/reply'],
    ['GET','/api/google-contacts/status'], ['GET','/api/google-contacts/search'], ['POST','/api/google-contacts/import-to-odoo'],
    ['GET','/api/odoo-documents/tree'], ['GET','/api/odoo-documents/folder/root'], ['GET','/api/odoo-documents/file/41'],
    ['GET','/api/odoo-documents/view/41'], ['GET','/api/odoo-documents/download/41'], ['POST','/api/odoo-documents/share'],
    ['GET','/api/ai-mode'], ['POST','/api/ai-mode'], ['GET','/api/ai-mode/global'], ['POST','/api/ai-mode/global'],
    ['GET','/api/ai-mode/status'], ['POST','/api/ai-mode/chat'], ['GET','/api/debug/webhooks/recent'], ['POST','/api/debug/webhooks/clear'],
    ['POST','/api/odoo/query'], ['POST','/api/odoo/action'], ['GET','/api/odoo/invoices'], ['GET','/api/labels'],
    ['GET','/api/self-training'], ['GET','/api/product-bot/self-training'], ['GET','/zoho/auth'], ['GET','/google-contacts/auth'],
    ['GET','/zoho/callback?code=fixture&state=fixture'], ['GET','/google-contacts/callback?code=fixture&state=fixture']
  ];
  await f.scenario({});
  for (const [method, path] of routes) {
    const r = await f.request(path, { method, body: method === 'POST' ? { model: 'res.partner', text: 'fixture' } : undefined });
    assert.equal(r.status, 401, `${method} ${path}: ${r.text}`);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await f.calls()).length, 0, 'Unauthorized routes must not contact any private provider');
});

test('actual server capability supports real mail route execution, Google browse, selected import and signed document metadata', async t => {
  const f = await startFixture(); t.after(f.close);
  const token = await f.grant(await f.login()); await f.scenario({});
  for (const path of ['/api/zoho-mail/status','/api/zoho-mail/account','/api/zoho-mail/folders','/api/zoho-mail/messages','/api/zoho-mail/message/m1',
    '/api/google-contacts/status','/api/google-contacts/search?q=Fixture','/api/odoo-documents/tree','/api/odoo-documents/folder/root','/api/odoo-documents/file/41']) {
    const r = await f.request(path, { token }); assert.equal(r.status, 200, path + ': ' + r.text); assert.equal(r.data.ok, true);
  }
  const browseCalls = await f.calls();
  assert.equal(browseCalls.filter(x => x.odoo?.model === 'res.partner' && ['create','write'].includes(x.odoo.operation)).length, 0);
  const imported = await f.request('/api/google-contacts/import-to-odoo', { method: 'POST', token,
    body: { contact: { name: 'Fixture contact', email: 'fixture@example.invalid', phone: '+919000000001' } } });
  assert.equal(imported.status, 200, imported.text);
  assert.equal((await f.calls()).filter(x => x.odoo?.model === 'res.partner' && x.odoo.operation === 'create').length, 1);
  for (const [path, body] of [['/api/zoho-mail/send', { toAddress: 'fixture@example.invalid', subject: 'Fixture only', content: 'Fixture body' }],
    ['/api/zoho-mail/reply', { messageId: 'm1', toAddress: 'fixture@example.invalid', subject: 'Re: Fixture', content: 'Fixture reply' }]]) {
    const r = await f.request(path, { method: 'POST', token, body }); assert.equal(r.status, 200, r.text);
  }
  const document = (await f.request('/api/odoo-documents/file/41', { token })).data.document;
  assert.match(document.view_url, /view\/41\?share=shd1\./); assert.match(document.download_url, /download\/41\?share=shd1\./);
  assert.ok(document.link_expires_at); assert.equal(document.access_token, undefined);
});

test('actual mail mutation is never replayed after provider 401 or lost response', async t => {
  const f = await startFixture(); t.after(f.close); const token = await f.grant(await f.login());
  for (const scenario of [{ mail401: true }, { mailLostResponse: true }]) {
    await f.scenario(scenario);
    const r = await f.request('/api/zoho-mail/send', { method: 'POST', token,
      body: { toAddress: 'fixture@example.invalid', subject: 'Fixture', content: 'Fixture' } });
    assert.equal(r.status, 500);
    assert.equal((await f.calls()).filter(x => x.host === 'mail.zoho.fixture.invalid' && x.method === 'POST').length, 1);
  }
});

test('actual document recipient links enforce exact record/action and strip unsafe active content authority', async t => {
  const f = await startFixture(); t.after(f.close); const token = await f.grant(await f.login());
  const doc = (await f.request('/api/odoo-documents/file/41', { token })).data.document;
  const view = new URL(doc.view_url), download = new URL(doc.download_url);
  const r = await f.request(view.pathname + view.search, { origin: null });
  assert.equal(r.status, 200); assert.match(r.text, /^%PDF/); assert.match(r.headers.get('content-security-policy'), /^sandbox;/);
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await f.request(download.pathname + download.search, { origin: null })).status, 200);
  for (const path of [view.pathname.replace('/41','/42') + view.search, download.pathname + view.search,
    view.pathname + view.search + '&share=wrong', '/api/odoo-documents/tree' + view.search])
    assert.ok([401,403].includes((await f.request(path, { origin: null })).status), path);
});

test('actual URL documents remain behind signed links and download query preserves URL fragments', async t => {
  const f = await startFixture(); t.after(f.close); const token = await f.grant(await f.login());
  await f.scenario({ documentUrl: 'https://fixture.example.invalid/document?existing=1#section' });
  const doc = (await f.request('/api/odoo-documents/file/41', { token })).data.document;
  assert.match(doc.view_url, /^https:\/\/ai-agent-debate\.onrender\.com\/api\/odoo-documents\/view\/41\?share=/);
  const view = new URL(doc.view_url), download = new URL(doc.download_url);
  const opened = await f.request(view.pathname + view.search, { origin: null });
  assert.equal(opened.status, 302); assert.equal(opened.headers.get('location'), 'https://fixture.example.invalid/document?existing=1#section');
  const downloaded = await f.request(download.pathname + download.search, { origin: null });
  const redirect = new URL(downloaded.headers.get('location'));
  assert.equal(redirect.searchParams.get('download'), 'true'); assert.equal(redirect.hash, '#section');
  await f.scenario({ documentUrl: 'javascript:alert(1)' });
  const rejected = await f.request(view.pathname + view.search, { origin: null });
  assert.equal(rejected.status, 502); assert.match(rejected.headers.get('content-type'), /^text\/plain/);
  assert.ok(!rejected.text.includes('javascript:'));
});

test('actual signed document access rejects attachment bytes from a different record', async t => {
  const f = await startFixture(); t.after(f.close); const token = await f.grant(await f.login());
  const doc = (await f.request('/api/odoo-documents/file/41', { token })).data.document;
  await f.scenario({ attachmentWrongId: true });
  for (const link of [doc.view_url, doc.download_url]) {
    const url = new URL(link);
    const response = await f.request(url.pathname + url.search, { origin: null });
    assert.equal(response.status, 502, response.text);
    assert.ok(!response.text.includes('wrong-attachment-72'));
    assert.equal(response.headers.get('location'), null, 'An identity mismatch must not become an unverified fallback redirect.');
  }
});

test('actual direct document binary fallback preserves the exact signed document identity', async t => {
  const f = await startFixture(); t.after(f.close); const token = await f.grant(await f.login());
  const doc = (await f.request('/api/odoo-documents/file/41', { token })).data.document;
  for (const link of [doc.view_url, doc.download_url]) {
    const url = new URL(link);
    await f.scenario({ directDocumentBinary: true, documentBinaryWrongId: true });
    const wrong = await f.request(url.pathname + url.search, { origin: null });
    assert.equal(wrong.status, 502, wrong.text);
    assert.ok(!wrong.text.includes('wrong-document-42'));
    await f.scenario({ directDocumentBinary: true });
    const exact = await f.request(url.pathname + url.search, { origin: null });
    assert.equal(exact.status, 200, exact.text);
    assert.equal(exact.text, '%PDF-1.4 fixture direct document');
  }
});

test('actual document share rejects closed or expired WhatsApp and preserves Live Chat comment type', async t => {
  const f = await startFixture(); t.after(f.close); const token = await f.grant(await f.login());
  const body = { documentId: 41, channel: 'chat', channelId: 22, link: 'https://attacker.invalid/wrong', message: 'Fixture document' };
  await f.scenario({ closedWindow: true });
  const closed = await f.request('/api/odoo-documents/share', { method: 'POST', token, body });
  assert.equal(closed.status, 500); assert.match(closed.data.error, /reply window is closed/);
  assert.equal((await f.calls()).filter(x => x.odoo?.operation === 'message_post').length, 0);
  await f.scenario({ livechat: true });
  const open = await f.request('/api/odoo-documents/share', { method: 'POST', token, body });
  assert.equal(open.status, 200, open.text); assert.match(open.data.link, /\/view\/41\?share=shd1\./); assert.ok(!open.data.link.includes('attacker'));
  assert.equal((await f.calls()).filter(x => x.odoo?.operation === 'message_post')[0].odoo.kw.message_type, 'comment');
  await f.scenario({});
  const whatsapp = await f.request('/api/odoo-documents/share', { method: 'POST', token, body: { ...body, message: 'Fixture WhatsApp certificate share' } });
  assert.equal(whatsapp.status, 200, whatsapp.text);
  assert.equal((await f.calls()).filter(x => x.odoo?.operation === 'message_post')[0].odoo.kw.message_type, 'whatsapp_message');
});

test('actual document share rejects mismatched channel identity and an ambiguous message acknowledgement', async t => {
  const f = await startFixture(); t.after(f.close); const token = await f.grant(await f.login());
  const body = { documentId: 41, channel: 'chat', channelId: 22, message: 'Fixture verified certificate' };
  await f.scenario({ channelWrongId: true });
  const wrong = await f.request('/api/odoo-documents/share', { method: 'POST', token, body });
  assert.equal(wrong.status, 500); assert.match(wrong.data.error, /confirm.*channel/i);
  assert.equal((await f.calls()).filter(x => x.odoo?.operation === 'message_post').length, 0);
  await f.scenario({ messagePostResult: null });
  const unknown = await f.request('/api/odoo-documents/share', { method: 'POST', token, body });
  assert.equal(unknown.status, 500); assert.match(unknown.data.error, /confirm.*message/i);
  assert.equal((await f.calls()).filter(x => x.odoo?.operation === 'message_post').length, 1);
});

test('actual ERP routes require signed profile, overwrite claimed roles, and refuse cross-origin/simple writes', async t => {
  const f = await startFixture(); t.after(f.close); const cookie = await f.login('Accounts'), token = await f.grant(await f.login());
  const body = { model: 'res.partner', role: 'admin' };
  for (const options of [{ token }, { cookie }, { cookie, origin: 'https://attacker.invalid' },
    { cookie, origin: BACKEND, headers: { 'Content-Type': 'text/plain' } }])
    assert.equal((await f.request('/api/odoo/query', { method: 'POST', body, ...options })).status, 403);
  const ok = await f.request('/api/odoo/query', { method: 'POST', cookie, origin: BACKEND, body }); assert.equal(ok.status, 200, ok.text);
  const deniedRole = await f.request('/api/odoo/read/hr?role=admin&includeHr=true', { cookie, origin: BACKEND });
  assert.equal(deniedRole.status, 403); assert.match(deniedRole.text, /finance/);
});

test('actual AI endpoints reject malformed writes, expose revisions, and prevent stale-device overwrite', async t => {
  const f = await startFixture(); t.after(f.close); const token = await f.grant(await f.login());
  const original = (await f.request('/api/ai-mode', { token })).data;
  assert.equal(original.mode, 'manual'); assert.equal(original.revision, 0); assert.equal(typeof original.epoch, 'string');
  for (const body of [{}, { aiEnabled: 'perhaps' }, { mode: 'arbitrary' }, { aiEnabled: true, mode: 'manual' },
    { aiEnabled: true, enabled: false }, { expectedRevision: 0, aiEnabled: true }])
    assert.equal((await f.request('/api/ai-mode', { method: 'POST', token, body })).status, 400);
  const enabled = await f.request('/api/ai-mode', { method: 'POST', token,
    body: { aiEnabled: true, expectedEpoch: original.epoch, expectedRevision: original.revision, updatedBy: 'forged-name' } });
  assert.equal(enabled.status, 200); assert.equal(enabled.data.mode, 'zapier'); assert.equal(enabled.data.revision, 1);
  assert.match(enabled.data.global.updated_by, /^web_/);
  const stale = await f.request('/api/ai-mode', { method: 'POST', token,
    body: { aiEnabled: false, expectedEpoch: original.epoch, expectedRevision: 0 } });
  assert.equal(stale.status, 409); assert.equal(stale.data.code, 'AI_MODE_CHANGED'); assert.equal(stale.data.mode, 'zapier');
  const secondDevice = (await f.request('/api/ai-mode', { token })).data;
  assert.equal(secondDevice.revision, 1); assert.equal(secondDevice.epoch, original.epoch);
  const manual = await f.request('/api/ai-mode/global', { method: 'POST', token,
    body: { mode: 'manual', expectedEpoch: secondDevice.epoch, expectedRevision: 1 } });
  assert.equal(manual.status, 200); assert.equal(manual.data.revision, 2);
});

test('actual AI mode writes cannot omit arbitration or reuse a state after server/session changes', async t => {
  const f = await startFixture(); t.after(f.close); const token = await f.grant(await f.login());
  const original = (await f.request('/api/ai-mode', { token })).data;
  assert.equal((await f.toggle(token, true)).status, 200);
  for (const path of ['/api/ai-mode', '/api/ai-mode/global']) {
    for (const body of [{ mode: 'manual' }, { aiEnabled: false },
      { mode: 'manual', expectedRevision: -1, expectedEpoch: original.epoch },
      { mode: 'manual', expectedRevision: 1, expectedEpoch: '' }]) {
      const rejected = await f.request(path, { method: 'POST', token, body });
      assert.equal(rejected.status, 400, path + ': ' + rejected.text);
      assert.equal(rejected.data.code, 'INVALID_AI_REVISION');
    }
    for (const body of [
      { mode: 'manual', expectedRevision: 0, expectedEpoch: original.epoch },
      { mode: 'manual', expectedRevision: 1, expectedEpoch: 'previous-server-epoch' }]) {
      const rejected = await f.request(path, { method: 'POST', token, body });
      assert.equal(rejected.status, 409, path + ': ' + rejected.text);
      assert.equal(rejected.data.code, 'AI_MODE_CHANGED');
    }
    const unchanged = (await f.request('/api/ai-mode', { token })).data;
    assert.equal(unchanged.mode, 'zapier'); assert.equal(unchanged.revision, 1);
  }
  const state = (await f.request('/api/ai-mode', { token })).data;
  const body = { mode: 'manual', expectedEpoch: state.epoch, expectedRevision: state.revision };
  const attempts = await Promise.all(Array.from({ length: 8 }, () => f.request('/api/ai-mode', { method: 'POST', token, body })));
  assert.equal(attempts.filter(result => result.status === 200).length, 1);
  assert.equal(attempts.filter(result => result.status === 409).length, 7);
  const final = (await f.request('/api/ai-mode', { token })).data;
  assert.equal(final.mode, 'manual'); assert.equal(final.revision, 2);
});

test('actual provider callbacks fail closed when secrets missing and still accept configured authenticated contracts', async t => {
  const f = await startFixture({ zapier: { replySecret: '' } }); t.after(f.close);
  for (const path of ['/api/zapier/reply','/api/odoo/sale-confirmed','/api/odoo/webhook/sale-confirmed'])
    assert.equal((await f.request(path, { method: 'POST', body: {} })).status, 503);
  const configured = await startFixture({ callbacks: true }); t.after(configured.close);
  const token = await configured.grant(await configured.login());
  assert.equal((await configured.toggle(token, true)).status, 200);
  for (const [path, header, value] of [['/api/zapier/reply','x-zapier-secret','fixture-zapier-secret'],
    ['/api/odoo/sale-confirmed','x-odoo-secret','fixture-odoo-secret']]) {
    assert.equal((await configured.request(path, { method: 'POST', body: {}, headers: { [header]: 'wrong' } })).status, 401);
    // The legitimate provider reaches original payload validation. No profile or
    // browser capability is incorrectly required on an independently signed callback.
    assert.equal((await configured.request(path, { method: 'POST', body: {}, headers: { [header]: value } })).status, 400);
  }
});

test('actual AI ON refuses incomplete Zapier configuration without changing mode or contacting providers', async () => {
  const cases = [
    [{ replySecret: '' }, 'AI_ZAPIER_REPLY_AUTH_REQUIRED'],
    [{ replySecret: '   ' }, 'AI_ZAPIER_REPLY_AUTH_REQUIRED'],
    [{ enabled: false }, 'AI_ZAPIER_FORWARDING_DISABLED'],
    [{ url: '' }, 'AI_ZAPIER_WEBHOOK_REQUIRED'],
    [{ url: 'http://zapier.fixture.invalid/incoming' }, 'AI_ZAPIER_WEBHOOK_REQUIRED'],
    [{ url: 'https://user:password@zapier.fixture.invalid/incoming' }, 'AI_ZAPIER_WEBHOOK_REQUIRED']
  ];
  for (const [zapier, code] of cases) {
    const f = await startFixture({ zapier });
    try {
      const token = await f.grant(await f.login()); await f.scenario({});
      const denied = await f.toggle(token, true);
      assert.equal(denied.status, 503, JSON.stringify(zapier) + ': ' + denied.text);
      assert.equal(denied.data.code, code);
      const current = (await f.request('/api/ai-mode', { token })).data;
      assert.equal(current.mode, 'manual'); assert.equal(current.revision, 0);
      const status = (await f.request('/api/ai-mode/status', { token })).data;
      assert.equal(status.operator_services.zapier_enable_ready, false);
      assert.equal(status.operator_services.zapier_enable_blocker, code);
      assert.equal((await f.calls()).length, 0);
      assert.ok(!JSON.stringify(status.operator_services).includes('zapier.fixture.invalid'));
    } finally { await f.close(); }
  }
});

test('actual AI ON accepts configured primary and legacy Zapier URL aliases without claiming delivery', async () => {
  for (const legacyAlias of [false, true]) {
    const f = await startFixture({ zapier: { legacyAlias } });
    try {
      const token = await f.grant(await f.login()); await f.scenario({});
      const enabled = await f.toggle(token, true);
      assert.equal(enabled.status, 200, enabled.text); assert.equal(enabled.data.mode, 'zapier');
      const status = (await f.request('/api/ai-mode/status', { token })).data;
      assert.equal(status.operator_services.zapier_enable_ready, true);
      assert.equal(status.operator_services.zapier_enable_blocker, null);
      assert.equal((await f.calls()).length, 0, 'Configuration must not claim a provider-delivery probe.');
    } finally { await f.close(); }
  }
});

test('actual Meta webhook aliases require configured signature and accept a valid signed provider payload', async t => {
  const f = await startFixture(); t.after(f.close);
  for (const path of ['/webhook','/whatsapp/webhook','/api/whatsapp/webhook','/api/meta/whatsapp/webhook'])
    assert.equal((await f.request(path, { method: 'POST', body: {} })).status, 503);
  assert.equal((await f.calls()).length, 0);
  const configured = await startFixture({ callbacks: true }); t.after(configured.close);
  await configured.scenario({});
  const body = { object: 'whatsapp_business_account', entry: [] };
  assert.equal((await configured.request('/webhook', { method: 'POST', body })).status, 401);
  assert.equal((await configured.calls()).length, 0);
  const signature = 'sha256=' + createHmac('sha256', 'fixture-meta-app-secret').update(JSON.stringify(body)).digest('hex');
  const accepted = await configured.request('/webhook', { method: 'POST', body, headers: { 'x-hub-signature-256': signature } });
  assert.equal(accepted.status, 200, accepted.text); assert.equal(accepted.data.router_mode, true);
  assert.equal((await configured.calls()).length, 0, 'Fixture has provider forwarding explicitly disabled');
});

test('actual training routes require administrator approval and public feedback remains pending/public', async t => {
  const f = await startFixture(); t.after(f.close); const sudo = await f.login('SUDO'), ordinary = await f.login();
  const body = { ruleText: 'Fixture rule only', approvedBy: 'forged-admin' };
  await f.scenario({});
  for (const path of ['/kit-ai-train','/kit-ai-admin-train']) {
    for (const options of [{}, { cookie: ordinary, origin: BACKEND }, { cookie: sudo, origin: 'https://attacker.invalid' },
      { cookie: sudo, origin: BACKEND, headers: { 'Content-Type': 'text/plain' } }])
      assert.equal((await f.request(path, { method: 'POST', body, ...options })).status, 401);
  }
  assert.equal((await f.calls()).length, 0);
  const approved = await f.request('/kit-ai-train', { method: 'POST', body, cookie: sudo, origin: BACKEND });
  assert.equal(approved.status, 200, approved.text);
  let create = (await f.calls()).find(x => x.odoo?.model === 'x_ai_training' && x.odoo?.operation === 'create');
  assert.equal(create.odoo.args[0].x_studio_status, 'approved'); assert.equal(create.odoo.args[0].x_studio_approved_by, 'SUDO');
  await f.scenario({});
  const feedback = await f.request('/kit-ai-feedback', { method: 'POST', body: { ...body, status: 'approved', source: 'admin' } });
  assert.equal(feedback.status, 200, feedback.text);
  create = (await f.calls()).find(x => x.odoo?.model === 'x_ai_training' && x.odoo?.operation === 'create');
  assert.equal(create.odoo.args[0].x_studio_status, 'pending'); assert.equal(create.odoo.args[0].x_studio_source, 'public');
  assert.equal(create.odoo.args[0].x_studio_approved_by, '');
});

test('actual public feedback cannot fall back to approved if Odoo pending selection is absent', async t => {
  const f = await startFixture(); t.after(f.close);
  await f.scenario({ missingPending: true });
  const feedback = await f.request('/kit-ai-feedback', { method: 'POST', body: { ruleText: 'Fixture must remain unapproved' } });
  assert.equal(feedback.status, 500);
  assert.equal((await f.calls()).filter(x => x.odoo?.operation === 'create').length, 0);
});

test('actual source-bound Zapier replies send once, acknowledge replay, and reject stale source/mode/grant', async t => {
  const f = await startFixture({ callbacks: true }); t.after(f.close);
  const token = await f.grant(await f.login());
  const enable = await f.toggle(token, true);
  assert.equal(enable.status, 200, enable.text);
  const state = enable.data.global, sourceTimestamp = state.enabled_since_ms + 1;
  const issuer = createOperatorAiReplyAuth({ secret: SECRET, getState: () => state, getFirestore: () => new FirestoreFake() });
  const grant = issuer.issue({ channelId: 22, sourceMessageId: 500, sourceTimestamp });
  const options = { method: 'POST', headers: { 'x-zapier-secret': 'fixture-zapier-secret' },
    body: { odoo_channel_id: 22, reply: 'Fixture authorized reply', ai_reply_grant: grant } };
  await f.scenario({ sourceTimestamp });
  const accepted = await f.request('/api/zapier/reply', options); assert.equal(accepted.status, 200, accepted.text);
  const replay = await f.request('/api/zapier/reply', options); assert.equal(replay.status, 200, replay.text); assert.equal(replay.data.duplicate, true);
  assert.equal((await f.calls()).filter(x => x.odoo?.operation === 'message_post').length, 1);
  assert.equal((await f.request('/api/zapier/reply', { ...options, body: { ...options.body, reply: 'Different reply' } })).status, 409);
  assert.equal((await f.request('/api/zapier/reply', { ...options, body: { ...options.body, ai_reply_grant: undefined } })).status, 401);
  const second = issuer.issue({ channelId: 22, sourceMessageId: 501, sourceTimestamp });
  await f.scenario({ sourceTimestamp, newerMessage: true });
  assert.equal((await f.request('/api/zapier/reply', { ...options, body: { ...options.body, ai_reply_grant: second } })).data.code, 'AI_CONVERSATION_CHANGED');
  assert.equal((await f.calls()).filter(x => x.odoo?.operation === 'message_post').length, 0);
  assert.equal((await f.toggle(token, false)).status, 200);
  assert.equal((await f.request('/api/zapier/reply', options)).data.code, 'AI_MODE_OFF');
  assert.equal((await f.toggle(token, true)).status, 200);
  assert.equal((await f.request('/api/zapier/reply', options)).data.code, 'AI_MODE_CHANGED');
});

test('actual Zapier reply keeps malformed or lost Odoo acknowledgement uncertain and never sends it twice', async t => {
  const f = await startFixture({ callbacks: true }); t.after(f.close); const token = await f.grant(await f.login());
  const enabled = await f.toggle(token, true); assert.equal(enabled.status, 200);
  const state = enabled.data.global, sourceTimestamp = state.enabled_since_ms + 1;
  const issuer = createOperatorAiReplyAuth({ secret: SECRET, getState: () => state, getFirestore: () => new FirestoreFake() });
  const faults = [{ messagePostResult: null }, { messagePostResult: false }, { messagePostResult: {} }, { messagePostLost: true }];
  for (let i = 0; i < faults.length; i++) {
    const grant = issuer.issue({ channelId: 22, sourceMessageId: 510 + i, sourceTimestamp });
    await f.scenario({ ...faults[i], sourceTimestamp });
    const options = { method: 'POST', headers: { 'x-zapier-secret': 'fixture-zapier-secret' }, body: {
      odoo_channel_id: 22, reply: `Fixture unconfirmed reply ${i}`, ai_reply_grant: grant
    } };
    const unknown = await f.request('/api/zapier/reply', options);
    assert.equal(unknown.status, 503, unknown.text); assert.equal(unknown.data.code, 'AI_REPLY_OUTCOME_UNCONFIRMED');
    assert.notEqual(unknown.data.posted, true);
    const retried = await f.request('/api/zapier/reply', options);
    assert.equal(retried.status, 409); assert.equal(retried.data.code, 'AI_REPLY_OUTCOME_PENDING');
    assert.equal((await f.calls()).filter(x => x.odoo?.operation === 'message_post').length, 1);
  }
});

test('actual Zapier source grant cannot send through a mismatched channel returned by Odoo', async t => {
  const f = await startFixture({ callbacks: true }); t.after(f.close); const token = await f.grant(await f.login());
  const enabled = await f.toggle(token, true); assert.equal(enabled.status, 200);
  const state = enabled.data.global, sourceTimestamp = state.enabled_since_ms + 1;
  const issuer = createOperatorAiReplyAuth({ secret: SECRET, getState: () => state, getFirestore: () => new FirestoreFake() });
  const grant = issuer.issue({ channelId: 22, sourceMessageId: 540, sourceTimestamp });
  const options = { method: 'POST', headers: { 'x-zapier-secret': 'fixture-zapier-secret' }, body: {
    odoo_channel_id: 22, reply: 'Fixture exact authorized conversation', ai_reply_grant: grant
  } };
  await f.scenario({ sourceTimestamp, channelWrongId: true });
  const rejected = await f.request('/api/zapier/reply', options);
  assert.equal(rejected.status, 409, rejected.text);
  assert.equal(rejected.data.code, 'AI_CHANNEL_CHANGED');
  assert.equal((await f.calls()).filter(x => x.odoo?.operation === 'message_post').length, 0);
  // No receipt may be consumed before the exact authorized conversation was
  // confirmed: recovering a valid read must still allow the original attempt.
  await f.scenario({ sourceTimestamp });
  const recovered = await f.request('/api/zapier/reply', options);
  assert.equal(recovered.status, 200, recovered.text);
  const sends = (await f.calls()).filter(x => x.odoo?.operation === 'message_post');
  assert.equal(sends.length, 1); assert.deepEqual(sends[0].odoo.args[0], [22]);
});

test('actual OAuth callback binds state to initiating profile session and refuses token-destination substitution', async t => {
  const f = await startFixture(); t.after(f.close); const cookie = await f.login(), other = await f.login('SUDO');
  for (const [start, callback] of [['/zoho/auth','/zoho/callback'], ['/google-contacts/auth','/google-contacts/callback']]) {
    const r = await f.request(start, { cookie, origin: BACKEND }); assert.equal(r.status, 302, r.text);
    const state = new URL(r.headers.get('location')).searchParams.get('state'); assert.ok(state);
    await f.scenario({});
    const wrong = await f.request(callback + '?code=fixture&state=' + state, { cookie: other, origin: null });
    assert.equal(wrong.status, 500); assert.equal((await f.calls()).length, 0);
    if (start === '/zoho/auth') {
      const evil = await f.request(callback + '?code=fixture&state=' + state + '&accounts-server=https://accounts.zoho.attacker.invalid', { cookie, origin: null });
      assert.equal(evil.status, 500); assert.equal((await f.calls()).length, 0);
    } else {
      const good = await f.request(callback + '?code=fixture&state=' + state, { cookie, origin: null });
      assert.equal(good.status, 200, good.text); assert.equal(good.headers.get('cache-control'), 'no-store');
      assert.equal((await f.request(callback + '?code=fixture&state=' + state, { cookie, origin: null })).status, 500);
    }
  }
});

test('actual full server remains healthy with missing signing config but refuses private authority', async t => {
  const f = await startFixture({ weakSecret: true }); t.after(f.close);
  assert.equal((await f.request('/health')).status, 200);
  const version = (await f.request('/api/operator-app/version')).data;
  assert.match(version.version, /r13/); assert.equal(version.expected_hub_ui_build, '2026.10.30-ui-r13');
  assert.equal(version.build_commit, null);
  const cookie = await f.login();
  assert.equal((await f.request('/api/odoo/orders', { cookie, origin: BACKEND })).status, 503);
  assert.equal((await f.request('/api/operator-browser-auth/token', { method: 'POST', cookie, origin: BACKEND,
    headers: { 'X-SH-Operator-Auth': '1' }, body: { origin: HUB } })).status, 503);
});

test('document links expire and cannot cross methods, records, actions, purposes or signing keys', () => {
  let clock = 1800000000000;
  const links = createOperatorDocumentLinks({ secret: SECRET, clock: () => clock });
  const issued = links.issue(41), parsed = new URL(issued.url);
  const request = { originalUrl: parsed.pathname + parsed.search, method: 'GET' };
  assert.equal(links.authorize(request), true); assert.equal(request.operatorDocumentGrant.id, 41);
  assert.throws(() => links.authorize({ ...request, method: 'POST' }));
  assert.throws(() => links.authorize({ ...request, originalUrl: request.originalUrl.replace('view/41','view/42') }));
  assert.throws(() => links.authorize({ ...request, originalUrl: request.originalUrl.replace('view/41','download/41') }));
  assert.throws(() => createOperatorDocumentLinks({ secret: SECRET + 'new' }).authorize(request));
  clock = issued.expiresAt; assert.throws(() => links.authorize(request), error => error.status === 410);
  assert.throws(() => createOperatorDocumentLinks({ secret: 'weak' }).issue(41), error => error.status === 503);
  for (const value of ['javascript:alert(1)', 'data:text/html,test', 'http://plain.invalid/', 'https://u:p@private.invalid/']) assert.equal(safeDocumentRedirect(value), '');
  assert.equal(safeDocumentRedirect('https://example.invalid/file.pdf'), 'https://example.invalid/file.pdf');
});

test('least-privilege integration scopes do not grant generic ERP, writes from read scope or cross-family access', async () => {
  const now = Date.now(), routes = new Map();
  const auth = createOperatorBrowserAuth({ secret: SECRET, readProfileSession: req => req.session, clock: () => now });
  auth.registerRoutes({ get: () => {}, post: (path, fn) => routes.set(path, fn) });
  const response = () => ({ statusCode: 200, headers: {}, setHeader(k,v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } });
  const issued = response();
  await routes.get('/api/operator-browser-auth/token')({ originalUrl: '/api/operator-browser-auth/token', method: 'POST',
    headers: { origin: BACKEND, 'x-sh-operator-auth': '1' }, session: { profile: 'SUDO', exp: now + 7200000 }, body: { origin: HUB } }, issued);
  const claims = auth.verifyToken(issued.body.token);
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(SECRET), Buffer.from('sh-operator-browser-auth'), Buffer.from('capability-signature-v1'), 32));
  const narrow = scopes => {
    const payload = Buffer.from(JSON.stringify({ ...claims, scopes })).toString('base64url');
    return `shb1.${payload}.${createHmac('sha256', key).update('shb1.' + payload).digest('base64url')}`;
  };
  for (const [path, method, scopes, expected] of [
    ['/api/zoho-mail/messages','GET',['mail:read'],200], ['/api/zoho-mail/send','POST',['mail:read'],403],
    ['/api/odoo-documents/tree','GET',['mail:read'],403], ['/api/zoho-mail/messages','GET',['calls:read','calls:write'],403],
    ['/api/odoo/query','POST',claims.scopes,403], ['/api/odoo-documents/share','POST',['documents:write'],403]
  ]) {
    const res = response(); let next = false;
    await auth.guard({ originalUrl: path, path, method, body: { channel: ' EMAIL ' }, query: {},
      headers: { origin: HUB, authorization: 'Bearer ' + narrow(scopes) } }, res, () => { next = true; });
    assert.equal(res.statusCode, expected, path); assert.equal(next, expected === 200);
  }
  // Old grants never gain newly introduced scopes during refresh.
  const refreshed = response();
  await routes.get('/api/operator-browser-auth/refresh')({ originalUrl: '/api/operator-browser-auth/refresh', method: 'POST',
    headers: { origin: HUB, authorization: 'Bearer ' + narrow(['calls:read']) }, body: { scopes: ['mail:write'] } }, refreshed);
  assert.deepEqual(auth.verifyToken(refreshed.body.token).scopes, ['calls:read']);
});
