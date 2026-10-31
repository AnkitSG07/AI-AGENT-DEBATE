// Runs the ACTUAL server and middleware ordering. Only external providers are
// synthetic; every unrecognized outbound request is refused before networking.
import express from 'express';
import { generateKeyPairSync } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { FirestoreFake } from '../operator-r12-helpers.mjs';

// Only the storage transport is synthetic in this whole-server fixture. The
// receipt module also has a separate official-SDK emulator integration suite.
const storage = new FirestoreFake();
Firestore.prototype.collection = function (path) { return storage.collection(path); };
Firestore.prototype.runTransaction = function (...args) { return storage.runTransaction(...args); };
Firestore.prototype.terminate = async function () {};
const ephemeralKey = generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
process.env.SH_ANDROID_REGISTRY_BACKEND = 'firestore';
process.env.SH_ANDROID_FIREBASE_PROJECT_ID = 'demo-sh-private-fixture';
process.env.SH_ANDROID_FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ type: 'service_account',
  project_id: 'demo-sh-private-fixture', client_email: 'fixture@demo-sh-private-fixture.iam.gserviceaccount.com', private_key: ephemeralKey });

const calls = [];
let scenario = {};
const send = value => process.send?.(value);
const result = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
const docs = [{ id: 41, name: 'Fixture certificate.pdf', type: 'binary', attachment_id: [71, 'Fixture certificate.pdf'],
  mimetype: 'application/pdf', file_size: 20, folder_id: false, active: true, access_token: 'never-return-this-provider-token' }];
