#!/usr/bin/env node
// Reproducible local verification. This script never deploys, calls customers,
// enrolls devices, obtains production credentials, or signs a release.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, relative, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
if (Number(process.versions.node.split('.')[0]) !== 24) throw Error('R13 verification requires Node24, matching .node-version and Render.');
const groups = {
  unit: [
    'tests/operator-r10.test.mjs', 'tests/operator-r12.test.mjs',
    'reporting/test/operator-reporting.test.mjs', 'operator-browser-auth.test.mjs',
    'tests/operator-call-security.test.mjs', 'tests/operator-ai-r13.test.mjs',
    'tests/operator-call-permission.test.mjs',
    'tests/operator-call-latency.test.mjs',
    'tests/operator-message-preview.test.mjs',
    'tests/operator-fcm-delivery-contract.test.mjs',
    'tests/operator-registry-latency.test.mjs',
    'tests/operator-call-critical-path.test.mjs',
    'tests/operator-recovery-coalescing.test.mjs',
    'tests/operator-transaction-batching.test.mjs',
    'tests/operator-database-location.test.mjs',
    'tests/operator-call-parallel-lookup.test.mjs',
    'tests/operator-call-room-policy.test.mjs',
    'tests/operator-call-invite-auth.test.mjs',
    'tests/hosting-preflight.test.mjs',
    'tests/hosting-proxy.test.mjs',
    'tests/operator-app-message-state.test.mjs',
    'tests/operator-native-message-worker.test.mjs',
    'tests/operator-keep-alive.test.mjs',
    'tests/simulator-media-r13/provider-revocation.test.mjs',
    'tests/simulator-media-r13/answer-contention.test.mjs',
    'tests/simulator-media-r13/startup-audio-readiness.test.mjs',
    'tests/simulator-media-r13/device-availability.test.mjs',
    'integrations/odoo/tests/preservation-r12.test.cjs',
    'integrations/odoo/tests/r13/workflow-races.test.cjs',
    'integrations/odoo/tests/r13/app-unread.test.cjs',
    'integrations/odoo/tests/legacy-hub-r12.test.cjs',
    'integrations/odoo/tests/frontend-transfer-r9.test.cjs',
    'integrations/odoo/tests/android-transfer-guard.test.cjs'
  ],
  http: ['tests/operator-private-integration.test.mjs'],
  browser: ['android/operatorhub/test-native-room-bridge.cjs',
    'integrations/odoo/tests/native-embed-r12.test.cjs',
    'integrations/odoo/tests/hub-ui-r12.test.cjs', 'integrations/odoo/tests/transport-r12.test.cjs',
    'integrations/odoo/tests/notification-setup-r12.test.cjs',
    'integrations/odoo/tests/r13/workflow-browser.test.cjs'],
  firestore: ['tests/operator-r12-emulator.test.mjs', 'tests/operator-ai-r13-emulator.test.mjs'],
  media: ['tests/simulator-media-r13/real-media.test.mjs']
};
const requested = process.argv.slice(2);
const selected = requested.length ? requested : ['unit', 'http', 'browser'];
for (const name of selected) if (!groups[name]) throw Error(`Unknown group ${name}; choose ${Object.keys(groups).join(', ')}.`);
if (selected.includes('media') && process.env.SH_R13_REAL_MEDIA_TESTS !== '1') throw Error('Media tests require SH_R13_REAL_MEDIA_TESTS=1; see simulator README.');
if (selected.includes('firestore') && (process.env.SH_R12_EMULATOR_TESTS !== '1' || process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8089')) throw Error('Firestore tests require the explicit localhost8089 emulator opt-in.');
const out = resolve(process.env.SH_VERIFY_OUTPUT || join(root, 'verification/r13/current'));
mkdirSync(out, { recursive: true });
const embed = resolve(root, 'integrations/odoo/smart-handicrafts-whatsapp-embed-r13.html');
const textCopy = embed.replace(/\.html$/, '.txt');
if (!readFileSync(embed).equals(readFileSync(textCopy))) throw Error('The shipped HTML and pasteable TXT must be byte-identical.');
for (const name of ['operator-browser-auth.js', 'operator-auth.html']) {
  const actual = readFileSync(join(root, 'public', name));
  const fixture = readFileSync(join(root, 'android/operatorhub/app/src/debug/assets/simulation', name));
  if (!actual.equals(fixture)) throw Error(`The Android auth fixture differs from the production ${name}; run sync-hub-r13.mjs.`);
}

const ignored = new Set(['node_modules','.git','.gradle','build','verification','evidence','workflow-evidence','ui-r12-evidence','__pycache__']);
function sourceHashes() {
  const hashes = {};
  const walk = directory => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      // The requirements map is a generated evidence report, not an executable
      // test input. It is finalized from these results and covered by the Git
      // release tree and artifact manifest, just like other verification reports.
      if (ignored.has(item.name) || item.name === 'requirements-evidence.json' || /(?:results|verification|manifest)\.json$/i.test(item.name)) continue;
      const file = join(directory, item.name);
      if (item.isDirectory()) walk(file);
      else if (item.isFile() && /\.(?:[cm]?js|html|txt|java|kt|xml|gradle|properties|json|ya?ml|py|sh)$/.test(extname(file)))
        hashes[relative(root, file)] = createHash('sha256').update(readFileSync(file)).digest('hex');
    }
  };
  // Include all source/tests in the repository, excluding generated evidence.
  walk(root);
  return Object.fromEntries(Object.entries(hashes).sort(([a],[b]) => a.localeCompare(b)));
}
const startHashes = sourceHashes(), started = new Date().toISOString();
const report = { release: 'r13', started, node: process.version, platform: process.platform,
  groups: selected, environment: 'Local isolated verification; external services are substituted except explicitly local media/Firestore.',
  liveCustomerActions: false, suites: [], sourceHashes: startHashes };
