import { id, MIME_XLSX, requireValue, ReportError, sha256 } from './schema.mjs';

/** Inject the existing authenticated backend execute_kw helper. No credentials
 * are read here. Parent attachment record must be selected by server config. */
export function createOdooArchiveAdapter({ execute, parent } = {}) {
  requireValue(typeof execute === 'function' && parent?.model === 'res.company' && Number.isSafeInteger(parent.id) && parent.id > 0,
    'ARCHIVE_NOT_CONFIGURED', 'A verified company record and server Odoo RPC adapter are required.', 503);
  async function put({ name, mimeType, bytes, exportId, sha256: expectedHash }) {
    requireValue(id(exportId) && /^sh-history-[a-f0-9-]+\.(xlsx|manifest\.json)$/.test(name) &&
      [MIME_XLSX, 'application/json'].includes(mimeType) && bytes instanceof Uint8Array && bytes.length <= 10 * 1024 * 1024 && sha256(bytes) === expectedHash,
    'INVALID_ARCHIVE', 'Only an exact bounded report workbook or manifest may be archived.');
    const marker = `SH Operator export ${exportId}; sha256=${expectedHash}`;
    const prior = await execute('ir.attachment', 'search_read', [[['name', '=', name], ['description', '=', marker],
      ['res_model', '=', parent.model], ['res_id', '=', parent.id], ['public', '=', false]]], { fields: ['id'], limit: 2 });
    let attachmentId = Array.isArray(prior) && Number.isSafeInteger(prior[0]?.id) ? prior[0].id : null;
    if (!attachmentId) attachmentId = await execute('ir.attachment', 'create', [{ name, type: 'binary', mimetype: mimeType,
      datas: Buffer.from(bytes).toString('base64'), description: marker, public: false, res_model: parent.model, res_id: parent.id }]);
    requireValue(Number.isSafeInteger(attachmentId) && attachmentId > 0, 'ARCHIVE_UNAVAILABLE', 'Odoo did not return an archive attachment ID.', 503);
    return { provider: 'odoo-ir-attachment', id: attachmentId, name, mimeType, sha256: expectedHash };
  }
  async function read(locator) {
    requireValue(locator?.provider === 'odoo-ir-attachment' && Number.isSafeInteger(locator.id) && locator.id > 0,
      'INVALID_ARCHIVE', 'An exact private archive attachment is required.');
    const rows = await execute('ir.attachment', 'read', [[locator.id], ['id', 'name', 'datas', 'mimetype', 'file_size', 'public', 'res_model', 'res_id']],
      { context: { bin_size: false } });
    const row = rows?.[0];
    requireValue(row && row.id === locator.id && row.name === locator.name && row.mimetype === locator.mimeType && row.public === false &&
      row.res_model === parent.model && row.res_id === parent.id && typeof row.datas === 'string' && row.datas.length <= 14 * 1024 * 1024,
    'ARCHIVE_VERIFICATION_FAILED', 'The private Odoo archive attachment no longer matches its expected scope.', 502);
    const encoded = row.datas.replace(/\s/g, '');
    requireValue(/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) && encoded.length % 4 === 0, 'ARCHIVE_VERIFICATION_FAILED', 'Odoo returned invalid archive bytes.', 502);
    const bytes = Buffer.from(encoded, 'base64');
    requireValue(bytes.length === row.file_size && sha256(bytes) === locator.sha256, 'ARCHIVE_VERIFICATION_FAILED', 'Odoo archive bytes failed integrity verification.', 502);
    return bytes;
  }
  return Object.freeze({ durable: true, kind: 'odoo-ir-attachment', put, read });
}
