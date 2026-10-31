import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationText, messageNotificationPreview } from '../operator-message-preview.js';
import { registryFixture } from './operator-r12-helpers.mjs';

test('customer author name and actual text replace generic message placeholders', () => {
  const data = messageNotificationPreview({ name: 'Ankit', channel_type: 'whatsapp' },
    { author_id: [12, 'Ankit Garia'], body: '<p>Is the <strong>3W kit</strong> available?</p>' });
  assert.equal(data.sender_name, 'Ankit Garia');
  assert.equal(data.message_preview, 'Is the 3W kit available?');
  assert.equal(data.group_conversation, 'false');
});

test('HTML entities, Hindi, emoji and escaped comparison text remain readable', () => {
  assert.equal(notificationText('<p>नमस्ते 👋 &amp; &#x1f600; &lt;5W&gt; &quot;yes&quot;</p>', 997, true), 'नमस्ते 👋 & 😀 <5W> "yes"');
});

test('script/style/comment content and hidden bidi controls cannot become preview text', () => {
  const data = messageNotificationPreview({ name: 'A\u202eB' }, { body: '<style>PRIVATE_STYLE</style><script>PRIVATE_SCRIPT</script><!--PRIVATE_COMMENT--><p>Hello</p>' });
  assert.equal(data.sender_name, 'A B');
  assert.equal(data.message_preview, 'Hello');
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_/);
});

test('Unicode previews fit their byte budget without cutting a surrogate pair', () => {
  const data = messageNotificationPreview({ name: '👋'.repeat(200) }, { body: '<p>' + 'किट 😀'.repeat(1000) + '</p>' });
  assert.ok(Buffer.byteLength(data.sender_name) <= 240);
  assert.ok(Buffer.byteLength(data.message_preview) <= 1000);
  assert.doesNotMatch(data.message_preview, /\ufffd/);
});

test('guest/partner/conversation names provide real fallbacks', () => {
  assert.equal(messageNotificationPreview({ name: 'Chat' }, { author_guest_id: [3, 'Website visitor'] }).sender_name, 'Website visitor');
  assert.equal(messageNotificationPreview({ whatsapp_partner_id: [4, 'Kushagra'] }, {}).sender_name, 'Kushagra');
  assert.equal(messageNotificationPreview({ name: 'Vibhu' }, {}).sender_name, 'Vibhu');
});

test('attachments without text receive an honest media label', () => {
  for (const [mime, label] of [['image/jpeg', '📷 Photo'], ['audio/ogg', '🎵 Audio message'], ['video/mp4', '🎥 Video'], ['application/pdf', '📎 Attachment']])
    assert.equal(messageNotificationPreview({}, { attachment_ids: [{ id: 8, mimetype: mime }] }).message_preview, label);
  assert.equal(messageNotificationPreview({}, { attachment_ids: [8] }).message_preview, '📎 Attachment');
});

test('group names and sender names stay separate; ordinary chats remain one-to-one', () => {
  const data = messageNotificationPreview({ name: 'Sales team', channel_type: 'chat', is_group: true }, { author_id: [12, 'Ankit'], body: 'Hello team' });
  assert.equal(data.conversation_name, 'Sales team'); assert.equal(data.sender_name, 'Ankit'); assert.equal(data.group_conversation, 'true');
  assert.equal(messageNotificationPreview({ name: 'Ankit', channel_type: 'whatsapp' }, {}).group_conversation, 'false');
});

const incoming = (clock, id = 81) => ({ verifiedIncoming: true, channel: { id: 73, channel_type: 'whatsapp', name: 'Ankit' },
  message: { id, model: 'discuss.channel', res_id: 73, date: new Date(clock()).toISOString(), author_id: [4, 'Ankit'], body: '<p>Can I order 20 kits?</p>' } });

test('R15 FCM carries bounded previews and exact chat routing; R14 keeps its previous contract', async () => {
  const now = () => 1800000000000, f = registryFixture({ clock: now });
  await f.enroll('0000000000000001', { nativeBuild: 15, mediaProtocol: 'sh-room-audio-v1' });
  await f.enroll('0000000000000002', { nativeBuild: 14, mediaProtocol: 'sh-room-audio-v1' });
  await f.bridge.publishMessage(incoming(now));
  assert.equal(f.deliveries.length, 2);
  const rich = f.deliveries.find(row => row.device.nativeBuild === 15).data;
  const old = f.deliveries.find(row => row.device.nativeBuild === 14).data;
  assert.equal(rich.sender_name, 'Ankit'); assert.equal(rich.message_preview, 'Can I order 20 kits?');
  assert.equal(rich.message_at_ms, String(now())); assert.equal(rich.preview_protocol, 'sh-message-preview-v1');
  assert.equal(rich.channel_id, '73'); assert.equal(new URL(rich.hub_url).searchParams.get('channel_id'), '73');
  assert.equal(old.sender_name, undefined); assert.equal(old.message_preview, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(rich)) < 3000);
  await f.bridge.publishMessage(incoming(now)); assert.equal(f.deliveries.length, 2, 'duplicate worker callbacks must not duplicate the alert');
});

test('rich preview data does not bypass trusted-source, exact-channel or receiveChats checks', async () => {
  const now = () => 1800000000000, f = registryFixture({ clock: now });
  const enrollment = await f.enroll('0000000000000001', { nativeBuild: 15, mediaProtocol: 'sh-room-audio-v1' });
  const data = incoming(now);
  await f.bridge.publishMessage({ ...data, verifiedIncoming: false });
  await f.bridge.publishMessage({ ...data, message: { ...data.message, res_id: 74 } });
  await f.request('POST', '/api/operator-android/devices/token', { fcmToken: enrollment.body.fcmToken, receiveChats: false }, enrollment.result.body.deviceToken);
  await f.bridge.publishMessage(data);
  assert.equal(f.deliveries.length, 0);
});
