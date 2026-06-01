function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function clean(value) {
  return String(value || '').trim();
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function validateLead(row = {}) {
  const lead = {
    companyName: clean(row.companyName || row.company || row.Company || row['Company Name']),
    website: clean(row.website || row.Website || row.url || row.URL),
    country: clean(row.country || row.Country),
    email: normalizeEmail(row.email || row.Email || row.contactEmail || row['Contact Email']),
    contactName: clean(row.contactName || row.name || row.Name || row['Contact Name']),
    category: clean(row.category || row.Category || 'Lighting Manufacturer'),
    notes: clean(row.notes || row.Notes),
    sourceUrl: clean(row.sourceUrl || row.Source || row['Source URL'])
  };

  if (!lead.companyName) return { valid: false, error: 'Company name is required', ...lead };
  if (!isEmail(lead.email)) return { valid: false, error: 'Valid email is required', ...lead };
  if (!lead.country) lead.country = 'Unknown';
  if (!lead.category) lead.category = 'Lighting Manufacturer';

  return { valid: true, status: 'verified-public-source', ...lead };
}

module.exports = { normalizeEmail, validateLead, isEmail };
