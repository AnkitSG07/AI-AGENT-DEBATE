// Bounded, plain-text notification content from a verified Odoo worker record.
// Never logs or returns the source HTML, attachment bytes or arbitrary URLs.
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', ndash: '–', mdash: '—', bull: '•', middot: '·' };

export function notificationText(value, maxBytes, html = false) {
  let text = typeof value === 'string' ? value.slice(0, 16384) : '';
  if (html) text = text.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, entity) => {
      if (entity[0] !== '#') return entities[entity.toLowerCase()] ?? all;
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code) : '';
    });
  text = text.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/gu, ' ').trim();
  let result = '', bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) return result.trimEnd() + '…';
    result += char; bytes += size;
  }
  return result;
}

const label = value => notificationText(Array.isArray(value) ? value[1] : '', 237);
export function messageNotificationPreview(channel, message) {
  const conversation = notificationText(channel.display_name || channel.name || '', 237);
  const sender = label(message.author_id) || label(message.author_guest_id) || label(channel.whatsapp_partner_id) ||
    label(channel.livechat_visitor_id) || conversation || 'Customer';
  let preview = notificationText(message.body, 997, true) || notificationText(message.preview, 997);
  if (!preview) {
    const attachments = [message.attachments, message.attachment_ids].flatMap(value => Array.isArray(value) ? value : []);
    const first = attachments.find(value => value && typeof value === 'object' && !Array.isArray(value));
    const mime = typeof first?.mimetype === 'string' ? first.mimetype : '';
    preview = /^image\//i.test(mime) ? '📷 Photo' : /^audio\//i.test(mime) ? '🎵 Audio message' :
      /^video\//i.test(mime) ? '🎥 Video' : attachments.length ? '📎 Attachment' : 'New message';
  }
  return { sender_name: sender, conversation_name: conversation || sender, message_preview: preview,
    group_conversation: channel.channel_type === 'chat' && channel.is_group === true ? 'true' : 'false' };
}
