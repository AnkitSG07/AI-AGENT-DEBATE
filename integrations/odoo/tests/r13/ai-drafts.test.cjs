'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { launch, finish, fixture, messagesFor } = require('./workflow-harness.cjs');
const { Simulator } = require('./odoo-render-simulator.cjs');

test.before(launch);
test.after(finish);

async function draftFixture({ connect = true } = {}) {
  const sim = new Simulator();
  for (const id of [101, 102]) sim.models['mail.message'].push(...messagesFor(id));
  const requests = [];
  let pending;
  const f = await fixture({ connect, services: async (route, url, req) => {
    if (url.pathname !== '/api/ai-mode/draft') return sim.route(route, url, req);
    requests.push({ body: req.postDataJSON(), authorization: req.headers().authorization });
    pending = route;
    return true;
  } });
  await f.page.evaluate(() => __hubUiTest.selectChannel(101));
  async function reply(body = { ok: true, channelId: 101, draft: 'Thank you for your enquiry. Which quantity would you like?', model: 'gpt-6.1-terra' }, status = 200) {
    assert.ok(pending, 'The draft request reached the offline endpoint');
    const route = pending;
    pending = null;
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
    await f.page.waitForFunction(() => !__hubUiTest.state.aiDraftRequest);
  }
  return { ...f, sim, draftRequests: requests, reply };
}

function sentMessages(f) {
  return f.sim.calls.filter(call => call.method === 'message_post');
}

