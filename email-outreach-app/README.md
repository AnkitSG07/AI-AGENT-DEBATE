# Email Outreach App

Standalone single-page email outreach system for Smart Handicrafts / VAIDAHI KALA Private Limited.

This folder is intentionally separate from the existing WhatsApp, AI chat, and call files.

## Purpose

- Import lighting manufacturer leads from CSV
- Review leads in a single-page interface
- Preview outreach emails
- Send test emails
- Start/stop campaign sending
- Track sent, failed, skipped, and unsubscribed leads

## Files

- `server-email.js` - Express backend for the outreach app
- `package-email.json` - Separate package file for this module
- `.env.example` - SMTP and campaign configuration example
- `public/email-outreach.html` - Single-page dashboard UI
- `data/lighting-leads.csv` - Starter lead CSV
- `data/sent-log.json` - Sent email log
- `data/failed-log.json` - Failed email log
- `data/unsubscribed.json` - Unsubscribed email list
- `templates/intro-email.html` - HTML intro email
- `templates/intro-email.txt` - Plain-text intro email
- `utils/csvImporter.js` - CSV importer helper
- `utils/leadValidator.js` - Lead validation helper
- `utils/mailSender.js` - Nodemailer SMTP sender
- `utils/emailQueue.js` - Safe queue sender with duplicate protection

## Run locally

```bash
cd email-outreach-app
cp .env.example .env
npm install --prefix . --package-lock-only
node server-email.js
```

Open:

```txt
http://localhost:5050
```

## Important

Use this only for legitimate B2B outreach to relevant companies. Always include unsubscribe handling and avoid mass spam.
