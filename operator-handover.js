// Explicit Odoo-user routing for AI handovers. A person's display name or a
// device label is never a delivery address. No phone/email recipient is guessed.
import { createHash, randomUUID } from 'node:crypto';

const positive = value => Number.isSafeInteger(value) && value > 0;
const teamKey = value => String(value || '').trim().toLowerCase().replace(/^khushagra$/, 'kushagra');
const escape = value => String(value || '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const m2o = value => Array.isArray(value) ? Number(value[0]) : Number(value);
export function parseHandoverUserIds(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const output = {};
    for (const [name, id] of Object.entries(parsed)) {
      const key = teamKey(name);
      if (!['test','ankit','kushagra','vibhu'].includes(key) || !positive(id) || output[key]) return null;
      output[key] = id;
    }
    return Object.freeze(output);
  } catch { return null; }
}

export function createOdooHandoverDispatcher({ userIdsJson, getFirestore, collectionPrefix = () => 'sh_operator', execute, clock = Date.now } = {}) {
  const users = parseHandoverUserIds(userIdsJson);
  const configuration = () => ({ configured: !!users && Object.keys(users).length > 0 && !!getFirestore?.()?.runTransaction,
    mappingValid: !!users, mappedTeams: users ? Object.keys(users) : [], persistentReceipts: !!getFirestore?.()?.runTransaction });
  const noDelivery = (status, extra = {}) => ({ ok: false, activity_created: false, human_notified: false, status, ...extra });
  async function dispatch({ handoverId, sourceMessageId, channelId, assignedTo, summary, note }) {
    if (!positive(handoverId) || !positive(channelId)) return noDelivery('missing_handover_context');
    const key = teamKey(assignedTo), userId = users?.[key];
    if (!positive(userId)) return noDelivery(users ? 'unmapped_assignee' : 'invalid_assignee_mapping');
    const db = getFirestore?.(), prefix = collectionPrefix();
    if (!db?.runTransaction || !/^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(prefix)) return noDelivery('storage_unavailable');
    let receipt = null;
    try {
      // Only a current internal active Odoo user may receive the activity.
      const userRows = await execute('res.users', 'read', [[userId], ['id','active','share']]);
      const user = userRows?.[0];
      if (Number(user?.id) !== userId || user.active !== true || user.share !== false) return noDelivery('invalid_assignee');
      const fields = await execute('discuss.channel', 'fields_get', [], { attributes: ['type'] });
      const requested = ['id','channel_type','active','whatsapp_partner_id','partner_id','livechat_visitor_id'].filter(name => name === 'id' || fields?.[name]);
      const channels = await execute('discuss.channel', 'read', [[channelId], requested]);
      const channel = channels?.[0];
      if (Number(channel?.id) !== channelId || channel.active === false || !['whatsapp','livechat'].includes(channel.channel_type)) return noDelivery('no_linked_customer');
      let partnerId = channel.channel_type === 'whatsapp' ? m2o(channel.whatsapp_partner_id) : m2o(channel.partner_id);
      if (!positive(partnerId) && channel.channel_type === 'livechat' && positive(m2o(channel.livechat_visitor_id))) {
        const visitorId = m2o(channel.livechat_visitor_id);
        const visitors = await execute('website.visitor', 'read', [[visitorId], ['id','partner_id']]);
        if (Number(visitors?.[0]?.id) === visitorId) partnerId = m2o(visitors[0].partner_id);
      }
      if (!positive(partnerId)) return noDelivery('no_linked_customer');
      const partners = await execute('res.partner', 'read', [[partnerId], ['id','active']]);
      if (Number(partners?.[0]?.id) !== partnerId || partners[0].active === false) return noDelivery('no_linked_customer');
      const models = await execute('ir.model', 'search_read', [[['model','=','res.partner']], ['id','model']], { limit: 1 });
      const types = await execute('ir.model.data', 'search_read', [[['module','=','mail'], ['name','=','mail_activity_data_todo'], ['model','=','mail.activity.type']], ['res_id']], { limit: 1 });
      const modelId = Number(models?.[0]?.id), typeId = Number(types?.[0]?.res_id);
      if (!positive(modelId) || models[0].model !== 'res.partner' || !positive(typeId)) return noDelivery('activity_configuration_unavailable');
      const sourceKey = positive(sourceMessageId) ? `message:${sourceMessageId}` : `handover:${handoverId}`;
      const id = createHash('sha256').update(`${channelId}:${sourceKey}:${key}`).digest('hex'), attemptId = randomUUID();
      const ref = db.collection(`${prefix}_ai_handover_receipts`).doc(id);
      const claim = await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (snap.exists) return { prior: snap.data() };
        const row = { id, attemptId, status: 'processing', handoverId, sourceMessageId: positive(sourceMessageId) ? sourceMessageId : null,
          channelId, partnerId, userId, createdAt: clock(), updatedAt: clock(), deleteAfter: new Date(clock() + 30 * 24 * 3600000) };
        tx.set(ref, row); return { row };
      });
      if (claim.prior) return claim.prior.status === 'complete'
        ? { ok: true, activity_created: true, human_notified: false, status: 'already_created', activity_id: claim.prior.activityId, user_id: claim.prior.userId }
        : noDelivery('activity_outcome_pending');
      receipt = { ref, row: claim.row };
      const activityId = await execute('mail.activity', 'create', [{ res_model_id: modelId, res_id: partnerId,
        activity_type_id: typeId, user_id: userId, summary: String(summary || 'SH AI customer handover').slice(0, 160),
        note: '<p>' + escape(String(note || '').slice(0, 6000)).replace(/\r?\n/g, '<br>') + '</p>',
        date_deadline: new Date(clock()).toISOString().slice(0, 10) }]);
      if (!positive(activityId)) throw new Error('Unconfirmed activity result');
      await db.runTransaction(async tx => {
        const snap = await tx.get(ref), row = snap.data();
        if (!snap.exists || row.attemptId !== attemptId || row.status !== 'processing') throw new Error('Handover receipt changed');
        tx.set(ref, { ...row, status: 'complete', activityId, updatedAt: clock() });
      });
      return { ok: true, activity_created: true, human_notified: false, status: 'created', activity_id: activityId, user_id: userId };
    } catch {
      // Retain a processing receipt if the Odoo request may have committed.
      // Reissuing the action without reconciliation could duplicate it.
      return noDelivery(receipt ? 'activity_outcome_pending' : 'delivery_unavailable');
    }
  }
  return Object.freeze({ configuration, dispatch });
}