test('AI drafts run only on an explicit tap, use operator auth and wait for composer review', async () => {
  const f = await draftFixture();
  try {
    assert.equal(f.draftRequests.length, 0);
    await f.page.locator('#shAiDraftBtn').click();
    await f.page.waitForFunction(() => !!__hubUiTest.state.aiDraftRequest);
    await f.page.evaluate(() => __hubUiTest.runAiDraft());
    await assertEventually(() => f.draftRequests.length === 1);
    assert.ok(f.draftRequests[0].authorization.startsWith('Bearer SIMULATED_ONLY_'));
    assert.deepEqual(Object.keys(f.draftRequests[0].body).sort(), ['channelId', 'conversation']);
    assert.equal(f.draftRequests[0].body.channelId, 101);
    assert.match(f.draftRequests[0].body.conversation, /Customer: Hello/);
    await f.reply();
    assert.equal(await f.page.locator('#shMessageInput').inputValue(), '');
    assert.equal(await f.page.locator('#shAiModeSendBtn').isVisible(), false);
    assert.equal(sentMessages(f).length, 0);
    assert.equal(f.sim.aiMode, 'manual');
    if (process.env.SH_AI_DRAFT_SCREENSHOT) await f.page.screenshot({ path: process.env.SH_AI_DRAFT_SCREENSHOT });
    await f.page.locator('#shAiModeUseBtn').click();
    assert.match(await f.page.locator('#shMessageInput').inputValue(), /Thank you for your enquiry/);
    assert.equal(sentMessages(f).length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('typing during generation is preserved and replacing the composer requires confirmation', async () => {
  const f = await draftFixture();
  try {
    await f.page.locator('#shAiDraftBtn').click();
    await assertEventually(() => f.draftRequests.length === 1);
    await f.page.locator('#shMessageInput').fill('My updated reply');
    await f.reply();
    assert.equal(await f.page.locator('#shMessageInput').inputValue(), 'My updated reply');
    f.page.once('dialog', dialog => dialog.dismiss());
    await f.page.locator('#shAiModeUseBtn').click();
    assert.equal(await f.page.locator('#shMessageInput').inputValue(), 'My updated reply');
    f.page.once('dialog', dialog => dialog.accept());
    await f.page.locator('#shAiModeUseBtn').click();
    assert.match(await f.page.locator('#shMessageInput').inputValue(), /Thank you for your enquiry/);
    assert.equal(sentMessages(f).length, 0);
  } finally { await f.close(); }
});

test('switching chats cancels the pending request and a late response cannot enter the other chat', async () => {
  const f = await draftFixture();
  try {
    await f.page.locator('#shAiDraftBtn').click();
    await assertEventually(() => f.draftRequests.length === 1);
    await f.page.evaluate(() => {
      window.previousDraftSignal = __hubUiTest.state.aiDraftRequest.controller.signal;
      return __hubUiTest.selectChannel(102);
    });
    assert.equal(await f.page.evaluate(() => previousDraftSignal.aborted), true);
    await f.page.locator('#shMessageInput').fill('Reply for customer B');
    await f.reply();
    assert.equal(await f.page.locator('#shMessageInput').inputValue(), 'Reply for customer B');
    assert.equal(await f.page.locator('#shAiModePanel').isVisible(), false);
    assert.equal(await f.page.evaluate(() => __hubUiTest.state.aiLastResult), null);
    assert.equal(sentMessages(f).length, 0);
  } finally { await f.close(); }
});

test('new source messages invalidate pending and completed drafts', async () => {
  for (const completeFirst of [false, true]) {
    const f = await draftFixture();
    try {
      await f.page.locator('#shAiDraftBtn').click();
      await assertEventually(() => f.draftRequests.length === 1);
      if (completeFirst) await f.reply();
      await f.page.evaluate(() => {
        const h = __hubUiTest;
        h.state.messages.push({ ...h.state.messages[0], id: 9090, body: 'Actually, I need a different product.' });
        h.renderMessages();
      });
      if (!completeFirst) await f.reply();
      assert.equal(await f.page.locator('#shAiModePanel').isVisible(), false);
      assert.equal(await f.page.evaluate(() => __hubUiTest.state.aiLastResult), null);
      assert.equal(sentMessages(f).length, 0);
    } finally { await f.close(); }
  }
});

test('closing the panel and tearing down the session abort pending drafts', async () => {
  for (const teardown of [false, true]) {
    const f = await draftFixture();
    try {
      await f.page.locator('#shAiDraftBtn').click();
      await assertEventually(() => f.draftRequests.length === 1);
      await f.page.evaluate(() => { window.previousDraftSignal = __hubUiTest.state.aiDraftRequest.controller.signal; });
      if (teardown) await f.page.evaluate(() => __hubUiTest.destroyOperatorApp());
      else await f.page.locator('#shAiModePanelClose').click();
      assert.equal(await f.page.evaluate(() => previousDraftSignal.aborted), true);
      await f.reply();
      assert.equal(await f.page.locator('#shAiModePanel').isVisible(), false);
      assert.equal(sentMessages(f).length, 0);
    } finally { await f.close(); }
  }
});

test('unavailable and mismatched responses leave the original composer intact', async () => {
  for (const [body, status] of [[{ ok: false, error: 'OpenAI key is not configured.' }, 503], [{ ok: true, channelId: 102, draft: 'Wrong conversation' }, 200]]) {
    const f = await draftFixture();
    try {
      await f.page.locator('#shMessageInput').fill('Original reply');
      await f.page.locator('#shAiDraftBtn').click();
      await assertEventually(() => f.draftRequests.length === 1);
      await f.reply(body, status);
      assert.equal(await f.page.locator('#shMessageInput').inputValue(), 'Original reply');
      assert.equal(await f.page.locator('#shAiModeUseBtn').isDisabled(), true);
      assert.equal(await f.page.locator('#shAiModeSendBtn').isVisible(), false);
      assert.equal(sentMessages(f).length, 0);
    } finally { await f.close(); }
  }
});

test('a disconnected operator cannot send inference requests and context is bounded', async () => {
  const f = await draftFixture({ connect: false });
  try {
    await f.page.locator('#shAiDraftBtn').click();
    await f.page.waitForFunction(() => !__hubUiTest.state.aiDraftRequest);
    assert.equal(f.draftRequests.length, 0);
    assert.equal(await f.page.locator('#shAiModeUseBtn').isDisabled(), true);
    const text = await f.page.evaluate(() => {
      __hubUiTest.state.messages = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, body: 'text'.repeat(2000), author_id: [601, 'Customer'] }));
      return __hubUiTest.buildAiDraftConversation();
    });
    assert.equal(text.length, 24000);
    assert.equal(sentMessages(f).length, 0);
  } finally { await f.close(); }
});

async function assertEventually(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(check(), 'Expected the offline draft request to arrive');
}
