#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import net from 'node:net';

const root = fileURLToPath(new URL('../', import.meta.url));
const jar = process.env.SH_FIRESTORE_EMULATOR_JAR || resolve(root, '../tooling/r13-media/cloud-firestore-emulator-v1.19.8.jar');
if (!existsSync(jar)) throw Error('Run python tests/simulator-media-r13/prepare-tools.py first.');
const out = resolve(process.env.SH_VERIFY_OUTPUT || resolve(root, 'verification/r13/current'));
mkdirSync(out, { recursive: true });
// Never attach to an unknown listener and never use a cloud Firestore hostname.
await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(8089, '127.0.0.1', () => probe.close(resolve));
});
const log = createWriteStream(resolve(out, 'firestore-emulator.log'));
const emulator = spawn(process.env.SH_TEST_JAVA || 'java', ['-Xms64m', '-Xmx512m', '-jar', jar,
  '--host=127.0.0.1', '--port=8089', '--project_id=demo-sh-operator-r12'], {
  cwd: root, env: { PATH: process.env.PATH, JAVA_HOME: process.env.JAVA_HOME }, stdio: ['ignore','pipe','pipe']
});
emulator.stdout.pipe(log, { end: false }); emulator.stderr.pipe(log, { end: false });
let run, emulatorError;
emulator.on('error', error => { emulatorError = error; });
const stop = () => { run?.kill('SIGTERM'); emulator.kill('SIGTERM'); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  const deadline = Date.now() + 60000;
  for (;;) {
    if (emulatorError) throw emulatorError;
    if (emulator.exitCode !== null) throw Error('Firestore emulator exited before startup. See firestore-emulator.log.');
    try { await fetch('http://127.0.0.1:8089', { signal: AbortSignal.timeout(1000) }); break; } catch {}
    if (Date.now() > deadline) throw Error('Firestore emulator startup timed out.');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  run = spawn(process.execPath, ['scripts/verify-r13.mjs', 'firestore'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, SH_R12_EMULATOR_TESTS: '1',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8089', METADATA_SERVER_DETECTION: 'none' }
  });
  process.exitCode = await new Promise((resolve, reject) => { run.once('error', reject); run.once('exit', code => resolve(code ?? 1)); });
} finally {
  emulator.kill('SIGTERM');
  await new Promise(resolve => { if (emulator.exitCode !== null) return resolve();
    const timer = setTimeout(() => { emulator.kill('SIGKILL'); resolve(); }, 3000);
    emulator.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  log.end();
}
