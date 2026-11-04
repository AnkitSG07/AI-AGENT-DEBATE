'use strict';
// Real frontend, synthetic Odoo records, and fully intercepted HTTP requests.
// Selecting an inbox account must never change the channel used for a reply.
const test = require('node:test');
const assert = require('node:assert/strict');
const { launch, finish, fixture, messagesFor } = require('./workflow-harness.cjs');
const { Simulator } = require('./odoo-render-simulator.cjs');

test.before(launch);
test.after(finish);

async function fresh(options = {}) {
  const sim = new Simulator();
  const channels = sim.models['discuss.channel'];
  Object.assign(channels[0], { name: 'Shared customer', display_name: 'Shared customer', wa_account_id: [41, 'Showroom'], _uiUnreadCount: 3 });
  Object.assign(channels[1], { name: 'Shared customer', display_name: 'Shared customer', whatsapp_number: channels[0].whatsapp_number,
    whatsapp_partner_id: channels[0].whatsapp_partner_id, wa_account_id: 42, _uiUnreadCount: 0 });
  Object.assign(channels[2], { wa_account_id: [999, 'Not a WhatsApp source'], _uiUnreadCount: 2 });
  channels.push({ ...channels[0], id: 105, name: 'Account metadata missing', display_name: 'Account metadata missing', wa_account_id: false, _uiUnreadCount: 1 });
  sim.fields['discuss.channel'].wa_account_id = { type: 'many2one', relation: 'whatsapp.account' };
  for (const id of [101, 102, 105]) sim.models['mail.message'].push(...messagesFor(id));
  const f = await fixture({ width: 1280, height: 900, mobile: false, ...options, services: sim.route.bind(sim) });
  await f.page.evaluate(rows => {
    const h = window.__hubUiTest;
    Object.assign(h.state, { channels: rows, currentFilter: 'all', searchTerm: '', whatsappAccountFilter: 'all' });
    // These values must not expand the choices beyond authorized channel data.
    h.state.whatsappTemplates = [{ id: 301, raw: { wa_account_id: [998, 'Template-only account'] } }];
    h.applyFiltersAndRender();
  }, channels);
  return { ...f, sim };
}

