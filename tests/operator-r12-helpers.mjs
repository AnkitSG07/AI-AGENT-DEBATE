// R12 test fixtures recovered from the published R11 regression bundle at
// 8b863b7638acfa8c981c67ca536a0c0c83a46b94. All production imports remain
// external and exercise the actual checkout; providers and storage transport
// are synthetic. FirestoreFake preserves read-before-write and transaction retries.
const __name = value => value;
var clone2 = __name((value) => structuredClone(value), "clone");
var Snapshot2 = class {
  static {
    __name(this, "Snapshot");
  }
  constructor(ref, value) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = value !== void 0;
    this.value = clone2(value);
  }
  data() {
    return clone2(this.value);
  }
};
var Doc = class {
  static {
    __name(this, "Doc");
  }
  constructor(db, path) {
    this.db = db;
    this.path = path;
    this.id = path.split("/").at(-1);
  }
  get() {
    return this.db.get(this);
  }
};
var Query2 = class _Query {
  static {
    __name(this, "Query");
  }
  constructor(db, path, filters = [], count = Infinity, orders = []) {
    Object.assign(this, { db, path, filters, count, orders });
  }
  where(field, operation, value) {
    return new _Query(this.db, this.path, [...this.filters, [field, operation, value]], this.count, this.orders);
  }
  orderBy(field, direction = "asc") {
    return new _Query(this.db, this.path, this.filters, this.count, [...this.orders, [field, direction]]);
  }
  limit(count) {
    return new _Query(this.db, this.path, this.filters, count, this.orders);
  }
  get() {
    return this.db.get(this);
  }
};
var Collection = class extends Query2 {
  static {
    __name(this, "Collection");
  }
  doc(id) {
    if (typeof id !== "string" || !id || id.includes("/")) throw Error("Invalid ID");
    return new Doc(this.db, `${this.path}/${id}`);
  }
};
var FirestoreFake2 = class {
  static {
    __name(this, "FirestoreFake");
  }
  constructor() {
    this.documents = new Map();
    this.versions = new Map();
    this.collectionVersions = new Map();
    this.version = 0;
    this.commits = 0;
    this.transactionRuns = 0;
    this.conflicts = 0;
    this.queries = [];
    this.failReads = null;
    this.failBeforeCommit = null;
    this.failAfterCommit = null;
  }
  collection(path) {
    return new Collection(this, path);
  }
  snapshot(ref, records = this.documents) {
    return new Snapshot2(ref, records.get(ref.path));
  }
  query(query, records = this.documents) {
    const rows2 = [...records].filter(([path, value]) => path.split("/").slice(0, -1).join("/") === query.path && query.filters.every(([field, op, expected]) => {
      const actual = value[field];
      if (actual === void 0) return false;
      if (op === "==") return actual === expected;
      if (op === "<=") return actual <= expected;
      if (op === ">=") return actual >= expected;
      if (op === "<") return actual < expected;
      if (op === ">") return actual > expected;
      throw Error("Unsupported query");
    }));
    rows2.sort(([a, av], [b, bv]) => {
      for (const [field, direction] of query.orders) {
        const comparison = av[field] < bv[field] ? -1 : av[field] > bv[field] ? 1 : 0;
        if (comparison) return direction === "asc" ? comparison : -comparison;
      }
      return a.localeCompare(b);
    });
    const docs = rows2.slice(0, query.count).map(([path]) => this.snapshot(new Doc(this, path), records));
    return { docs, empty: !docs.length, size: docs.length };
  }
  async get(reference) {
    if (this.failReads) throw this.failReads;
    if (reference instanceof Doc) return this.snapshot(reference);
    this.queries.push({ path: reference.path, filters: clone2(reference.filters), limit: reference.count });
    return this.query(reference);
  }
  write(ref, value, remove = false) {
    if (remove) this.documents.delete(ref.path);
    else this.documents.set(ref.path, clone2(value));
    this.versions.set(ref.path, ++this.version);
    this.collectionVersions.set(ref.path.split("/").slice(0, -1).join("/"), this.version);
  }
  seed(collection, id, value) {
    this.write(this.collection(collection).doc(id), value);
  }
  dump() {
    return Object.fromEntries([...this.documents].map(([key2, value]) => [key2, clone2(value)]));
  }
  async runTransaction(callback) {
    for (let attempt = 0; attempt < 30; attempt++) {
      this.transactionRuns++;
      const records = clone2(this.documents), versions = new Map(this.versions), collectionVersions = new Map(this.collectionVersions);
      const reads = new Map(), queries = new Map(), writes = new Map();
      let wrote = false;
      const tx = {
        get: __name(async (reference) => {
          if (wrote) throw Error("Reads must precede native writes");
          if (this.failReads) throw this.failReads;
          if (reference instanceof Doc) {
            reads.set(reference.path, versions.get(reference.path) || 0);
            return this.snapshot(reference, records);
          }
          queries.set(reference.path, collectionVersions.get(reference.path) || 0);
          return this.query(reference, records);
        }, "get"),
        set: __name((ref, value) => {
          wrote = true;
          writes.set(ref.path, { ref, value: clone2(value) });
          return tx;
        }, "set"),
        create: __name((ref, value) => {
          wrote = true;
          writes.set(ref.path, { ref, value: clone2(value), create: true });
          return tx;
        }, "create"),
        delete: __name((ref) => {
          wrote = true;
          writes.set(ref.path, { ref, remove: true });
          return tx;
        }, "delete")
      };
      const result = await callback(tx);
      if ([...reads].some(([path, version]) => (this.versions.get(path) || 0) !== version) || [...queries].some(([path, version]) => (this.collectionVersions.get(path) || 0) !== version)) {
        this.conflicts++;
        continue;
      }
      if (this.failBeforeCommit) {
        const error = this.failBeforeCommit;
        this.failBeforeCommit = null;
        throw error;
      }
      for (const write of writes.values()) if (write.create && this.documents.has(write.ref.path)) throw Error("Already exists");
      for (const write of writes.values()) this.write(write.ref, write.value, write.remove);
      if (writes.size) this.commits++;
      if (this.failAfterCommit) {
        const error = this.failAfterCommit;
        this.failAfterCommit = null;
        throw error;
      }
      return result;
    }
    throw Error("Transaction retry limit");
  }
};

