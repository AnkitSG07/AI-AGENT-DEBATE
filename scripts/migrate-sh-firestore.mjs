#!/usr/bin/env node
// Explicit CLI only. Never import this module from server.js.
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateKey } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { exportNamespace, importNamespace, verifySource, verifyDestination, validateManifest, verifyBindings } from './sh-firestore-migration.mjs';

const fail = code => { throw Object.assign(new Error(code), { migrationCode: code }); };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const help = `SH Chat Firestore migration (manual maintenance window; never changes Render settings)

  export --project SOURCE --account-file /private/source.json --file /private/export.json --source-paused
  inspect --file /private/export.json
  import --project TARGET --account-file /private/target.json --file /private/export.json --expected-hash SHA256 --source-paused --destination-paused
  verify-source --project SOURCE --account-file /private/source.json --file /private/export.json --source-paused
  verify-target --project TARGET --account-file /private/target.json --file /private/export.json

Account file may be replaced by --account-env SH_ANDROID_FIREBASE_SERVICE_ACCOUNT_JSON
when running inside the existing Render service. It never prints the value.
Optional: --database (default) --prefix sh_operator --rest (HTTP transport). Export files and account files
must be outside this Git repository and private (mode0600). Source and target
writers must stay stopped from export until final source and target verification.
No command switches the app, provisions a database, sends FCM, deletes source
data or overwrites a conflicting target document. A partial import is resumable.
`;

function argumentsOf(argv) {
  const [command, ...values] = argv, args = {};
  if (!['export', 'inspect', 'import', 'verify-source', 'verify-target', 'help'].includes(command)) fail('UNKNOWN_COMMAND');
  const flags = new Set(['source-paused', 'destination-paused', 'rest']);
  const named = new Set(['project', 'database', 'prefix', 'account-file', 'account-env', 'file', 'expected-hash']);
  for (let index = 0; index < values.length; index++) {
    const key = values[index]?.slice(2);
    if (!values[index]?.startsWith('--') || Object.hasOwn(args, key)) fail('INVALID_ARGUMENTS');
    if (flags.has(key)) args[key] = true;
    else if (named.has(key) && values[index + 1] && !values[index + 1].startsWith('--')) args[key] = values[++index];
    else fail('INVALID_ARGUMENTS');
  }
  return { command, args };
}
function outsideRepository(path) {
  const full = resolve(path), rel = relative(repoRoot, full);
  if (!rel || !rel.startsWith('..') && !isAbsolute(rel)) fail('PRIVATE_FILES_MUST_BE_OUTSIDE_REPOSITORY');
  return full;
}
async function readPrivateJson(path, maximum) {
  const full = outsideRepository(path), info = await stat(full);
  if (!info.isFile() || info.size > maximum || (info.mode & 0o077)) fail('PRIVATE_FILE_REQUIRED_MODE_0600');
  try { return JSON.parse(await readFile(full, 'utf8')); } catch { fail('INVALID_PRIVATE_JSON'); }
}
async function clientFor(args) {
  if (!/^[a-z][a-z0-9-]{4,62}$/.test(args.project || '') ||
      !/^(?:\(default\)|[a-z][a-z0-9-]{2,62})$/.test(args.database || '(default)') ||
      !!args['account-file'] === !!args['account-env']) fail('EXPLICIT_PROJECT_AND_ONE_ACCOUNT_SOURCE_REQUIRED');
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.GOOGLE_API_USE_MTLS_ENDPOINT === 'always') fail('ENDPOINT_OVERRIDE_NOT_ALLOWED');
  let account;
  if (args['account-file']) account = await readPrivateJson(args['account-file'], 64 * 1024);
  else {
    if (args['account-env'] !== 'SH_ANDROID_FIREBASE_SERVICE_ACCOUNT_JSON') fail('UNSUPPORTED_ACCOUNT_ENV');
    try { account = JSON.parse(process.env[args['account-env']] || 'null'); } catch { fail('INVALID_ACCOUNT'); }
  }
  try {
    if (account?.type !== 'service_account' || account.project_id !== args.project ||
        typeof account.client_email !== 'string' || !account.client_email.endsWith(`@${args.project}.iam.gserviceaccount.com`) ||
        createPrivateKey(account.private_key).asymmetricKeyType !== 'rsa') fail('ACCOUNT_PROJECT_MISMATCH');
  } catch { fail('INVALID_ACCOUNT_OR_PROJECT'); }
  const identity = { projectId: args.project, databaseId: args.database || '(default)' };
  const client = new Firestore.v1.FirestoreClient({ projectId: identity.projectId, ...(args.rest ? { fallback: true } : {}),
    credentials: { client_email: account.client_email, private_key: account.private_key } });
  const databaseName = `projects/${identity.projectId}/databases/${identity.databaseId}`;
  const documentRoot = databaseName + '/documents';
  return {
    identity,
    async *listCollections(parent) {
      for await (const id of client.listCollectionIdsAsync({ parent: documentRoot + (parent ? '/' + parent : ''), pageSize: 100 }, { timeout: 20000 })) yield id;
    },
    async *listDocuments(path) {
      const parts = path.split('/'), collectionId = parts.pop();
      for await (const document of client.listDocumentsAsync({ parent: documentRoot + (parts.length ? '/' + parts.join('/') : ''),
        collectionId, showMissing: true, pageSize: 100 }, { timeout: 20000 })) yield document;
    },
    async commitCreates(documents) {
      await client.commit({ database: databaseName, writes: documents.map(document => ({ update: document, currentDocument: { exists: false } })) },
        { timeout: 30000, retry: null });
    },
    async close() { await client.close(); }
  };
}

