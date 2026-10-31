#!/usr/bin/env node
// Keep the self-contained Odoo delivery synchronized with the reviewed helper.
// No service worker or JavaScript file needs to be hosted on the Odoo root.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const file = fileURLToPath(new URL('../integrations/odoo/smart-handicrafts-whatsapp-embed-r13.html', import.meta.url));
const helper = readFileSync(new URL('../public/operator-browser-auth.js', import.meta.url), 'utf8');
const html = readFileSync(file, 'utf8');
const start = '<!-- SH_OPERATOR_AUTH_R13_START -->', end = '<!-- SH_OPERATOR_AUTH_R13_END -->';
if (html.split(start).length !== 2 || html.split(end).length !== 2 || /<\/script/i.test(helper)) throw Error('Unexpected embed helper boundary.');
const from = html.indexOf(start), to = html.indexOf(end, from) + end.length;
const updated = html.slice(0, from) + `${start}\n<script>\n${helper.trim()}\n</script>\n${end}` + html.slice(to);
writeFileSync(file, updated);
writeFileSync(file.replace(/\.html$/, '.txt'), updated);
for (const directory of ['assets', 'assets/simulation']) {
  for (const name of ['operator-browser-auth.js', 'operator-auth.html']) {
    writeFileSync(new URL(`../android/operatorhub/app/src/debug/${directory}/${name}`, import.meta.url),
      readFileSync(new URL(`../public/${name}`, import.meta.url)));
  }
}
console.log('R13 HTML/TXT, inline authorization helper and Android debug auth fixtures are synchronized.');
