import { createHash } from 'node:crypto';

const topics = new Map([
  ['product', 'Product'], ['kit', 'Kit'], ['pricing', 'Pricing'], ['availability', 'Availability'],
  ['custom', 'Custom request'], ['technical', 'Technical question'], ['support', 'Support'], ['other', 'Other']
]);
const nextSteps = new Map([
  ['sales_review', 'Sales review'], ['technical_review', 'Technical review'], ['support_review', 'Support review']
]);
const enquiryFields = [
  ['application', 'Application'], ['power', 'Power'], ['light', 'Light'], ['wattage', 'Wattage'],
  ['quantity', 'Quantity'], ['product', 'Product'], ['summary', 'Summary']
];
const htmlEntities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = value => value.replace(/[&<>"']/g, character => htmlEntities[character]);

function callbackNumber(value) {
  if (typeof value !== 'string' || value.length > 32 || !/^\+?[0-9 ()-]+$/.test(value.trim())) return '';
  const digits = value.replace(/[^0-9]/g, '');
  return /^[1-9][0-9]{6,14}$/.test(digits) ? `+${digits}` : '';
}

function enquiryDetails(value, limit) {
  if (typeof value !== 'string' && !Number.isFinite(value)) return '';
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, limit);
}

function leadValues(session, enquiry) {
  const callReference = session?.providerCallId;
  if (session?.direction !== 'incoming' || typeof callReference !== 'string' || !callReference.trim() ||
      callReference.length > 220 || /[\u0000-\u001f\u007f]/.test(callReference)) return null;
  const phone = callbackNumber(session.verifiedCustomerPhone);
  const topic = topics.get(enquiry?.topic);
  const nextStep = nextSteps.get(enquiry?.nextStep);
  if (!phone || !topic || !nextStep) return null;

  const details = [['Call reference', callReference], ['Topic', topic], ['Next step', nextStep]];
  for (const [field, label] of enquiryFields) {
    const value = enquiryDetails(enquiry[field], field === 'summary' ? 500 : 160);
    if (value) details.push([label, value]);
  }
  return {
    name: `WhatsApp voice enquiry · ${topic}`,
    type: 'lead',
    partner_id: false,
    user_id: false,
    phone,
    description: details.map(([label, value]) => `<p>${label}: ${escape(value)}</p>`).join('')
  };
}

/** A server-only dispatcher. The caller bounds its wait separately from call control.
 * The durable claim grants one create per call and confirms replays only for the same enquiry hash.
 * An unfinished claim is retained because Odoo may have committed the request. */
export function createAiVoiceHandoff({ execute, claim, settle }) {
  return async ({ session, operationId, enquiry }) => {
    const lead = leadValues(session, enquiry);
    if (!lead || typeof operationId !== 'string' || !operationId.trim()) return false;

    const enquiryHash = createHash('sha256').update(JSON.stringify(lead)).digest('hex');
    const receipt = { session, operationId, enquiryHash };
    try {
      const state = await claim(receipt);
      if (state === 'complete') return true;
      if (state !== 'claimed') return false;
    } catch { return false; }

    let leadId;
    try {
      leadId = await execute('crm.lead', 'create', [lead], { context: { tracking_disable: true } });
    } catch {
      // RPC errors may contain customer details or arrive after the lead was saved.
    }

    try {
      if (!Number.isSafeInteger(leadId) || leadId <= 0) {
        await settle({ ...receipt, status: 'uncertain' });
        return false;
      }
      return await settle({ ...receipt, status: 'complete', leadId }) === true;
    } catch { return false; }
  };
}