import { CallRuntime } from "../call-runtime/call-runtime.mjs";
import { TransferController } from "../media/transfer-controller.mjs";
import { operatorIdentity, customerIdentity } from "../media/livekit-provider.mjs";
import { createFirestoreMediaStore } from "../media-store/firestore-media-store.mjs";
function deferred2() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
__name(deferred2, "deferred");
function fixture(options = {}) {
  let time = 18e11;
  const effects = [], db = options.db || new FirestoreFake2();
  const devices = new Map(["a", "b", "c"].map((id) => [id, {
    deviceId: id,
    userId: `native:${id}`,
    tenantId: "smart-handicrafts",
    credentialGeneration: 1,
    credentialExpiresAt: time + 36e5,
    nativeBuild: 10,
    mediaProtocol: "sh-room-audio-v1",
    receiveCalls: true,
    revoked: false,
    label: `Phone ${id}`
  }]));
  const actor = __name(async (context) => {
    const row = devices.get(typeof context === "string" ? context : context.device);
    return row ? { ...row, authenticated: true, canCall: true } : null;
  }, "actor");
  const resolveDevice = __name(async (id) => structuredClone(devices.get(id)), "resolveDevice");
  const store = options.store || createFirestoreMediaStore({ firestore: db, clock: __name(() => time, "clock") });
  const provider = {
    kind: "livekit-whatsapp",
    config: { fingerprint: "test-project-only", wsUrl: "wss://test.livekit.cloud" },
    rooms: { listParticipants: __name(async () => [], "listParticipants") },
    probeControlApi: __name(async () => ({ controlApiReachable: true, fingerprint: "test-project-only", audioVerified: false }), "probeControlApi"),
    acceptIncoming: __name(async (data) => {
      effects.push({ kind: "accept", ...data });
      return {
        callId: data.callId,
        roomName: data.roomName,
        customerIdentity: customerIdentity(data.callId)
      };
    }, "acceptIncoming"),
    dialOutgoing: __name(async (data) => {
      effects.push({ kind: "dial", ...data });
      return {
        callId: "call-out-1",
        roomName: data.roomName,
        customerIdentity: customerIdentity(data.requestId)
      };
    }, "dialOutgoing"),
    connectOutgoing: __name(async (data) => {
      effects.push({ kind: "connect", ...data });
    }, "connectOutgoing"),
    issueOperatorJoin: __name(async (data) => ({
      url: "wss://test.livekit.cloud",
      token: "synthetic-test-token",
      roomName: data.roomName,
      identity: operatorIdentity(data.deviceId, data.legId)
    }), "issueOperatorJoin"),
    inspectParticipants: __name(async () => ({
      observedAt: time,
      customerActive: true,
      customerAudioPublished: true,
      operatorActive: true,
      operatorAudioPublished: true,
      sourceActive: true
    }), "inspectParticipants"),
    detachOperator: __name(async (data) => {
      effects.push({ ...data, kind: "detach" });
    }, "detachOperator"),
    terminateCustomer: __name(async (data) => {
      effects.push({ ...data, kind: "terminate" });
    }, "terminateCustomer"),
    ...options.provider
  };
  const proof = __name(({ actor: who, call, transfer }) => ({
    verified: true,
    bidirectionalAudio: true,
    callId: call.id,
    deviceId: who.deviceId,
    identity: transfer?.targetIdentity || call.owner.identity,
    readinessNonce: transfer?.readinessNonce || call.readinessNonce,
    observedAt: time,
    transferId: transfer?.id,
    attemptId: transfer?.attemptId || call.owner.legId
  }), "proof");
  const controller = new TransferController({
    store,
    provider,
    authenticate: actor,
    resolveDevice,
    now: __name(() => time, "now"),
    rolloutGuard: __name(async () => ({
      enabled: true,
      provider: provider.kind,
      clientProtocol: "sh-room-audio-v1",
      liveTwoDeviceEvidenceId: "SYNTHETIC-UNIT-TEST-NOT-LIVE"
    }), "rolloutGuard"),
    verifyReadiness: __name(async (data) => proof(data), "verifyReadiness"),
    verifyProviderEvent: __name(async (data) => data?.runtimeVerifiedMetaEvent?.verified ? { verified: true, type: "terminated", callId: data.runtimeVerifiedMetaEvent.callId } : null, "verifyProviderEvent")
  });
  const runtime = new CallRuntime({
    store,
    provider,
    transferController: controller,
    authenticate: actor,
    resolveDevice,
    listDevices: __name(async () => [...devices.values()], "listDevices"),
    capabilities: __name(async () => ({ roomCalling: true, transferEnabled: true }), "capabilities"),
    verifyReadiness: __name(async (data) => proof(data), "verifyReadiness"),
    rejectIncoming: __name(async (data) => {
      effects.push({ kind: "reject", ...data });
    }, "rejectIncoming"),
    notify: __name(async (data) => {
      effects.push({ kind: "notify", event: data.event });
    }, "notify"),
    phoneNumberId: "business-1",
    minimumNativeBuild: 10,
    now: __name(() => time, "now"),
    ...options.runtime
  });
  controller.verifyReadiness = (data) => runtime.verifyTransferReadiness(data);
  const incoming3 = __name(async (id = "call-in-1") => runtime.ingestVerifiedMetaEvent({
    verified: true,
    eventId: `incoming-${id}`,
    type: "incoming",
    callId: id,
    phoneNumberId: "business-1",
    direction: "incoming",
    customerPhone: "919999999999",
    offerSdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
    occurredAtMs: time
  }), "incoming");
  const accept = __name(async (id = "call-in-1", device = "a") => runtime.accept(device, id, { requestId: "accept-0001" }), "accept");
  const ready = __name(async (accepted, device = "a") => runtime.ready(
    device,
    accepted.call.sessionId,
    { version: accepted.call.version, readinessNonce: accepted.readinessNonce, evidence: { unitTest: true } }
  ), "ready");
  const connected = __name(async () => {
    await incoming3();
    const accepted = await accept();
    return ready(accepted);
  }, "connected");
  return {
    runtime,
    controller,
    store,
    db,
    devices,
    effects,
    provider,
    actor,
    proof,
    incoming: incoming3,
    accept,
    ready,
    connected,
    now: __name(() => time, "now"),
    advance: __name((ms) => {
      time += ms;
    }, "advance")
  };
}
__name(fixture, "fixture");