const rowIds = f => f.page.locator('#shChannelList [data-channel-id]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.channelId)).sort((a, b) => a - b));
const accountOptions = f => f.page.locator('#shWhatsappAccountFilter option').evaluateAll(nodes => nodes.map(node => ({ value: node.value, text: node.textContent })));
const posts = f => f.sim.calls.filter(call => call.model === 'discuss.channel' && call.method === 'message_post');

test('account choices come only from loaded WhatsApp channels and All keeps the mixed inbox', async () => {
  const f = await fresh();
  try {
    assert.deepEqual(await rowIds(f), [101, 102, 103, 104, 105]);
    const options = await accountOptions(f);
    assert.deepEqual(options.map(option => option.value).sort(), ['account:41', 'account:42', 'all', 'unavailable']);
    assert.equal(options[0].value, 'all');
    assert.equal(options.find(option => option.value === 'account:41').text, 'Showroom · #41');
    assert.equal(options.find(option => option.value === 'account:42').text, 'WhatsApp account #42');
    assert.equal(options.some(option => /919999000101|Template-only|Not a WhatsApp/.test(option.text)), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('identity accepts positive relation IDs, rejects invalid IDs, and excludes other channel types', async () => {
  const f = await fresh();
  try {
    const result = await f.page.evaluate(() => {
      const identity = relation => __hubUiTest.whatsappAccountIdentity({ channel_type: 'whatsapp', wa_account_id: relation });
      return {
        tuple: identity([41, 'Showroom']), numeric: identity(42), numericString: identity('43'),
        invalid: [false, true, null, [], [0, 'Zero'], [1.5, 'Fraction'], [-1, 'Negative'], ['no-id', 'Invalid'], Number.MAX_SAFE_INTEGER + 1].map(identity),
        other: __hubUiTest.whatsappAccountIdentity({ channel_type: 'livechat', wa_account_id: [41, 'Showroom'] })
      };
    });
    assert.deepEqual(result.tuple, { key: 'account:41', id: 41, label: 'Showroom · #41' });
    assert.deepEqual(result.numeric, { key: 'account:42', id: 42, label: 'WhatsApp account #42' });
    assert.equal(result.numericString.key, 'account:43');
    for (const item of result.invalid) {
      assert.equal(item.key, 'unavailable');
      assert.equal(item.label, 'WhatsApp account unavailable');
    }
    assert.equal(result.other, null);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('account scope composes with unread, search and favorites without changing counters', async () => {
  const f = await fresh();
  try {
    const before = await f.page.evaluate(() => __hubUiTest.state.channels.map(channel => [channel.id, __hubUiTest.channelUnreadCount(channel)]));
    await f.page.locator('#shWhatsappAccountFilter').selectOption('account:41');
    assert.deepEqual(await rowIds(f), [101]);
    await f.page.evaluate(() => { __hubUiTest.state.currentFilter = 'unread'; __hubUiTest.applyFiltersAndRender(); });
    assert.deepEqual(await rowIds(f), [101]);
    await f.page.locator('#shWhatsappAccountFilter').selectOption('account:42');
    assert.deepEqual(await rowIds(f), []);
    await f.page.locator('#shWhatsappAccountFilter').selectOption('all');
    assert.deepEqual(await rowIds(f), [101, 103, 105]);
    await f.page.evaluate(() => {
      const h = __hubUiTest;
      h.state.currentFilter = 'all'; h.state.searchTerm = 'Shared customer'; h.applyFiltersAndRender();
    });
    assert.deepEqual(await rowIds(f), [101, 102]);
    await f.page.locator('#shWhatsappAccountFilter').selectOption('account:41');
    assert.deepEqual(await rowIds(f), [101]);
    await f.page.evaluate(() => {
      const h = __hubUiTest;
      h.state.searchTerm = ''; h.toggleHubFavorite(h.state.channels.find(channel => channel.id === 102));
      h.state.currentFilter = 'favorites'; h.applyFiltersAndRender();
    });
    assert.deepEqual(await rowIds(f), []);
    await f.page.locator('#shWhatsappAccountFilter').selectOption('account:42');
    assert.deepEqual(await rowIds(f), [102]);
    const after = await f.page.evaluate(() => __hubUiTest.state.channels.map(channel => [channel.id, __hubUiTest.channelUnreadCount(channel)]));
    assert.deepEqual(after, before);
    assert.equal(posts(f).length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('unavailable account scope keeps metadata-missing WhatsApp chats accessible', async () => {
  const f = await fresh();
  try {
    await f.page.locator('#shWhatsappAccountFilter').selectOption('unavailable');
    assert.deepEqual(await rowIds(f), [105]);
    assert.equal(await f.page.locator('[data-channel-id="105"] .sh-op-list-account').textContent(), 'Via WhatsApp account unavailable');
    await f.page.evaluate(() => __hubUiTest.selectChannel(105));
    assert.equal(await f.page.locator('#shSelectedWhatsappAccount').textContent(), 'Replying via WhatsApp account unavailable');
    await f.page.locator('#shWhatsappAccountFilter').selectOption('all');
    assert.deepEqual(await rowIds(f), [101, 102, 103, 104, 105]);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('changing account scope preserves the selected chat and draft, and replies stay on its channel', async () => {
  const f = await fresh();
  try {
    await f.page.evaluate(() => __hubUiTest.selectChannel(101));
    await f.page.locator('#shMessageInput').fill('Reply through showroom');
    const before = await f.page.evaluate(() => ({ id: __hubUiTest.state.selectedChannelId, epoch: __hubUiTest.state.selectionEpoch, account: __hubUiTest.state.selectedChannel.wa_account_id }));
    await f.page.locator('#shWhatsappAccountFilter').selectOption('account:42');
    assert.deepEqual(await rowIds(f), [102]);
    assert.equal(await f.page.locator('#shMessageInput').inputValue(), 'Reply through showroom');
    assert.deepEqual(await f.page.evaluate(() => ({ id: __hubUiTest.state.selectedChannelId, epoch: __hubUiTest.state.selectionEpoch, account: __hubUiTest.state.selectedChannel.wa_account_id })), before);
    assert.equal(await f.page.locator('#shSelectedWhatsappAccount').textContent(), 'Replying via Showroom · #41');
    await f.page.evaluate(() => __hubUiTest.sendCurrentMessage());
    assert.equal(posts(f).length, 1);
    assert.equal(posts(f)[0].args[0][0], 101);
    assert.equal(posts(f)[0].kwargs.message_type, 'whatsapp_message');
    assert.equal(posts(f)[0].kwargs.body, 'Reply through showroom');
    await f.page.evaluate(() => __hubUiTest.selectChannel(102));
    await f.page.locator('#shMessageInput').fill('Reply through second account');
    await f.page.evaluate(() => __hubUiTest.sendCurrentMessage());
    assert.deepEqual(posts(f).map(call => call.args[0][0]), [101, 102]);
    assert.equal(await f.page.locator('#shSelectedWhatsappAccount').textContent(), 'Replying via WhatsApp account #42');
    await f.page.locator('#shWhatsappAccountFilter').selectOption('all');
    assert.deepEqual(await rowIds(f), [101, 102, 103, 104, 105]);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('account identity is visible outside hidden tags and is hidden for livechat and groups', async () => {
  const f = await fresh();
  try {
    const label = f.page.locator('[data-channel-id="101"] .sh-op-list-account');
    assert.equal(await label.getAttribute('data-whatsapp-account'), 'account:41');
    assert.equal(await label.textContent(), 'Via Showroom · #41');
    assert.equal(await label.isVisible(), true);
    assert.equal(await label.evaluate(node => !!node.closest('.sh-op-list-tags')), false);
    assert.equal(await f.page.locator('[data-channel-id="103"] .sh-op-list-account').count(), 0);
    for (const id of [101, 103, 104]) {
      await f.page.evaluate(channelId => __hubUiTest.selectChannel(channelId), id);
      assert.equal(await f.page.locator('#shSelectedWhatsappAccount').isVisible(), id === 101);
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('long untrusted account names render as text without introducing markup', async () => {
  const f = await fresh({ width: 390, height: 844, mobile: true });
  try {
    const name = '<img src=x onerror="window.__accountHtmlExecuted=true">' + ' Long account'.repeat(30);
    await f.page.evaluate(accountName => {
      const h = __hubUiTest;
      h.state.channels[0].wa_account_id = [41, accountName]; h.applyFiltersAndRender();
    }, name);
    const expected = name + ' · #41';
    assert.equal((await accountOptions(f)).find(option => option.value === 'account:41').text, expected);
    const label = f.page.locator('[data-channel-id="101"] .sh-op-list-account');
    assert.equal(await label.textContent(), 'Via ' + expected);
    assert.equal(await label.locator('img,script,svg,[onerror]').count(), 0);
    await f.page.evaluate(() => __hubUiTest.selectChannel(101));
    assert.equal(await f.page.locator('#shSelectedWhatsappAccount').textContent(), 'Replying via ' + expected);
    assert.equal(await f.page.locator('#shSelectedWhatsappAccount img, #shSelectedWhatsappAccount script').count(), 0);
    const layout = await f.page.evaluate(() => ({
      accountBottom: document.getElementById('shSelectedWhatsappAccount').getBoundingClientRect().bottom,
      accountRight: document.getElementById('shSelectedWhatsappAccount').getBoundingClientRect().right,
      contactInfoRight: document.getElementById('shSelectedContactInfo').getBoundingClientRect().right,
      headerBottom: document.querySelector('.sh-op-chat-head').getBoundingClientRect().bottom,
      pageWidth: document.body.scrollWidth,
      viewportWidth: innerWidth
    }));
    assert.ok(layout.accountBottom <= layout.headerBottom, 'Long account identity stays inside the mobile header');
    assert.ok(layout.accountRight <= layout.contactInfoRight, 'Long account identity cannot overlap the call/actions area');
    assert.ok(layout.pageWidth <= layout.viewportWidth, 'Long account identity cannot widen the mobile page');
    assert.equal(await f.page.evaluate(() => window.__accountHtmlExecuted === true), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a vanished account selection resets to All instead of trapping the inbox empty', async () => {
  const f = await fresh();
  try {
    await f.page.locator('#shWhatsappAccountFilter').selectOption('account:42');
    await f.page.evaluate(() => {
      const h = __hubUiTest;
      h.state.channels = h.state.channels.filter(channel => channel.id !== 102); h.applyFiltersAndRender();
    });
    assert.equal(await f.page.locator('#shWhatsappAccountFilter').inputValue(), 'all');
    assert.equal(await f.page.evaluate(() => __hubUiTest.state.whatsappAccountFilter), 'all');
    assert.deepEqual(await rowIds(f), [101, 103, 104, 105]);
    assert.equal((await accountOptions(f)).some(option => option.value === 'account:42'), false);
    assert.equal(posts(f).length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
