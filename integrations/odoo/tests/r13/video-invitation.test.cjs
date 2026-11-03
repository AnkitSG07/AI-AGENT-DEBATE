'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {context, deferred} = require('./production-functions.cjs');
function fixture() {
  const messages = [], posted = [], toasts = [];
  const c = context(['startNativeVideoInvitation', 'receiveNativeVideoInvitation'], {
    nativeVideoInvitations: new Map(), crypto: {randomUUID: () => 'request-video-invitation-001'},
    state: {destroyed: false, session: {uid: 7}, selectedChannel: {id: 73, channel_type: 'whatsapp'}, selectedChannelId: 73},
    hasHubNativeBridge: () => true, isWhatsappWindowOpen: () => true, channelDisplayName: () => 'Synthetic customer',
    postHubNativeMessage: data => messages.push(data), showOperatorToast: text => toasts.push(text),
    postTextToChannel: async (channel, text) => { posted.push({channel, text}); return true; },
    loadMessages: async () => {}, loadChannels: async () => {}
  });
  const result = (extra = {}) => ({detail: {requestId: 'request-video-invitation-001', channelId: 73, customerUrl: 'https://ai-agent-debate.onrender.com/v/' + 'a'.repeat(24), ...extra}});
  return {c, messages, posted, toasts, result};
}
test('video automatically sends exactly one customer invitation to the original chat after switching chats', async () => {
  const f = fixture(); f.c.startNativeVideoInvitation();
  assert.equal(f.messages[0].channelId, 73);
  f.c.state.selectedChannel = {id: 74, channel_type: 'whatsapp'}; f.c.state.selectedChannelId = 74;
  await f.c.receiveNativeVideoInvitation(f.result()); await f.c.receiveNativeVideoInvitation(f.result());
  assert.equal(f.posted.length, 1); assert.equal(f.posted[0].channel.id, 73); assert.ok(f.posted[0].text.includes('/v/'));
  assert.equal(f.messages.at(-1).outcome, 'sent');
});
test('unrequested, mismatched, operator and foreign-site links never send a chat message', async () => {
  for (const input of [{requestId:'unknown'}, {channelId:74}, {customerUrl:'https://evil.invalid/v/' + 'a'.repeat(24)}, {customerUrl:'https://ai-agent-debate.onrender.com/video-call.html#operator-secret'}]) {
    const f = fixture(); f.c.startNativeVideoInvitation(); await f.c.receiveNativeVideoInvitation(f.result(input)); assert.equal(f.posted.length, 0);
  }
});
test('changed account and closed WhatsApp window cannot send an invitation', async () => {
  const f = fixture(); f.c.isWhatsappWindowOpen = () => false; f.c.startNativeVideoInvitation(); assert.equal(f.messages.length, 0);
  const g = fixture(); g.c.startNativeVideoInvitation(); g.c.state.session.uid = 8; await g.c.receiveNativeVideoInvitation(g.result()); assert.equal(g.posted.length, 0);
});
test('uncertain send and duplicate callback in flight never retry the customer message', async () => {
  const f = fixture(), gate = deferred(); let sends = 0;
  f.c.postTextToChannel = async () => { sends++; await gate.promise; throw Error('response lost'); };
  f.c.startNativeVideoInvitation(); f.c.startNativeVideoInvitation(); assert.equal(f.messages.length, 1);
  const pending = f.c.receiveNativeVideoInvitation(f.result()); await f.c.receiveNativeVideoInvitation(f.result());
  gate.resolve(); await pending; await f.c.receiveNativeVideoInvitation(f.result());
  assert.equal(sends, 1); assert.equal(f.messages.at(-1).outcome, 'uncertain');
});