export { fixture, deferred2 as deferred, FirestoreFake2 as FirestoreFake };

import { generateKeyPairSync } from 'node:crypto';
import { createFirestoreDeviceRegistry } from '../operator-firestore-registry.js';
import { createAndroidPushBridge } from '../operator-android-push.js';
import { createOperatorMediaGateway } from '../operator-media-gateway.js';

// Generated exclusively for offline configuration parsing; never a real account.
const fakePrivateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
export const fakeFcmToken = 'synthetic_fcm_abcdefghijklmnopqrstuvwxyz123456789';
export function registryFixture({ clock = () => 1800000000000, db = new FirestoreFake2(), delivery } = {}) {
  const registry = createFirestoreDeviceRegistry({ firestore: db, clock });
  const env = { SH_ANDROID_PUSH_ENABLED: 'true', SH_ANDROID_REGISTRY_BACKEND: 'firestore',
    SH_ANDROID_FIREBASE_API_KEY: 'AIzaabcdefghijklmnopqrstuvwxyz0123456789',
    SH_ANDROID_FIREBASE_APP_ID: '1:123456789012:android:abc01234',
    SH_ANDROID_FIREBASE_PROJECT_ID: 'sh-test-project', SH_ANDROID_FIREBASE_SENDER_ID: '123456789012',
    SH_ANDROID_FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: 'service_account', project_id: 'sh-test-project',
      private_key: fakePrivateKey, client_email: 'sender@sh-test-project.iam.gserviceaccount.com' }) };
  const deliveries = [], routes = new Map();
  const bridge = createAndroidPushBridge({ env, deviceRegistry: registry, clock, readCall: async () => null,
    logger: { warn() {} }, delivery: delivery || (async (device, data) => { deliveries.push({ device, data }); return { ok: true }; }),
    retryDelay: async () => {} });
  bridge.registerRoutes({ get: (path, fn) => routes.set(`GET ${path}`, fn), post: (path, fn) => routes.set(`POST ${path}`, fn) });
  const request = async (method, path, body = {}, bearer = '', headers = {}) => {
    const result = { status: 200, headers: {} };
    const res = { setHeader: (name, value) => { result.headers[name] = value; },
      status(code) { result.status = code; return this; }, json(value) { result.body = value; return this; } };
    await routes.get(`${method} ${path}`)({ method, body, ip: 'offline-test', headers: {
      ...headers, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } }, res);
    return result;
  };
  const enroll = async (suffix = '0000000000000001', metadata = { nativeBuild: 12, mediaProtocol: 'sh-room-audio-v1' }) => {
    const invitation = await registry.issueEnrollment({ label: `Phone ${suffix.slice(-1)}` });
    const body = { installationId: `install_${suffix}`, requestId: `request_${suffix}`, fcmToken: `${fakeFcmToken}_${suffix}`,
      enrollmentCode: invitation.enrollmentCode, deviceLabel: 'Device model', ...metadata };
    return { result: await request('POST', '/api/operator-android/devices/register', body), body };
  };
  return { registry, bridge, db, env, request, enroll, deliveries };
}

export function gatewayFixture(f, { onCallState = async () => {}, publishRoomEvent = async () => {} } = {}) {
  return createOperatorMediaGateway({ env: { WHATSAPP_PHONE_NUMBER_ID: 'business-1', META_WHATSAPP_APP_SECRET: 'offline-secret',
    SH_NATIVE_CALLS_ENABLED: 'true' }, firestoreRuntime: { firestore: {}, collectionPrefix: 'sh_test', deviceRegistry: {} },
    storeFactory: () => f.store, runtimeFactory: args => {
      f.runtime.notify = args.notify; f.runtime.onWorkAvailable = args.onWorkAvailable;
      return { runtime: f.runtime, controller: f.controller, verifyConfiguration: async () => ({ controlApiReachable: true }) };
    }, pushBridge: { publishRoomEvent }, onCallState, logger: { warn() {} }, now: f.now });
}
