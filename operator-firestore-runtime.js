// Server-only configuration. No service-account value enters the APK or embed.
import { createPrivateKey } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { createFirestoreDeviceRegistry } from './operator-firestore-registry.js';

export function createOperatorFirestoreRuntime({
  env = process.env, logger = console, FirestoreClass = Firestore,
  registryFactory = createFirestoreDeviceRegistry
} = {}) {
  const backend = String(env.SH_ANDROID_REGISTRY_BACKEND || 'file').trim().toLowerCase();
  if (backend === 'file') return { backend, configured: false, deviceRegistry: undefined, close: async () => {} };
  const unavailable = () => ({ backend, configured: false, deviceRegistry: undefined, close: async () => {} });
  if (backend !== 'firestore') {
    logger.warn?.('Unknown Android registry backend; native storage will fail closed.');
    return unavailable();
  }
  let firestore;
  try {
    // A production Render process must never send credentials to an emulator.
    // Tests inject their own SDK/client directly, without production environment.
    if (env.FIRESTORE_EMULATOR_HOST || env.GOOGLE_API_USE_MTLS_ENDPOINT === 'always') throw Error('Unsupported endpoint override');
    const account = JSON.parse(env.SH_ANDROID_FIREBASE_SERVICE_ACCOUNT_JSON || 'null');
    const projectId = String(env.SH_ANDROID_FIREBASE_PROJECT_ID || '').trim();
    const databaseId = String(env.SH_OPERATOR_FIRESTORE_DATABASE || '(default)').trim();
    const collectionPrefix = String(env.SH_OPERATOR_FIRESTORE_PREFIX || 'sh_operator').trim();
    if (!/^[a-z][a-z0-9-]{4,62}$/.test(projectId) || account?.type !== 'service_account' ||
        account.project_id !== projectId ||
        typeof account.client_email !== 'string' || !account.client_email.endsWith(`@${projectId}.iam.gserviceaccount.com`) ||
        typeof account.private_key !== 'string' || createPrivateKey(account.private_key).asymmetricKeyType !== 'rsa' ||
        !/^(?:\(default\)|[a-z][a-z0-9-]{2,62})$/.test(databaseId) ||
        !/^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(collectionPrefix)) throw Error('Invalid Firestore configuration');
    firestore = new FirestoreClass({
      projectId, databaseId,
      credentials: { client_email: account.client_email, private_key: account.private_key },
      ignoreUndefinedProperties: false
    });
    const deviceRegistry = registryFactory({
      firestore, collectionPrefix,
      revokedIds: String(env.SH_ANDROID_REVOKED_DEVICE_IDS || '').split(',').map(value => value.trim()).filter(Boolean),
      // An old /tmp registry may already have consumed the env code. An empty
      // Firestore database cannot know that history. Default to no bootstrap;
      // an administrator may issue a new, expiring invitation through the SDK.
      bootstrapEnrollmentCode: env.SH_FIRESTORE_ALLOW_BOOTSTRAP_ENROLLMENT === 'true'
        ? String(env.SH_ANDROID_ENROLLMENT_CODE || '') : ''
    });
    let maintenanceTimer = null, maintenanceRun = null;
    const sweep = () => {
      if (maintenanceRun) return maintenanceRun;
      maintenanceRun = Promise.resolve().then(() => deviceRegistry.pruneExpiredRecoveries({ limit: 100 }))
        .catch(() => logger.warn?.('Android credential replay cleanup will retry after storage recovers.'))
        .finally(() => { maintenanceRun = null; });
      return maintenanceRun;
    };
    return { backend, configured: true, projectId, databaseId, collectionPrefix, deviceRegistry,
      startMaintenance: () => {
        if (maintenanceTimer) return;
        // Startup catch-up plus bounded cleanup. This removes expired encrypted
        // response envelopes only; it never deletes device identities/history.
        void sweep();
        maintenanceTimer = setInterval(sweep, 5 * 60000);
        maintenanceTimer.unref?.();
      },
      close: async () => {
        if (maintenanceTimer) clearInterval(maintenanceTimer);
        maintenanceTimer = null;
        if (maintenanceRun) await maintenanceRun;
        await firestore.terminate();
      } };
  } catch {
    // Never print the SDK/config exception: it can contain credential material.
    logger.warn?.('Android Firestore configuration is unavailable; native storage will fail closed.');
    if (firestore) Promise.resolve(firestore.terminate()).catch(() => {});
    return unavailable();
  }
}
