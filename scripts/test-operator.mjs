import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Run the published baseline and R12 regressions in separate processes. Each
// suite imports the actual repository production modules, not a copied build.
const cwd = fileURLToPath(new URL('../', import.meta.url));
for (const suite of ['tests/operator-r10.test.mjs', 'tests/operator-r12.test.mjs']) {
  const result = spawnSync(process.execPath, [suite], { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