globalThis.fetch = async (value, options = {}) => {
  const url = new URL(String(value)), method = String(options.method || 'GET');
  let body = options.body ? String(options.body) : '';
  try { body = JSON.parse(body); } catch {}
  const record = { host: url.host, path: url.pathname, query: url.search, method, body };
  calls.push(record);
  if (url.hostname === 'odoo.fixture.invalid') {
    const params = body.params || {};
    if (params.service === 'common') return result({ result: 7 });
    const [, , , model, operation, args, kw] = params.args || [];
    record.odoo = { model, operation, args, kw };
    if (model === 'documents.document') return result({ result: docs.map(doc => ({ ...doc,
      ...(scenario.documentUrl ? { type: 'url', url: scenario.documentUrl } : {}),
      ...(scenario.unicodeDocument ? { name: 'प्रमाणपत्र certificate.pdf' } : {}),
      ...(scenario.directDocumentBinary ? { attachment_id: false } : {}),
      ...(operation === 'read' && args?.[1]?.includes('datas') && scenario.directDocumentBinary
        ? { id: scenario.documentBinaryWrongId ? 42 : doc.id,
          datas: Buffer.from(scenario.documentBinaryWrongId ? '%PDF-1.4 wrong-document-42' : '%PDF-1.4 fixture direct document').toString('base64') }
        : {}) })) });
    if (model === 'ir.attachment') return result({ result: [{ id: scenario.attachmentWrongId ? 72 : 71,
      name: docs[0].name, mimetype: 'application/pdf', datas: Buffer.from(scenario.attachmentWrongId
        ? '%PDF-1.4 wrong-attachment-72' : '%PDF-1.4 fixture only').toString('base64') }] });
    if (model === 'x_ai_training' && operation === 'fields_get') return result({ result: {
      x_studio_status: { selection: scenario.missingPending ? [['approved','Approved']] : [['approved','Approved'],['pending','Pending'],['rejected','Rejected']] },
      x_studio_source: { selection: [['admin','Admin'],['public','Public']] },
      x_studio_category: { selection: [['compatibility','Compatibility']] }
    } });
    if (model === 'discuss.channel' && operation === 'read') return result({ result: [{ id: scenario.channelWrongId ? 23 : 22,
      channel_type: scenario.livechat ? 'livechat' : 'whatsapp', active: true,
      whatsapp_channel_active: true,
      whatsapp_channel_valid_until: new Date(Date.now() + (scenario.closedWindow ? -1000 : 60000)).toISOString() }] });
    if (model === 'discuss.channel' && operation === 'message_post') {
      if (scenario.messagePostLost) throw new Error('Synthetic Odoo acknowledgement lost after accepting message');
      return result({ result: Object.hasOwn(scenario, 'messagePostResult') ? scenario.messagePostResult : 920 });
    }
    if (model === 'res.partner' && operation === 'search_read') return result({ result: [] });
    if (model === 'res.partner' && operation === 'create') return result({ result: 52 });
    if (model === 'res.partner' && operation === 'read') return result({ result: [{ id: 52, name: 'Fixture contact', email: 'fixture@example.invalid', phone: '+919000000001' }] });
    if (model === 'res.users') return result({ result: [{ id: 7, name: 'Fixture operator', partner_id: [70, 'Fixture operator'] }] });
    if (model === 'mail.message' && operation === 'read') return result({ result: [{ id: Number(args[0][0]), model: 'discuss.channel', res_id: 22,
      date: new Date(scenario.sourceTimestamp || Date.now()).toISOString(), body: 'Fixture inbound', author_id: [51, 'Fixture customer'],
      create_uid: [4, 'Public user'], message_type: 'whatsapp_message', attachment_ids: [] }] });
    if (model === 'mail.message' && operation === 'search_read') return result({ result: scenario.newerMessage ? [{ id: 999999, body: 'New fixture message', date: new Date().toISOString() }] : [] });
    if (operation === 'fields_get') return result({ result: { name: {}, email: {}, phone: {}, mobile: {}, customer_rank: {} } });
    if (operation === 'create') return result({ result: 53 });
    return result({ result: [] });
  }
  if (url.hostname === 'accounts.zoho.fixture.invalid' || url.hostname === 'oauth2.googleapis.com')
    return result({ access_token: 'fixture-provider-access', refresh_token: 'fixture-refresh-token', expires_in: 3600 });
  if (url.hostname === 'mail.zoho.fixture.invalid') {
    if (method === 'POST') {
      if (scenario.mail401) return new Response(JSON.stringify({ status: { code: 401, description: 'Fixture auth expired' } }), { status: 401 });
      if (scenario.mailLostResponse) throw new Error('Synthetic response lost after provider accepted');
      return result({ data: { messageId: 'fixture-sent-message' } });
    }
    if (url.pathname.endsWith('/content')) return result({ data: { content: '<p>Fixture customer email</p>' } });
    if (url.pathname.endsWith('/messages/view')) return result({ data: [{ messageId: 'm1', subject: 'Fixture conversation' }] });
    if (url.pathname.endsWith('/folders')) return result({ data: [{ folderId: 'inbox-1', folderType: 'Inbox', folderName: 'Inbox' }] });
    if (/\/accounts\/fixture-account$/.test(url.pathname)) return result({ data: { accountId: 'fixture-account', mailboxAddress: 'care@example.invalid' } });
    return result({ data: [{ accountId: 'fixture-account', mailboxAddress: 'care@example.invalid' }] });
  }
  if (url.hostname === 'people.googleapis.com') return result({ connections: [
    { resourceName: 'people/fixture', names: [{ displayName: 'Fixture contact' }], emailAddresses: [{ value: 'fixture@example.invalid' }], phoneNumbers: [{ value: '+919000000001' }] }
  ], results: [{ person: { resourceName: 'people/fixture', names: [{ displayName: 'Fixture contact' }] } }] });
  throw new Error(`External networking disabled by fixture: ${url.origin}${url.pathname}`);
};

const listen = express.application.listen;
express.application.listen = function (...args) {
  // The complete production handlers run behind a loopback-only fixture.
  // A verification run must never expose synthetic administrative endpoints.
  const server = listen.call(this, args[0], '127.0.0.1', ...args.filter(value => typeof value === 'function'));
  server.once('listening', () => send({ type: 'ready', port: server.address().port }));
  server.once('error', error => {
    process.stderr.write(`Fixture HTTP startup failed: ${error.code || 'LISTEN_FAILED'}\n`);
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
  return server;
};
process.on('message', message => {
  if (message?.type === 'scenario') { scenario = message.value || {}; calls.length = 0; storage.failReads = scenario.storageDown ? new Error('Synthetic storage outage') : null;
    send({ type: 'ack', id: message.id }); }
  if (message?.type === 'calls') send({ type: 'calls', id: message.id, calls });
});
await import('../../server.js');