let failed = false;
for (const group of selected) for (const suite of groups[group]) {
  const label = suite.replaceAll('/', '__');
  const at = Date.now();
  const result = spawnSync(process.execPath, ['--test-reporter=tap', suite], {
    cwd: root, env: { ...process.env, SH_TEST_EMBED: embed }, encoding: 'utf8',
    timeout: group === 'media' ? 900000 : 300000, maxBuffer: 32 * 1024 * 1024
  });
  const output = (result.stdout || '') + (result.stderr || '') + (result.error ? '\n' + result.error.message + '\n' : '');
  writeFileSync(join(out, label + '.tap'), output);
  const metric = name => { const m = output.match(new RegExp('^# ' + name + ' (\\d+)$', 'm')); return m ? Number(m[1]) : null; };
  const pass = metric('pass') ?? (output.match(/^PASS /gm) || []).length;
  const fail = metric('fail') ?? (output.match(/^FAIL /gm) || []).length;
  const skipped = metric('skipped') ?? 0;
  const ok = !result.error && result.status === 0 && fail === 0 && pass > 0 && skipped === 0;
  failed ||= !ok;
  const row = { group, suite, ok, exitCode: result.status, signal: result.signal,
    ...(result.error ? { executionError: { code: result.error.code, message: result.error.message } } : {}),
    tests: metric('tests') ?? pass + fail, pass, fail, skipped, durationMs: Date.now() - at,
    log: label + '.tap', logSha256: createHash('sha256').update(output).digest('hex') };
  report.suites.push(row);
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${suite}: ${pass} passed, ${fail} failed, ${skipped} skipped\n`);
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
const finalHashes = sourceHashes();
report.changedDuringRun = [...new Set([...Object.keys(startHashes), ...Object.keys(finalHashes)])]
  .filter(file => startHashes[file] !== finalHashes[file]);
report.completed = new Date().toISOString();
report.pass = report.suites.reduce((n, s) => n + s.pass, 0);
report.fail = report.suites.reduce((n, s) => n + s.fail, 0);
report.ok = !failed && report.changedDuringRun.length === 0;
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify({ ok: report.ok, pass: report.pass, fail: report.fail,
  changedDuringRun: report.changedDuringRun, report: join(out, 'report.json') }) + '\n');
if (!report.ok) process.exitCode = 1;
