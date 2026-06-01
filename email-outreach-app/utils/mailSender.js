const nodemailer = require('nodemailer');

function getTransporter() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = String(process.env.SMTP_SECURE || 'true') === 'true';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error('SMTP is not configured. Please set SMTP_HOST, SMTP_USER and SMTP_PASS in .env');
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass }
  });
}

async function sendTestEmail(to, subject, body) {
  if (!to) throw new Error('Recipient email is required');
  const transporter = getTransporter();
  const fromName = process.env.FROM_NAME || 'Smart Handicrafts';
  const fromEmail = process.env.FROM_EMAIL || process.env.SMTP_USER;

  return transporter.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to,
    subject: subject || 'Smart Handicrafts outreach test',
    text: body || 'This is a test email from SH Global Outreach.',
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827">${String(body || 'This is a test email from SH Global Outreach.').replace(/\n/g, '<br>')}</div>`
  });
}

module.exports = { sendTestEmail };
