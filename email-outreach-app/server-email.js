require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { importCsvFile } = require('./utils/csvImporter');
const { validateLead, normalizeEmail } = require('./utils/leadValidator');
const { sendTestEmail } = require('./utils/mailSender');

const app = express();
const upload = multer({ dest: path.join(__dirname, 'data', 'uploads') });
const PORT = Number(process.env.PORT || 5050);

const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const files = {
  leads: path.join(DATA_DIR, 'leads.json'),
  campaigns: path.join(DATA_DIR, 'campaigns.json'),
  sent: path.join(DATA_DIR, 'sent-log.json'),
  failed: path.join(DATA_DIR, 'failed-log.json'),
  unsubscribed: path.join(DATA_DIR, 'unsubscribed.json'),
  activity: path.join(DATA_DIR, 'activity-log.json')
};

function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
  Object.values(files).forEach((file) => {
    if (!fs.existsSync(file)) fs.writeFileSync(file, '[]');
  });
}
function readJson(file) {
  ensureStore();
  try { return JSON.parse(fs.readFileSync(file, 'utf8') || '[]'); } catch { return []; }
}
function writeJson(file, data) {
  ensureStore();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function logActivity(type, message, meta = {}) {
  const log = readJson(files.activity);
  log.unshift({ id: Date.now().toString(), type, message, meta, createdAt: new Date().toISOString() });
  writeJson(files.activity, log.slice(0, 300));
}

ensureStore();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'email-outreach.html')));

app.get('/api/summary', (req, res) => {
  const leads = readJson(files.leads);
  const sent = readJson(files.sent);
  const failed = readJson(files.failed);
  const unsubscribed = readJson(files.unsubscribed);
  const campaigns = readJson(files.campaigns);
  res.json({ totalLeads: leads.length, usableLeads: leads.filter(l => l.status !== 'invalid').length, sent: sent.length, failed: failed.length, unsubscribed: unsubscribed.length, campaigns: campaigns.length });
});

app.get('/api/leads', (req, res) => {
  const { q = '', country = '', category = '' } = req.query;
  let leads = readJson(files.leads);
  if (q) leads = leads.filter(l => JSON.stringify(l).toLowerCase().includes(String(q).toLowerCase()));
  if (country) leads = leads.filter(l => String(l.country || '').toLowerCase() === String(country).toLowerCase());
  if (category) leads = leads.filter(l => String(l.category || '').toLowerCase() === String(category).toLowerCase());
  res.json(leads.slice(0, 1000));
});

app.post('/api/leads/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'CSV file is required' });
  const imported = await importCsvFile(req.file.path);
  const existing = readJson(files.leads);
  const byEmail = new Map(existing.map(l => [normalizeEmail(l.email), l]));
  let added = 0, skipped = 0, invalid = 0;
  for (const row of imported) {
    const lead = validateLead(row);
    if (!lead.valid) { invalid++; continue; }
    const key = normalizeEmail(lead.email);
    if (byEmail.has(key)) { skipped++; continue; }
    const saved = { ...lead, id: Date.now().toString() + '-' + Math.random().toString(16).slice(2), stage: 'new', createdAt: new Date().toISOString() };
    byEmail.set(key, saved);
    existing.push(saved);
    added++;
  }
  writeJson(files.leads, existing);
  logActivity('import', `Imported ${added} new leads`, { added, skipped, invalid });
  res.json({ ok: true, added, skipped, invalid, total: existing.length });
});

app.post('/api/leads', (req, res) => {
  const lead = validateLead(req.body || {});
  if (!lead.valid) return res.status(400).json({ ok: false, error: lead.error });
  const leads = readJson(files.leads);
  if (leads.some(l => normalizeEmail(l.email) === normalizeEmail(lead.email))) return res.status(409).json({ ok: false, error: 'Lead already exists' });
  const saved = { ...lead, id: Date.now().toString(), stage: 'new', createdAt: new Date().toISOString() };
  leads.unshift(saved);
  writeJson(files.leads, leads);
  logActivity('lead', `Added ${saved.companyName}`);
  res.json({ ok: true, lead: saved });
});

app.get('/api/campaigns', (req, res) => res.json(readJson(files.campaigns)));
app.post('/api/campaigns', (req, res) => {
  const campaigns = readJson(files.campaigns);
  const campaign = { id: Date.now().toString(), name: req.body.name || 'Lighting Manufacturers Outreach', subject: req.body.subject || 'Rechargeable smart lighting integration for your lamp collections', template: req.body.template || 'intro', status: 'planned', dailyLimit: Number(req.body.dailyLimit || 25), createdAt: new Date().toISOString() };
  campaigns.unshift(campaign);
  writeJson(files.campaigns, campaigns);
  logActivity('campaign', `Planned campaign ${campaign.name}`);
  res.json({ ok: true, campaign });
});

app.post('/api/test-email', async (req, res) => {
  try {
    const result = await sendTestEmail(req.body.to, req.body.subject, req.body.body);
    logActivity('email', `Sent test email to ${req.body.to}`);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/logs', (req, res) => res.json({ sent: readJson(files.sent).slice(0, 200), failed: readJson(files.failed).slice(0, 200), activity: readJson(files.activity).slice(0, 200), unsubscribed: readJson(files.unsubscribed) }));
app.post('/api/unsubscribe', (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (!email) return res.status(400).json({ ok: false, error: 'Email required' });
  const list = readJson(files.unsubscribed);
  if (!list.some(x => normalizeEmail(x.email) === email)) list.unshift({ email, createdAt: new Date().toISOString() });
  writeJson(files.unsubscribed, list);
  logActivity('unsubscribe', `${email} added to unsubscribe list`);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`SH Global Outreach running at http://localhost:${PORT}`));