let connection;
try {
  const { command, args } = argumentsOf(process.argv.slice(2));
  if (command === 'help') { process.stdout.write(help); }
  else {
    if (!args.file) fail('PRIVATE_EXPORT_FILE_REQUIRED');
    if (command === 'export') {
      if (!args['source-paused']) fail('STOP_SOURCE_WRITERS_BEFORE_EXPORT');
      connection = await clientFor(args);
      const manifest = await exportNamespace(connection, { prefix: args.prefix || 'sh_operator', sourceWritesPaused: true });
      const path = outsideRepository(args.file);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
      process.stdout.write(JSON.stringify({ command, exported: true, documents: manifest.documents.length,
        collections: manifest.collections.length, manifestHash: manifest.hash, dataHash: manifest.dataHash,
        bindings: verifyBindings(manifest), sourcePause: 'operator-confirmed; keep writers stopped' }) + '\n');
    } else {
      const manifest = validateManifest(await readPrivateJson(args.file, 256 * 1024 * 1024), args['expected-hash']);
      if (command === 'inspect') process.stdout.write(JSON.stringify({ command, valid: true, source: manifest.source,
        prefix: manifest.prefix, documents: manifest.documents.length, collections: manifest.collections.length,
        manifestHash: manifest.hash, dataHash: manifest.dataHash, bindings: verifyBindings(manifest) }) + '\n');
      else {
        connection = await clientFor(args); let result;
        if (command === 'verify-source') result = await verifySource(connection, manifest, { sourceWritesPaused: args['source-paused'] === true });
        else if (command === 'verify-target') result = await verifyDestination(connection, manifest);
        else result = await importNamespace(connection, manifest, { expectedHash: args['expected-hash'],
          sourceWritesPaused: args['source-paused'] === true, destinationWritesPaused: args['destination-paused'] === true });
        process.stdout.write(JSON.stringify({ command, ...result, automaticallySwitched: false }) + '\n');
      }
    }
  }
} catch (error) {
  // Never print SDK errors, stack traces, credentials, document IDs or payloads.
  process.stderr.write(JSON.stringify({ ok: false, code: error?.migrationCode || 'MIGRATION_FAILED_NO_CUTOVER', automaticallySwitched: false }) + '\n');
  process.exitCode = 1;
} finally { try { await connection?.close(); } catch { /* best effort client shutdown */ } }
