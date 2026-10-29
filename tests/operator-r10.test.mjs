/**
 * SH Chat R10/R11: 245 unit tests against the repository's actual production modules.
 * Generated with esbuild 0.28.2; Node 18 ESM; no minification.
 * Run from the repository: node --test tests/operator-r10.test.mjs
 * Only test registrations and local fixtures are bundled. Production modules,
 * LiveKit and Firestore packages remain external; no production code is mirrored.
 * Original source sections and portable import.meta.url semantics are retained.
 * The source-inspection tests read the deployed repository/server.js at run time.
 * Provider effects and storage are fixtures; this is not a live audio test.
 *
 * Regenerated-from manifest (repository path | SHA-256):
 * call-runtime/test/helpers.mjs | d5c8b843dd69e03b5a7035e480f0180a90c06d3d2f41fcf72559f004ba021d67
 * call-runtime/test/readiness.test.mjs | 0615d5bc3492d570bc7a85474401e7cbbc245f337249e2519305cd72b6678d21
 * call-runtime/test/routes.test.mjs | b3f98ff37197db89e13cf4c20f7245e68f543cb675a0f11635a105d3c638491d
 * call-runtime/test/runtime.test.mjs | 7c78db590b734b1fbdd070f40cc825cd5984df021692f6d2da80b72e2f7b860a
 * call-runtime/test/startup.test.mjs | 5222775402617a250d6c11ff7815720e48d5c23c350a4ddb4b6eb038487d8237
 * media-store/test/firestore-fake.mjs | 567af2e7a81bef4c5bc094b0497770e477c71d8aebcf93eff8878528ed73085f
 * media-store/test/firestore-media-store.test.mjs | ef0a7cb596c65ec58ba76747d8b6c2d783a3271d66ed36311df188199c600a73
 * media/test/helpers.mjs | 4ae7d800a1303020e0a01a8d4ff42a6f0a247edd05a2445701d4de8e9a7c7a24
 * media/test/provider.test.mjs | 99e5a76057b9dc2aef4096fca3839fa7b419d5c70f03f294e57bc30d156b2b69
 * media/test/transfer.test.mjs | 2adb5f6a4961a3a395d4d8a941cb4cddda2cba0743c011b6789364545c98f2d1
 * tests/operator-firestore-runtime.test.mjs | a7e8e8afcf81633d0283f30830d0abab43604b1a225852f42510563182a3c8f4
 * tests/operator-gateway.test.mjs | 72c5f1204477cb7af0ae946019d2c01980ec3b8dd5af86b7bcacef0442a091ad
 * tests/operator-storage/bridge-test-helpers.js | 3d11f441adce0dc11aefb78b36c032f720541586b7d494416d2df6b5b26c8ae5
 * tests/operator-storage/firestore-fake.js | 70952d42298a1f802c8eb9551ada07af8f849cb135fd955f8a879c89b6971d81
 * tests/operator-storage/firestore-integration.test.js | 5c40b65f58f289825aa665193ada8b1e36c9da9e30332867919e80201ee7ec10
 * tests/operator-storage/notification-registry.test.js | d695c71eea2c6ec5273c295d33fffe32b26ad32f1ae50bdbd702c2756141e447
 * tests/operator-storage/operator-android-push.test.js | f2312ab7a834bf1d30dc308dde77dc667fbb52289dbc0a06e59550ae549f953e
 * tests/operator-storage/operator-firestore-registry.test.js | 38538c9925d1d18f343a9fc3781a9dfe026271923991c48df096214fbc597f78
 */
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// tests/operator-storage/bridge-test-helpers.js
/*! SOURCE tests/operator-storage/bridge-test-helpers.js | SHA-256 3d11f441adce0dc11aefb78b36c032f720541586b7d494416d2df6b5b26c8ae5 */
import assert from "node:assert/strict";
import { generateKeyPairSync, createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAndroidPushBridge } from "../operator-android-push.js";
var privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
var CODE = "sh_test_enrollment_1234567890abcdefghijklmnop";
var TOKEN = "fcm_test_abcdefghijklmnopqrstuvwxyz1234567890";
var NOW = 17931888e5;
var BASE = "/api/operator-android";
var BEARER = "android_test_device_1234567890.test_bearer_abcdefghijklmnopqrstuvwxyz";
var digest = /* @__PURE__ */ __name((value) => createHash("sha256").update(value).digest("hex"), "digest");
var makeEnv = /* @__PURE__ */ __name(() => ({
  SH_ANDROID_PUSH_ENABLED: "true",
  SH_ANDROID_FIREBASE_API_KEY: "AIzaabcdefghijklmnopqrstuvwxyz0123456789",
  SH_ANDROID_FIREBASE_APP_ID: "1:123456789012:android:abc01234",
  SH_ANDROID_FIREBASE_PROJECT_ID: "sh-test-project",
  SH_ANDROID_FIREBASE_SENDER_ID: "123456789012",
  SH_ANDROID_ENROLLMENT_CODE: CODE,
  SH_ANDROID_FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
    type: "service_account",
    project_id: "sh-test-project",
    private_key: privateKey,
    client_email: "sender@sh-test-project.iam.gserviceaccount.com"
  })
}), "makeEnv");
var incoming = /* @__PURE__ */ __name((change = {}) => ({
  call_id: "call_1",
  direction: "incoming",
  status: "incoming_ringing",
  active: true,
  answerable: true,
  started_at: new Date(NOW - 1e3).toISOString(),
  updated_at: new Date(NOW).toISOString(),
  ...change
}), "incoming");
var nativeDevice = /* @__PURE__ */ __name((change = {}) => ({
  id: "android_test_device_1234567890",
  installationId: "install_1234567890abcdef",
  tokenHash: digest(BEARER),
  tokenExpiresAt: NOW + 30 * 864e5,
  fcmToken: TOKEN,
  createdAt: NOW,
  receiveCalls: true,
  receiveChats: true,
  revokedAt: 0,
  ...change
}), "nativeDevice");
var inboundMessage = /* @__PURE__ */ __name(() => ({
  verifiedIncoming: true,
  channel: { id: 123, channel_type: "whatsapp" },
  message: { id: 456, model: "discuss.channel", res_id: 123, date: new Date(NOW).toISOString(), body: "Private test body" }
}), "inboundMessage");
async function harness(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sh-r10-notifications-"));
  const devicesPath = options.devicesPath || join(dir, "devices.json");
  let now = NOW, call = incoming();
  const sent = [], routes = /* @__PURE__ */ new Map();
  const bridge = createAndroidPushBridge({
    env: options.env || makeEnv(),
    devicesPath,
    deviceRegistry: options.deviceRegistry,
    clock: options.clock || (() => now),
    logger: { warn() {
    } },
    readCall: options.readCall || (async (id) => call?.call_id === id ? call : null),
    delivery: options.delivery || (options.fetchImpl ? void 0 : async (device, data) => {
      sent.push({ device, data });
      return { ok: true };
    }),
    fetchImpl: options.fetchImpl,
    retryDelay: options.retryDelay || (async () => {
    })
  });
  bridge.registerRoutes({ get: /* @__PURE__ */ __name((path, fn) => routes.set(`GET ${path}`, fn), "get"), post: /* @__PURE__ */ __name((path, fn) => routes.set(`POST ${path}`, fn), "post") });
  const request = /* @__PURE__ */ __name(async (method, path, body = {}, bearer = "") => {
    const key2 = path.startsWith(`${BASE}/calls/`) ? `${BASE}/calls/:callId` : path;
    const fn = routes.get(`${method} ${key2}`);
    assert.ok(fn, `registered ${method} ${key2}`);
    const result = { status: 200, headers: {} };
    const res = {
      setHeader: /* @__PURE__ */ __name((key3, value) => {
        result.headers[key3] = value;
      }, "setHeader"),
      status(value) {
        result.status = value;
        return this;
      },
      json(value) {
        result.body = value;
        return this;
      }
    };
    await fn({
      body,
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      params: { callId: decodeURIComponent(path.slice(`${BASE}/calls/`.length)) },
      ip: "test-peer"
    }, res);
    return result;
  }, "request");
  const register = /* @__PURE__ */ __name((extra) => request("POST", `${BASE}/devices/register`, {
    installationId: "install_1234567890abcdef",
    fcmToken: TOKEN,
    enrollmentCode: CODE,
    deviceLabel: "Test Android",
    ...extra
  }), "register");
  return { bridge, request, register, sent, devicesPath, setNow: /* @__PURE__ */ __name((value) => {
    now = value;
  }, "setNow"), setCall: /* @__PURE__ */ __name((value) => {
    call = value;
  }, "setCall") };
}
__name(harness, "harness");

// tests/operator-storage/notification-registry.test.js
/*! SOURCE tests/operator-storage/notification-registry.test.js | SHA-256 d695c71eea2c6ec5273c295d33fffe32b26ad32f1ae50bdbd702c2756141e447 */
import test from "node:test";
import assert2 from "node:assert/strict";
import { readFile, writeFile, access } from "node:fs/promises";
test("configured Firestore without an adapter never enrolls or reads a fallback registry", async () => {
  const legacy = await harness(), enrolled = await legacy.register();
  const h = await harness({ devicesPath: legacy.devicesPath, env: { ...makeEnv(), SH_ANDROID_REGISTRY_BACKEND: "firestore" } });
  assert2.equal((await h.request("GET", `${BASE}/calls/call_1`, {}, enrolled.body.deviceToken)).status, 503);
  assert2.equal((await h.register()).status, 503);
  assert2.equal((await h.request("GET", `${BASE}/config`)).body.storageAvailable, false);
  assert2.equal((await legacy.request("GET", `${BASE}/calls/call_1`, {}, enrolled.body.deviceToken)).status, 200);
});
test("misspelled registry configuration fails closed and creates no local device file", async () => {
  const h = await harness({ env: { ...makeEnv(), SH_ANDROID_REGISTRY_BACKEND: "firestor" } });
  assert2.equal((await h.register()).status, 503);
  await assert2.rejects(access(h.devicesPath), { code: "ENOENT" });
});
test("Firestore IAM/server-auth errors are 503, recover without reenrollment, and reveal no SDK details", async () => {
  let available = false;
  const deviceRegistry = { authenticate: /* @__PURE__ */ __name(async (token) => {
    assert2.equal(token, BEARER);
    if (!available) throw Object.assign(Error("private SDK project/account details"), { status: 401 });
    return nativeDevice();
  }, "authenticate") };
  const h = await harness({ deviceRegistry });
  const failed = await h.request("GET", `${BASE}/calls/call_1`, {}, BEARER);
  assert2.equal(failed.status, 503);
  assert2.equal(failed.headers["Retry-After"], "5");
  assert2.ok(!JSON.stringify(failed.body).includes("private SDK"));
  available = true;
  assert2.equal((await h.request("GET", `${BASE}/calls/call_1`, {}, BEARER)).status, 200);
  await assert2.rejects(access(h.devicesPath), { code: "ENOENT" });
});
test("only deliberate registry credential errors become phone 401", async () => {
  const h = await harness({ deviceRegistry: { authenticate: /* @__PURE__ */ __name(async () => {
    throw Object.assign(Error("Device enrollment expired or was revoked."), { registryError: true, status: 401 });
  }, "authenticate") } });
  assert2.equal((await h.request("GET", `${BASE}/calls/call_1`, {}, BEARER)).status, 401);
});
test("call-history storage authentication failures do not invalidate an enrolled phone", async () => {
  const h = await harness({
    deviceRegistry: { authenticate: /* @__PURE__ */ __name(async () => nativeDevice(), "authenticate") },
    readCall: /* @__PURE__ */ __name(async () => {
      throw Object.assign(Error("private call-storage account"), { status: 401 });
    }, "readCall")
  });
  const result = await h.request("GET", `${BASE}/calls/call_1`, {}, BEARER);
  assert2.equal(result.status, 503);
  assert2.ok(!JSON.stringify(result.body).includes("private"));
});
test("public config reports unavailable storage without exposing service credentials or enrollment code", async () => {
  const h = await harness({ deviceRegistry: { isEnrollmentAvailable: /* @__PURE__ */ __name(async () => {
    throw Error("PRIVATE SDK");
  }, "isEnrollmentAvailable") } });
  const result = await h.request("GET", `${BASE}/config`);
  assert2.equal(result.status, 200);
  assert2.equal(result.body.enabled, true);
  assert2.equal(result.body.enrollmentEnabled, false);
  assert2.equal(result.body.storageAvailable, false);
  assert2.ok(!JSON.stringify(result.body).includes("PRIVATE"));
  assert2.ok(!JSON.stringify(result.body).includes(CODE));
});
test("external enrollment is Odoo-independent and malformed FCM input never reaches storage", async () => {
  const seen = [];
  const h = await harness({ deviceRegistry: { enroll: /* @__PURE__ */ __name(async (value) => {
    seen.push(value);
    return { deviceId: "device_1", deviceToken: BEARER, expiresAt: NOW + 123 };
  }, "enroll") } });
  assert2.equal((await h.register({ fcmToken: "bad" })).status, 400);
  assert2.equal(seen.length, 0);
  const enrolled = await h.register();
  assert2.equal(enrolled.status, 200);
  assert2.equal(enrolled.body.deviceToken, BEARER);
  assert2.equal(seen.length, 1);
  assert2.equal(seen[0].installationId, "install_1234567890abcdef");
  assert2.equal(seen[0].enrollmentCode, CODE);
  assert2.equal(seen[0].odooPassword, void 0);
  await assert2.rejects(access(h.devicesPath), { code: "ENOENT" });
});
test("renewal dispatches a separate authenticated domain operation and cannot overwrite refreshed FCM tokens", async () => {
  const seen = [];
  const h = await harness({ deviceRegistry: {
    authenticate: /* @__PURE__ */ __name(async () => nativeDevice({ fcmToken: "old_token" }), "authenticate"),
    renewLease: /* @__PURE__ */ __name(async (token) => {
      seen.push(token);
      return { deviceId: nativeDevice().id, expiresAt: NOW + 12345 };
    }, "renewLease"),
    updateToken: /* @__PURE__ */ __name(async () => {
      throw Error("Renewal must not rewrite FCM tokens");
    }, "updateToken")
  } });
  const result = await h.request("POST", `${BASE}/devices/renew`, { deviceId: "some_other_device", fcmToken: "stale_token" }, BEARER);
  assert2.equal(result.status, 200);
  assert2.deepEqual(seen, [BEARER]);
  assert2.equal(result.body.deviceId, nativeDevice().id);
  assert2.equal(result.body.deviceToken, void 0);
});
test("renewal is retry-safe and extends only the current valid device without replacing its bearer", async () => {
  const h = await harness(), enrolled = await h.register();
  const originalExpiry = enrolled.body.expiresAt;
  h.setNow(NOW + 29 * 864e5);
  const first = await h.request("POST", `${BASE}/devices/renew`, {}, enrolled.body.deviceToken);
  const repeated = await h.request("POST", `${BASE}/devices/renew`, {}, enrolled.body.deviceToken);
  assert2.equal(first.status, 200);
  assert2.equal(repeated.status, 200);
  assert2.equal(first.body.expiresAt, repeated.body.expiresAt);
  assert2.ok(first.body.expiresAt > originalExpiry);
  h.setNow(originalExpiry + 1);
  assert2.equal((await h.request("GET", `${BASE}/calls/call_1`, {}, enrolled.body.deviceToken)).status, 200);
  const registry = JSON.parse(await readFile(h.devicesPath, "utf8"));
  assert2.equal(registry.devices.length, 1);
  assert2.equal(registry.devices[0].fcmToken, TOKEN);
  assert2.ok(!JSON.stringify(registry).includes(enrolled.body.deviceToken));
});
test("renewal cannot revive expired or revoked enrollment and cannot run anonymously", async () => {
  const h = await harness(), enrolled = await h.register();
  assert2.equal((await h.request("POST", `${BASE}/devices/renew`)).status, 401);
  h.setNow(enrolled.body.expiresAt + 1);
  assert2.equal((await h.request("POST", `${BASE}/devices/renew`, {}, enrolled.body.deviceToken)).status, 401);
  const active = await harness(), second = await active.register();
  await active.request("POST", `${BASE}/devices/unregister`, {}, second.body.deviceToken);
  assert2.equal((await active.request("POST", `${BASE}/devices/renew`, {}, second.body.deviceToken)).status, 401);
});
test("FCM server authorization failure on a test route never invalidates the enrolled phone", async () => {
  const h = await harness({ delivery: /* @__PURE__ */ __name(async () => {
    throw Object.assign(Error("FCM server credentials"), { status: 401 });
  }, "delivery") });
  const enrolled = await h.register();
  const result = await h.request("POST", `${BASE}/devices/test`, {}, enrolled.body.deviceToken);
  assert2.equal(result.status, 503);
  assert2.equal(result.headers["Retry-After"], "5");
  assert2.equal((await h.request("GET", `${BASE}/calls/call_1`, {}, enrolled.body.deviceToken)).status, 200);
});
test("legacy file storage recovers from a temporary malformed read without caching failure permanently", async () => {
  const h = await harness();
  await writeFile(h.devicesPath, "broken");
  assert2.equal((await h.register()).status, 503);
  await writeFile(h.devicesPath, JSON.stringify({ schema: 1, devices: [], usedEnrollmentHashes: [], deliveries: [] }));
  assert2.equal((await h.register()).status, 200);
});
test("legacy acknowledged delivery rows still suppress duplicate notifications after upgrade", async () => {
  const h = await harness(), enrolled = await h.register();
  const registry = JSON.parse(await readFile(h.devicesPath, "utf8"));
  registry.deliveries.push({ callId: "call_1", deviceId: enrolled.body.deviceId, event: "incoming", sentAt: NOW });
  await writeFile(h.devicesPath, JSON.stringify(registry));
  const upgraded = await harness({ devicesPath: h.devicesPath });
  await upgraded.bridge.publishCallEvents([{ call_id: "call_1" }]);
  assert2.equal(upgraded.sent.length, 0);
});

// tests/operator-storage/firestore-fake.js
/*! SOURCE tests/operator-storage/firestore-fake.js | SHA-256 70952d42298a1f802c8eb9551ada07af8f849cb135fd955f8a879c89b6971d81 */
var clone = /* @__PURE__ */ __name((value) => structuredClone(value), "clone");
var Snapshot = class {
  static {
    __name(this, "Snapshot");
  }
  constructor(ref, value) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = value !== void 0;
    this._value = clone(value);
  }
  data() {
    return clone(this._value);
  }
};
var DocumentReference = class {
  static {
    __name(this, "DocumentReference");
  }
  constructor(db, path) {
    this.firestore = db;
    this.path = path;
    this.id = path.split("/").at(-1);
  }
  get() {
    return this.firestore._get(this);
  }
};
var Query = class _Query {
  static {
    __name(this, "Query");
  }
  constructor(db, path, filters = [], count = Infinity) {
    this.firestore = db;
    this.path = path;
    this.filters = filters;
    this.count = count;
  }
  where(field, operation, value) {
    return new _Query(this.firestore, this.path, [...this.filters, [field, operation, value]], this.count);
  }
  limit(count) {
    return new _Query(this.firestore, this.path, this.filters, count);
  }
  get() {
    return this.firestore._get(this);
  }
};
var CollectionReference = class extends Query {
  static {
    __name(this, "CollectionReference");
  }
  doc(id) {
    if (typeof id !== "string" || !id || id.includes("/")) throw Error("Invalid document ID");
    return new DocumentReference(this.firestore, `${this.path}/${id}`);
  }
};
var FirestoreFake = class {
  static {
    __name(this, "FirestoreFake");
  }
  constructor() {
    this._documents = /* @__PURE__ */ new Map();
    this._collections = /* @__PURE__ */ new Map();
    this._version = 0;
    this.transactionRuns = 0;
    this.commits = 0;
    this.conflicts = 0;
    this.failReads = null;
    this.failBeforeCommit = null;
    this.failAfterCommit = null;
  }
  collection(path) {
    if (typeof path !== "string" || !path || path.includes("/")) throw Error("Invalid collection");
    return new CollectionReference(this, path);
  }
  _snapshot(ref) {
    return new Snapshot(ref, this._documents.get(ref.path)?.value);
  }
  _query(query) {
    const docs = [];
    for (const [path, record] of [...this._documents].sort(([a], [b]) => a.localeCompare(b))) {
      if (path.split("/").slice(0, -1).join("/") !== query.path) continue;
      if (!query.filters.every(([field, operation, value]) => {
        const actual = record.value[field];
        if (actual === void 0) return false;
        if (operation === "==") return actual === value;
        if (operation === ">") return actual > value;
        if (operation === ">=") return actual >= value;
        if (operation === "<") return actual < value;
        if (operation === "<=") return actual <= value;
        throw Error("Unsupported fake query operator");
      })) continue;
      docs.push(this._snapshot(new DocumentReference(this, path)));
      if (docs.length >= query.count) break;
    }
    return { docs, empty: docs.length === 0, size: docs.length };
  }
  async _get(reference) {
    if (this.failReads) throw this.failReads;
    return reference instanceof DocumentReference ? this._snapshot(reference) : this._query(reference);
  }
  _write(reference, value) {
    this._documents.set(reference.path, { value: clone(value), version: ++this._version });
    this._collections.set(reference.path.split("/").slice(0, -1).join("/"), this._version);
  }
  seed(collection, id, value) {
    this._write(this.collection(collection).doc(id), value);
  }
  dump() {
    return Object.fromEntries([...this._documents].map(([path, record]) => [path, clone(record.value)]));
  }
  async runTransaction(callback) {
    for (let attempt = 0; attempt < 20; attempt++) {
      this.transactionRuns++;
      const reads = /* @__PURE__ */ new Map(), queryReads = /* @__PURE__ */ new Map(), writes = /* @__PURE__ */ new Map();
      let wrote = false;
      const transaction = {
        get: /* @__PURE__ */ __name(async (reference) => {
          if (wrote) throw Error("Firestore transaction requires all reads before any writes.");
          if (this.failReads) throw this.failReads;
          if (reference instanceof DocumentReference) {
            reads.set(reference.path, this._documents.get(reference.path)?.version || 0);
            return this._snapshot(reference);
          }
          queryReads.set(reference.path, this._collections.get(reference.path) || 0);
          return this._query(reference);
        }, "get"),
        set: /* @__PURE__ */ __name((reference, value) => {
          wrote = true;
          writes.set(reference.path, { reference, value: clone(value), create: false });
          return transaction;
        }, "set"),
        create: /* @__PURE__ */ __name((reference, value) => {
          wrote = true;
          writes.set(reference.path, { reference, value: clone(value), create: true });
          return transaction;
        }, "create")
      };
      const result = await callback(transaction);
      if ([...reads].some(([path, version]) => (this._documents.get(path)?.version || 0) !== version) || [...queryReads].some(([path, version]) => (this._collections.get(path) || 0) !== version)) {
        this.conflicts++;
        continue;
      }
      if (this.failBeforeCommit) {
        const error = this.failBeforeCommit;
        this.failBeforeCommit = null;
        throw error;
      }
      for (const write of writes.values()) if (write.create && this._documents.has(write.reference.path)) throw Object.assign(Error("Already exists"), { code: 6 });
      for (const write of writes.values()) this._write(write.reference, write.value);
      if (writes.size) this.commits++;
      if (this.failAfterCommit) {
        const error = this.failAfterCommit;
        this.failAfterCommit = null;
        throw error;
      }
      return result;
    }
    throw Object.assign(Error("Too much transaction contention"), { code: 10 });
  }
};

// tests/operator-storage/operator-firestore-registry.test.js
/*! SOURCE tests/operator-storage/operator-firestore-registry.test.js | SHA-256 38538c9925d1d18f343a9fc3781a9dfe026271923991c48df096214fbc597f78 */
import test2 from "node:test";
import assert3 from "node:assert/strict";
import { createHash as createHash2 } from "node:crypto";
import { createFirestoreDeviceRegistry, RegistryError, DEVICE_TOKEN_TTL_MS } from "../operator-firestore-registry.js";
var NOW2 = Date.parse("2026-10-29T08:00:00Z");
var CODE2 = "test_bootstrap_1234567890abcdef_1234567890abcdef";
var FCM = "test_fcm_token_1234567890abcdef:1234567890abcdef";
var INSTALL = "test_installation_1234567890abcdef";
var REQUEST = "test_rotation_1234567890abcdef";
var hash = /* @__PURE__ */ __name((value) => createHash2("sha256").update(value).digest("hex"), "hash");
function setup(options = {}) {
  const db = options.firestore || new FirestoreFake();
  let now = NOW2;
  const create = /* @__PURE__ */ __name((extra) => createFirestoreDeviceRegistry({ firestore: db, clock: /* @__PURE__ */ __name(() => now, "clock"), bootstrapEnrollmentCode: CODE2, ...options, ...extra }), "create");
  const registry = create();
  const input = { installationId: INSTALL, fcmToken: FCM, enrollmentCode: CODE2, deviceLabel: "Test phone" };
  return { db, registry, create, input, enroll: /* @__PURE__ */ __name((extra) => registry.enroll({ ...input, ...extra }), "enroll"), setNow: /* @__PURE__ */ __name((value) => {
    now = value;
  }, "setNow") };
}
__name(setup, "setup");
var rejectsStatus = /* @__PURE__ */ __name((operation, status, code) => assert3.rejects(operation, (error) => {
  assert3.ok(error instanceof RegistryError);
  assert3.equal(error.registryError, true);
  assert3.equal(error.status, status);
  if (code) assert3.equal(error.code, code);
  return true;
}), "rejectsStatus");
test2("availability performs one metadata read, accepts a fresh database, and writes nothing", async () => {
  const h = setup({ bootstrapEnrollmentCode: "" }), reads = [];
  const original = h.db._get.bind(h.db);
  h.db._get = async (reference) => {
    reads.push(reference.path);
    return original(reference);
  };
  assert3.equal(await h.registry.checkAvailability(), true);
  assert3.deepEqual(reads, ["sh_operator_metadata/registry"]);
  assert3.equal(h.db.commits, 0);
  assert3.deepEqual(h.db.dump(), {});
});
test2("native protocol metadata persists without changing identity and rejects revoked credentials", async () => {
  const h = setup(), enrollment = await h.enroll();
  const native = await h.registry.updateNativeClient(enrollment.deviceToken, { nativeBuild: 10, mediaProtocol: "sh-room-audio-v1" });
  assert3.equal(native.id, enrollment.deviceId);
  assert3.equal(native.credentialGeneration, 1);
  assert3.equal((await h.create().authenticate(enrollment.deviceToken)).nativeBuild, 10);
  await rejectsStatus(() => h.registry.updateNativeClient(enrollment.deviceToken, { nativeBuild: 10, mediaProtocol: "unknown" }), 400);
  await h.registry.revoke(enrollment.deviceToken);
  await rejectsStatus(() => h.registry.updateNativeClient(enrollment.deviceToken, { nativeBuild: 10, mediaProtocol: "sh-room-audio-v1" }), 401);
});
test2("availability validates initialized metadata and maps SDK/auth failures to 503", async () => {
  const h = setup();
  await h.enroll();
  assert3.equal(await h.registry.checkAvailability(), true);
  h.db.failReads = Object.assign(Error("private SDK identity"), { status: 401 });
  await rejectsStatus(() => h.registry.checkAvailability(), 503, "REGISTRY_UNAVAILABLE");
  h.db.failReads = null;
  h.db.seed("sh_operator_metadata", "registry", { schema: 2, registeredDeviceCount: 1, updatedAt: NOW2 });
  await rejectsStatus(() => h.registry.checkAvailability(), 503);
});
test2("bootstrap registration persists separate records with hashed credentials and consumed invitation", async () => {
  const h = setup();
  assert3.equal(await h.registry.isEnrollmentAvailable(), true);
  const registered = await h.enroll();
  assert3.equal(registered.expiresAt, NOW2 + DEVICE_TOKEN_TTL_MS);
  assert3.equal((await h.registry.authenticate(registered.deviceToken)).id, registered.deviceId);
  assert3.equal(await h.registry.isEnrollmentAvailable(), false);
  const stored = JSON.stringify(h.db.dump());
  assert3.ok(!stored.includes(registered.deviceToken));
  assert3.ok(!stored.includes(CODE2));
  const names = new Set(Object.keys(h.db.dump()).map((key2) => key2.split("/")[0]));
  for (const name of ["devices", "installations", "credentials", "enrollments", "metadata"]) assert3.ok(names.has(`sh_operator_${name}`));
  const cold = h.create();
  assert3.equal((await cold.authenticate(registered.deviceToken)).id, registered.deviceId);
  assert3.equal(await cold.isEnrollmentAvailable(), false);
});
test2("two instances competing for one invitation enroll only one installation", async () => {
  const h = setup(), second = h.create();
  const results = await Promise.allSettled([h.enroll(), second.enroll({ ...h.input, installationId: `${INSTALL}_second` })]);
  assert3.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const failure = results.find((result) => result.status === "rejected");
  assert3.equal(failure.reason.status, 409);
  assert3.equal((await h.registry.listDevices()).length, 1);
  assert3.ok(h.db.conflicts > 0);
});
test2("two identical concurrent requests recover the same result instead of enrolling twice", async () => {
  const h = setup(), second = h.create();
  const results = await Promise.all([h.enroll(), second.enroll(h.input)]);
  assert3.equal(results[0].deviceToken, results[1].deviceToken);
  assert3.equal((await h.registry.listDevices()).length, 1);
});
test2("invitation issue works without env changes and enforces expiry and installation binding", async () => {
  const h = setup();
  await h.enroll();
  const invitation = await h.registry.issueEnrollment({ installationId: `${INSTALL}_second`, expiresInMs: 6e4 });
  assert3.equal(await h.registry.isEnrollmentAvailable(invitation.enrollmentCode), true);
  await rejectsStatus(() => h.enroll({ enrollmentCode: invitation.enrollmentCode }), 403);
  const enrolled = await h.enroll({ enrollmentCode: invitation.enrollmentCode, installationId: `${INSTALL}_second` });
  assert3.ok(enrolled.deviceId);
  assert3.equal((await h.registry.listDevices()).length, 2);
  const expires = await h.registry.issueEnrollment();
  h.setNow(expires.expiresAt);
  await rejectsStatus(() => h.enroll({ enrollmentCode: expires.enrollmentCode, installationId: `${INSTALL}_third` }), 403);
});
test2("administrator invitation names override handset models without changing request fingerprints", async () => {
  const h = setup({ bootstrapEnrollmentCode: "" });
  const names = ["test", "ankit", "kushagra", "vibhu"];
  for (const [index, name] of names.entries()) {
    const invitation = await h.registry.issueEnrollment({ label: ` ${name} ` });
    const input = {
      ...h.input,
      installationId: `${INSTALL}_${index}`,
      enrollmentCode: invitation.enrollmentCode,
      requestId: `${REQUEST}_${index}`,
      deviceLabel: "Example Manufacturer Model"
    };
    const enrolled = await h.registry.enroll(input);
    assert3.equal((await h.registry.authenticate(enrolled.deviceToken)).deviceLabel, name);
    const consumed = h.db.dump()[`sh_operator_enrollments/${hash(invitation.enrollmentCode)}`];
    assert3.equal(consumed.fingerprint, hash(JSON.stringify({
      installationId: input.installationId,
      fcmHash: hash(input.fcmToken),
      requestHash: hash(input.requestId),
      label: input.deviceLabel
    })));
  }
  assert3.deepEqual((await h.registry.listDevices()).map((row) => row.deviceLabel).sort(), [...names].sort());
});
test2("named invitation lost-ack recovery preserves its name and exact original request binding", async () => {
  const h = setup({ bootstrapEnrollmentCode: "" });
  const invitation = await h.registry.issueEnrollment({ label: "Sales phone" });
  const input = { ...h.input, enrollmentCode: invitation.enrollmentCode, requestId: REQUEST, deviceLabel: "Handset model" };
  h.db.failAfterCommit = Error("lost enrollment acknowledgement");
  await rejectsStatus(() => h.registry.enroll(input), 503);
  const before = h.db.dump(), commits = h.db.commits;
  const device = (await h.registry.listDevices())[0];
  assert3.equal(device.deviceLabel, "Sales phone");
  const replay = await h.create().enroll(input);
  assert3.equal(replay.replayed, true);
  assert3.equal(replay.deviceId, device.id);
  assert3.equal(hash(replay.deviceToken), device.tokenHash);
  await rejectsStatus(() => h.create().enroll({ ...input, deviceLabel: "Sales phone" }), 409, "ENROLLMENT_CONSUMED");
  assert3.equal((await h.registry.authenticate(replay.deviceToken)).deviceLabel, "Sales phone");
  assert3.deepEqual(h.db.dump(), before);
  assert3.equal(h.db.commits, commits);
});
test2("concurrent named invitation retries create one device with the administrator name", async () => {
  const h = setup({ bootstrapEnrollmentCode: "" });
  const invitation = await h.registry.issueEnrollment({ label: "Dispatch phone" });
  const input = { ...h.input, enrollmentCode: invitation.enrollmentCode, deviceLabel: "Handset model" };
  const results = await Promise.all([h.registry.enroll(input), h.create().enroll(input)]);
  assert3.equal(results[0].deviceToken, results[1].deviceToken);
  assert3.equal((await h.registry.listDevices()).length, 1);
  assert3.equal((await h.registry.authenticate(results[0].deviceToken)).deviceLabel, "Dispatch phone");
  assert3.ok(h.db.conflicts > 0);
});
test2("bootstrap and unlabeled legacy invitations retain handset and default name fallback", async () => {
  for (const kind of ["bootstrap", "blank-invitation", "legacy-invitation"]) {
    for (const clientLabel of [" Handset model ", ""]) {
      const h = setup({ bootstrapEnrollmentCode: kind === "bootstrap" ? CODE2 : "" });
      let enrollmentCode = CODE2;
      if (kind !== "bootstrap") {
        enrollmentCode = (await h.registry.issueEnrollment({ label: " " })).enrollmentCode;
        if (kind === "legacy-invitation") {
          const row = h.db.dump()[`sh_operator_enrollments/${hash(enrollmentCode)}`];
          delete row.label;
          h.db.seed("sh_operator_enrollments", hash(enrollmentCode), row);
        }
      }
      const enrolled = await h.enroll({ enrollmentCode, deviceLabel: clientLabel });
      assert3.equal(
        (await h.registry.authenticate(enrolled.deviceToken)).deviceLabel,
        clientLabel.trim() || "Android operator device"
      );
    }
  }
});
test2("a fresh named invitation cannot rename an already active installation", async () => {
  const h = setup(), enrolled = await h.enroll({ deviceLabel: "Existing phone" });
  const invitation = await h.registry.issueEnrollment({ label: "New invitation name" });
  const before = h.db.dump();
  await rejectsStatus(() => h.enroll({ enrollmentCode: invitation.enrollmentCode }), 409, "INSTALLATION_ENROLLED");
  assert3.equal((await h.registry.authenticate(enrolled.deviceToken)).deviceLabel, "Existing phone");
  assert3.deepEqual(h.db.dump(), before);
  assert3.equal(await h.registry.isEnrollmentAvailable(invitation.enrollmentCode), true);
});
test2("independent invitations cannot bypass concurrent device-cap enforcement", async () => {
  const h = setup({ maxDevices: 1 });
  const invite = await h.registry.issueEnrollment();
  const results = await Promise.allSettled([h.enroll(), h.create().enroll({ ...h.input, installationId: `${INSTALL}_second`, enrollmentCode: invite.enrollmentCode })]);
  assert3.equal(results.filter((row) => row.status === "fulfilled").length, 1);
  assert3.equal(results.find((row) => row.status === "rejected").reason.code, "DEVICE_LIMIT");
  assert3.equal((await h.registry.listDevices()).length, 1);
});
test2("failed commit does not consume invitation or leak a success credential", async () => {
  const h = setup();
  h.db.failBeforeCommit = Object.assign(Error("firestore permissions private details"), { status: 401 });
  await rejectsStatus(() => h.enroll(), 503, "REGISTRY_UNAVAILABLE");
  assert3.deepEqual(h.db.dump(), {});
  assert3.equal(await h.registry.isEnrollmentAvailable(), true);
  assert3.ok((await h.enroll()).deviceToken);
});
test2("lost commit response safely recovers same bearer after backend restart", async () => {
  const h = setup();
  h.db.failAfterCommit = Error("connection lost after committed response");
  await rejectsStatus(() => h.enroll(), 503);
  const device = (await h.registry.listDevices())[0];
  const replay = await h.create().enroll(h.input);
  assert3.equal(hash(replay.deviceToken), device.tokenHash);
  assert3.equal(replay.replayed, true);
  assert3.equal((await h.registry.listDevices()).length, 1);
});
test2("enrollment replay binds installation, FCM token, request and label", async () => {
  const h = setup();
  await h.enroll({ requestId: REQUEST });
  for (const changed of [{ fcmToken: `${FCM}_other` }, { installationId: `${INSTALL}_other` }, { requestId: `${REQUEST}_other` }, { deviceLabel: "Other label" }]) {
    await rejectsStatus(() => h.enroll({ requestId: REQUEST, ...changed }), 409);
  }
  await rejectsStatus(() => h.enroll({ enrollmentCode: `${CODE2}_wrong`, requestId: REQUEST }), 403);
  assert3.equal((await h.enroll({ requestId: REQUEST })).replayed, true);
});
test2("enrollment replay cannot recover after revoke, expiration, rotation or two-minute window", async () => {
  const expired = setup();
  const first = await expired.enroll();
  expired.setNow(NOW2 + 12e4);
  await rejectsStatus(() => expired.enroll(), 409);
  const revoked = setup();
  const second = await revoked.enroll();
  await revoked.registry.revoke(second.deviceToken);
  await rejectsStatus(() => revoked.enroll(), 409);
  const rotated = setup();
  const third = await rotated.enroll();
  await rotated.registry.rotateCredential(third.deviceToken, { requestId: REQUEST });
  await rejectsStatus(() => rotated.enroll(), 409);
  const ttl = setup({ tokenTtlMs: 6e4 });
  await ttl.enroll();
  ttl.setNow(NOW2 + 6e4);
  await rejectsStatus(() => ttl.enroll(), 409);
  assert3.ok(first.deviceId);
});
test2("encrypted replay is authenticated and corrupt storage fails closed", async () => {
  const h = setup();
  await h.enroll();
  const rows2 = h.db.dump();
  const key2 = Object.keys(rows2).find((path) => path.startsWith("sh_operator_enrollments/"));
  const altered = { ...rows2[key2], recoveryBinding: `${rows2[key2].recoveryBinding}changed` };
  h.db.seed("sh_operator_enrollments", key2.split("/")[1], altered);
  await rejectsStatus(() => h.enroll(), 503);
});
test2("authentication never uses caller-supplied identity and only current unexpired bearer works", async () => {
  const h = setup(), registered = await h.enroll();
  await rejectsStatus(() => h.registry.authenticate(`${registered.deviceId}.${"a".repeat(43)}`), 401);
  await rejectsStatus(() => h.registry.authenticate("short"), 401);
  h.setNow(registered.expiresAt);
  await rejectsStatus(() => h.registry.authenticate(registered.deviceToken), 401);
  await rejectsStatus(() => h.registry.renewLease(registered.deviceToken), 401);
});
test2("SDK auth errors become safe 503 and do not erase stored enrollment", async () => {
  const h = setup(), registered = await h.enroll();
  h.db.failReads = Object.assign(Error("secret-key details"), { status: 401, code: "UNAUTHENTICATED" });
  await assert3.rejects(() => h.registry.authenticate(registered.deviceToken), (error) => {
    assert3.equal(error.status, 503);
    assert3.ok(!error.message.includes("secret-key"));
    return true;
  });
  h.db.failReads = null;
  assert3.equal((await h.registry.authenticate(registered.deviceToken)).id, registered.deviceId);
});
test2("FCM token update does not extend expiry unless renewal is explicitly requested", async () => {
  const h = setup(), registered = await h.enroll();
  h.setNow(NOW2 + 864e5);
  const update = await h.registry.updateToken(registered.deviceToken, { fcmToken: `${FCM}_new`, receiveCalls: false, receiveChats: false });
  assert3.equal(update.expiresAt, registered.expiresAt);
  assert3.equal(update.receiveCalls, false);
  assert3.equal(update.receiveChats, false);
  const renewed = await h.registry.updateToken(registered.deviceToken, { fcmToken: `${FCM}_new`, renewLease: true });
  assert3.equal(renewed.expiresAt, NOW2 + 31 * 864e5);
  assert3.equal((await h.registry.authenticate(registered.deviceToken)).fcmToken, `${FCM}_new`);
});
test2("lease renewal and simultaneous FCM update preserve latest token and preferences", async () => {
  const h = setup(), registered = await h.enroll();
  h.setNow(NOW2 + 864e5);
  await Promise.all([h.registry.renewLease(registered.deviceToken), h.create().updateToken(registered.deviceToken, { fcmToken: `${FCM}_new`, receiveChats: false })]);
  const row = await h.registry.authenticate(registered.deviceToken);
  assert3.equal(row.fcmToken, `${FCM}_new`);
  assert3.equal(row.receiveChats, false);
  assert3.equal(row.tokenExpiresAt, NOW2 + 31 * 864e5);
});
test2("revocation wins races with token update or renewal and invalidates bearer immediately", async () => {
  const h = setup(), registered = await h.enroll();
  await Promise.allSettled([h.registry.renewLease(registered.deviceToken), h.create().revoke(registered.deviceToken)]);
  await rejectsStatus(() => h.registry.authenticate(registered.deviceToken), 401);
  assert3.equal((await h.registry.getDevice(registered.deviceId)).fcmToken, "");
  await rejectsStatus(() => h.registry.updateToken(registered.deviceToken, { fcmToken: FCM, renewLease: true }), 401);
});
test2("rotation rejects old token everywhere except bounded exact lost-response recovery", async () => {
  const h = setup(), registered = await h.enroll();
  const rotated = await h.registry.rotateCredential(registered.deviceToken, { requestId: REQUEST });
  assert3.notEqual(rotated.deviceToken, registered.deviceToken);
  assert3.equal(rotated.deviceId, registered.deviceId);
  await rejectsStatus(() => h.registry.authenticate(registered.deviceToken), 401);
  await rejectsStatus(() => h.registry.renewLease(registered.deviceToken), 401);
  await rejectsStatus(() => h.registry.rotateCredential(registered.deviceToken, { requestId: `${REQUEST}_different` }), 401);
  const replay = await h.create().rotateCredential(registered.deviceToken, { requestId: REQUEST });
  assert3.equal(replay.deviceToken, rotated.deviceToken);
  assert3.equal(replay.replayed, true);
  assert3.equal((await h.registry.authenticate(rotated.deviceToken)).credentialGeneration, 2);
  const storage = JSON.stringify(h.db.dump());
  assert3.ok(!storage.includes(rotated.deviceToken));
  assert3.ok(!storage.includes(registered.deviceToken));
});
test2("lost rotation response retries atomically; stale generation, revoke and expiry cannot recover", async () => {
  const h = setup(), registered = await h.enroll();
  h.db.failAfterCommit = Error("lost commit response");
  await rejectsStatus(() => h.registry.rotateCredential(registered.deviceToken, { requestId: REQUEST }), 503);
  const replay = await h.create().rotateCredential(registered.deviceToken, { requestId: REQUEST });
  assert3.equal((await h.registry.authenticate(replay.deviceToken)).credentialGeneration, 2);
  const latest = await h.registry.rotateCredential(replay.deviceToken, { requestId: `${REQUEST}_second` });
  await rejectsStatus(() => h.registry.rotateCredential(registered.deviceToken, { requestId: REQUEST }), 401);
  await h.registry.revoke(latest.deviceToken);
  await rejectsStatus(() => h.registry.rotateCredential(replay.deviceToken, { requestId: `${REQUEST}_second` }), 401);
  const ttl = setup({ tokenTtlMs: 6e4 }), old = await ttl.enroll();
  await ttl.registry.rotateCredential(old.deviceToken, { requestId: REQUEST });
  ttl.setNow(NOW2 + 6e4);
  await rejectsStatus(() => ttl.registry.rotateCredential(old.deviceToken, { requestId: REQUEST }), 401);
});
test2("different concurrent rotations produce one current generation and no forked credentials", async () => {
  const h = setup(), registered = await h.enroll();
  const results = await Promise.allSettled([h.registry.rotateCredential(registered.deviceToken, { requestId: REQUEST }), h.create().rotateCredential(registered.deviceToken, { requestId: `${REQUEST}_second` })]);
  assert3.equal(results.filter((row) => row.status === "fulfilled").length, 1);
  assert3.equal(results.find((row) => row.status === "rejected").reason.status, 401);
  const winner = results.find((row) => row.status === "fulfilled").value;
  assert3.equal((await h.registry.authenticate(winner.deviceToken)).credentialGeneration, 2);
});
test2("re-enrollment of expired installation retains device identity and rejects previous bearer", async () => {
  const h = setup(), registered = await h.enroll();
  h.setNow(registered.expiresAt + 1);
  const invitation = await h.registry.issueEnrollment();
  const next = await h.enroll({ enrollmentCode: invitation.enrollmentCode });
  assert3.equal(next.deviceId, registered.deviceId);
  assert3.notEqual(next.deviceToken, registered.deviceToken);
  assert3.equal((await h.registry.listDevices()).length, 1);
  await rejectsStatus(() => h.registry.authenticate(registered.deviceToken), 401);
});
test2("admin revocation applies even to expired device and releases a registration slot", async () => {
  const h = setup({ maxDevices: 1 }), registered = await h.enroll();
  h.setNow(registered.expiresAt + 1);
  await h.registry.revokeDevice(registered.deviceId);
  await h.registry.revokeDevice(registered.deviceId);
  const invitation = await h.registry.issueEnrollment();
  assert3.ok((await h.enroll({ installationId: `${INSTALL}_second`, enrollmentCode: invitation.enrollmentCode })).deviceId);
  assert3.equal(h.db.dump()["sh_operator_metadata/registry"].registeredDeviceCount, 1);
});
test2("environment revocation blocks auth, renewal, replay and deliveries", async () => {
  const h = setup(), registered = await h.enroll(), blocked = h.create({ revokedIds: [registered.deviceId] });
  await rejectsStatus(() => blocked.authenticate(registered.deviceToken), 401);
  await rejectsStatus(() => blocked.renewLease(registered.deviceToken), 401);
  await rejectsStatus(() => blocked.enroll(h.input), 409);
  assert3.equal((await blocked.claimDelivery({ deviceId: registered.deviceId, callId: "call_1", event: "incoming", expiresAtMs: NOW2 + 3e4 })).claimed, false);
});
test2("FCM unregistered cleanup is compare-and-set and cannot erase a newer token", async () => {
  const h = setup(), registered = await h.enroll();
  await h.registry.updateToken(registered.deviceToken, { fcmToken: `${FCM}_new` });
  assert3.equal((await h.registry.clearFcmToken(registered.deviceId, FCM)).cleared, false);
  assert3.equal((await h.registry.clearFcmToken(registered.deviceId, `${FCM}_new`)).cleared, true);
  assert3.equal((await h.registry.getDevice(registered.deviceId)).fcmToken, "");
});
test2("two workers cannot both claim an alert and sent dedup survives a new registry instance", async () => {
  const h = setup(), registered = await h.enroll();
  const event = { deviceId: registered.deviceId, callId: "call_1", event: "incoming", expiresAtMs: NOW2 + 3e4 };
  const claims2 = await Promise.all([h.registry.claimDelivery(event), h.create().claimDelivery(event)]);
  assert3.equal(claims2.filter((row) => row.claimed).length, 1);
  const claim = claims2.find((row) => row.claimed);
  assert3.equal(claim.device.id, registered.deviceId);
  assert3.equal(claim.claimUntilMs, NOW2 + 6e4);
  assert3.equal((await h.registry.finishDelivery({ ...claim, outcome: "sent" })).finished, true);
  assert3.equal((await h.create().claimDelivery(event)).claimed, false);
  const deliveries = await h.registry.getDeliveries({ callId: "call_1" });
  assert3.equal(deliveries.length, 1);
  assert3.equal(deliveries[0].state, "sent");
  assert3.equal(deliveries[0].sentAt, NOW2);
});
test2("stale lease owner cannot finish a newer worker claim", async () => {
  const h = setup(), registered = await h.enroll();
  const event = { deviceId: registered.deviceId, messageId: "12", channelId: "34", event: "message", expiresAtMs: NOW2 + 3e5 };
  const first = await h.registry.claimDelivery(event);
  h.setNow(NOW2 + 60001);
  const next = await h.create().claimDelivery(event);
  assert3.equal(next.claimed, true);
  assert3.notEqual(next.claimId, first.claimId);
  assert3.equal((await h.registry.finishDelivery({ ...first, outcome: "sent" })).finished, false);
  assert3.equal((await h.registry.finishDelivery({ ...next, outcome: "sent" })).finished, true);
});
test2("failed claims can retry; cancelled and expired work is never offered again", async () => {
  const h = setup(), registered = await h.enroll();
  const event = { deviceId: registered.deviceId, messageId: "12", channelId: "34", event: "message", expiresAtMs: NOW2 + 3e5 };
  const first = await h.registry.claimDelivery(event);
  await h.registry.finishDelivery({ ...first, outcome: "failed" });
  const next = await h.registry.claimDelivery(event);
  assert3.equal(next.claimed, true);
  await h.registry.finishDelivery({ ...next, outcome: "cancelled" });
  assert3.equal((await h.registry.claimDelivery(event)).claimed, false);
  h.setNow(NOW2 + 3e5);
  assert3.equal((await h.registry.claimDelivery({ ...event, messageId: "13" })).reason, "expired");
});
test2("pending incoming can be cancelled and ended claim blocks a late incoming retry", async () => {
  const h = setup(), registered = await h.enroll();
  const event = { deviceId: registered.deviceId, callId: "call_1", event: "incoming", expiresAtMs: NOW2 + 3e4 };
  assert3.equal((await h.registry.claimDelivery({ ...event, event: "ended" })).reason, "not_previously_alerted");
  const incoming3 = await h.registry.claimDelivery(event);
  await h.registry.updateToken(registered.deviceToken, { fcmToken: FCM, receiveCalls: false });
  const ending = await h.registry.claimDelivery({ ...event, event: "ended" });
  assert3.equal(ending.claimed, true);
  await h.registry.finishDelivery({ ...incoming3, outcome: "failed" });
  await h.registry.updateToken(registered.deviceToken, { fcmToken: FCM, receiveCalls: true });
  assert3.equal((await h.registry.claimDelivery(event)).reason, "call_ended");
  const deliveries = await h.registry.getDeliveries({ callId: "call_1" });
  assert3.equal(deliveries.length, 2);
});
test2("call delivery reads independent guard documents concurrently within one atomic claim", async () => {
  const h = setup(), enrolled = await h.enroll();
  const transaction = h.db.runTransaction.bind(h.db);
  let reading = 0, peak = 0, reads = 0;
  h.db.runTransaction = (callback) => transaction((tx) => callback({ ...tx, get: /* @__PURE__ */ __name(async (reference) => {
    reads++;
    reading++;
    peak = Math.max(peak, reading);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      return await tx.get(reference);
    } finally {
      reading--;
    }
  }, "get") }));
  const event = { deviceId: enrolled.deviceId, callId: "parallel-claim", event: "incoming", expiresAtMs: NOW2 + 3e4 };
  const claim = await h.registry.claimDelivery(event);
  assert3.equal(claim.claimed, true);
  assert3.equal(reads, 3);
  assert3.equal(peak, 3);
  assert3.equal((await h.registry.claimDelivery(event)).reason, "in_progress");
  const end = await h.registry.claimDelivery({ ...event, event: "ended" });
  assert3.equal(end.claimed, true);
  await h.registry.finishDelivery({ ...claim, outcome: "failed" });
  assert3.equal((await h.registry.claimDelivery(event)).reason, "call_ended");
});
test2("claims revalidate preferences and device revocation transactionally", async () => {
  const h = setup(), registered = await h.enroll();
  await h.registry.updateToken(registered.deviceToken, { fcmToken: FCM, receiveChats: false });
  const event = { deviceId: registered.deviceId, messageId: "12", channelId: "34", event: "message", expiresAtMs: NOW2 + 3e5 };
  assert3.equal((await h.registry.claimDelivery(event)).reason, "opted_out");
  await h.registry.revoke(registered.deviceToken);
  assert3.equal((await h.registry.claimDelivery({ deviceId: registered.deviceId, callId: "call_1", event: "incoming", expiresAtMs: NOW2 + 3e4 })).reason, "device_unavailable");
});
test2("storage failure cannot fabricate sent acknowledgement or claim success", async () => {
  const h = setup(), registered = await h.enroll();
  const event = { deviceId: registered.deviceId, callId: "call_1", event: "incoming", expiresAtMs: NOW2 + 3e4 };
  h.db.failBeforeCommit = Error("write unavailable");
  await rejectsStatus(() => h.registry.claimDelivery(event), 503);
  assert3.equal((await h.registry.getDeliveries({ callId: "call_1" })).length, 0);
  const claim = await h.registry.claimDelivery(event);
  h.db.failBeforeCommit = Error("write unavailable");
  await rejectsStatus(() => h.registry.finishDelivery({ ...claim, outcome: "sent" }), 503);
  assert3.equal((await h.registry.getDeliveries({ callId: "call_1" }))[0].state, "claimed");
});
test2("replay cleanup removes encrypted material but preserves registration and consumed-code evidence", async () => {
  const h = setup(), registered = await h.enroll();
  const rotated = await h.registry.rotateCredential(registered.deviceToken, { requestId: REQUEST });
  h.setNow(NOW2 + 12e4);
  assert3.equal((await h.registry.pruneExpiredRecoveries()).cleared, 2);
  const records = h.db.dump();
  for (const [key2, row] of Object.entries(records)) if (/_(enrollments|rotations)\//.test(key2)) {
    assert3.equal(row.recoveryEnvelope, null);
    assert3.equal(row.recoveryUntil, 0);
  }
  assert3.equal(await h.registry.isEnrollmentAvailable(), false);
  assert3.equal((await h.registry.authenticate(rotated.deviceToken)).id, registered.deviceId);
  await rejectsStatus(() => h.enroll(), 409);
  await rejectsStatus(() => h.registry.rotateCredential(registered.deviceToken, { requestId: REQUEST }), 401);
});
test2("invalid or corrupt device rows cannot be treated as an empty usable registry", async () => {
  const h = setup(), registered = await h.enroll();
  h.db.seed("sh_operator_devices", registered.deviceId, { schema: 1, id: registered.deviceId });
  await rejectsStatus(() => h.registry.authenticate(registered.deviceToken), 503);
  await rejectsStatus(() => h.registry.listDevices(), 503);
});

// tests/operator-storage/operator-android-push.test.js
/*! SOURCE tests/operator-storage/operator-android-push.test.js | SHA-256 f2312ab7a834bf1d30dc308dde77dc667fbb52289dbc0a06e59550ae549f953e */
import test3 from "node:test";
import assert4 from "node:assert/strict";
import { mkdtemp as mkdtemp2, readFile as readFile2, writeFile as writeFile2, stat } from "node:fs/promises";
import { tmpdir as tmpdir2 } from "node:os";
import { join as join2 } from "node:path";
import { generateKeyPairSync as generateKeyPairSync2 } from "node:crypto";
import vm from "node:vm";
import { createAndroidPushBridge as createAndroidPushBridge2 } from "../operator-android-push.js";
var privateKey2 = generateKeyPairSync2("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
var CODE3 = "sh_test_enrollment_1234567890abcdefghijklmnop";
var TOKEN2 = "fcm_test_abcdefghijklmnopqrstuvwxyz1234567890";
var NOW3 = 17931888e5;
var BASE2 = "/api/operator-android";
var env = /* @__PURE__ */ __name(() => ({
  SH_ANDROID_PUSH_ENABLED: "true",
  SH_ANDROID_FIREBASE_API_KEY: "AIzaabcdefghijklmnopqrstuvwxyz0123456789",
  SH_ANDROID_FIREBASE_APP_ID: "1:123456789012:android:abc01234",
  SH_ANDROID_FIREBASE_PROJECT_ID: "sh-test-project",
  SH_ANDROID_FIREBASE_SENDER_ID: "123456789012",
  SH_ANDROID_ENROLLMENT_CODE: CODE3,
  SH_ANDROID_FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
    type: "service_account",
    project_id: "sh-test-project",
    private_key: privateKey2,
    client_email: "sender@sh-test-project.iam.gserviceaccount.com"
  })
}), "env");
var incoming2 = /* @__PURE__ */ __name((id = "call_1", change = {}) => ({
  call_id: id,
  direction: "incoming",
  status: "incoming_ringing",
  active: true,
  answerable: true,
  started_at: new Date(NOW3 - 1e3).toISOString(),
  updated_at: new Date(NOW3).toISOString(),
  customer_name: "Test customer",
  sdp: "PRIVATE SDP MUST NOT LEAK",
  customer_phone: "919999999999",
  ...change
}), "incoming");
async function harness2(options = {}) {
  const dir = await mkdtemp2(join2(tmpdir2(), "sh-native-push-"));
  const devicesPath = options.devicesPath || join2(dir, "devices.json");
  let now = NOW3, call = options.call === void 0 ? incoming2() : options.call;
  const sent = [], routes = /* @__PURE__ */ new Map();
  const bridge = createAndroidPushBridge2({
    env: options.env || env(),
    devicesPath,
    clock: /* @__PURE__ */ __name(() => now, "clock"),
    logger: { warn() {
    } },
    readCall: options.readCall || (async (id) => call?.call_id === id ? call : null),
    delivery: options.delivery || (options.fetchImpl ? void 0 : async (device, data) => {
      sent.push({ device, data });
      return { ok: true };
    }),
    fetchImpl: options.fetchImpl,
    retryDelay: /* @__PURE__ */ __name(async () => {
    }, "retryDelay")
  });
  bridge.registerRoutes({ get: /* @__PURE__ */ __name((path, fn) => routes.set(`GET ${path}`, fn), "get"), post: /* @__PURE__ */ __name((path, fn) => routes.set(`POST ${path}`, fn), "post") });
  const request = /* @__PURE__ */ __name(async (method, path, body = {}, bearer = "", extra = {}) => {
    const key2 = path.startsWith(`${BASE2}/calls/`) ? `${BASE2}/calls/:callId` : path;
    const fn = routes.get(`${method} ${key2}`);
    assert4.ok(fn, `registered ${method} ${key2}`);
    const result = { status: 200, headers: {} };
    const res = { setHeader: /* @__PURE__ */ __name((k, v) => {
      result.headers[k] = v;
    }, "setHeader"), status(n) {
      result.status = n;
      return this;
    }, json(value) {
      result.body = value;
      return this;
    } };
    await fn({ body, headers: bearer ? { authorization: `Bearer ${bearer}` } : {}, params: { callId: decodeURIComponent(path.slice(`${BASE2}/calls/`.length)) }, ip: "test-peer", ...extra }, res);
    return result;
  }, "request");
  const register = /* @__PURE__ */ __name(async (extra = {}) => request("POST", `${BASE2}/devices/register`, { installationId: "install_1234567890abcdef", fcmToken: TOKEN2, enrollmentCode: CODE3, deviceLabel: "Test Android", ...extra }), "register");
  return { bridge, request, register, sent, devicesPath, setNow: /* @__PURE__ */ __name((value) => now = value, "setNow"), setCall: /* @__PURE__ */ __name((value) => call = value, "setCall") };
}
__name(harness2, "harness");
test3("disabled bridge returns no Firebase config and refuses enrollment", async () => {
  const h = await harness2({ env: {} }), config = await h.request("GET", `${BASE2}/config`);
  assert4.equal(config.body.enabled, false);
  assert4.equal(config.body.firebase, null);
  assert4.equal((await h.register()).status, 503);
});
test3("public config contains only public Firebase options, package and flags", async () => {
  const h = await harness2(), r = await h.request("GET", `${BASE2}/config`);
  assert4.equal(r.body.enabled, true);
  assert4.equal(r.body.enrollmentEnabled, true);
  assert4.equal(r.body.firebase.projectId, "sh-test-project");
  const json = JSON.stringify(r.body);
  assert4.ok(!json.includes("PRIVATE KEY"));
  assert4.ok(!json.includes(CODE3));
  assert4.equal(r.headers["Cache-Control"], "no-store");
});
test3("project mismatch fails closed", async () => {
  const e = env();
  e.SH_ANDROID_FIREBASE_PROJECT_ID = "different-project";
  const h = await harness2({ env: e });
  assert4.equal((await h.request("GET", `${BASE2}/config`)).body.enabled, false);
});
test3("wrong enrollment code and malformed inputs are rejected", async () => {
  const h = await harness2();
  assert4.equal((await h.register({ enrollmentCode: "wrong" })).status, 403);
  assert4.equal((await h.register({ installationId: "short" })).status, 400);
  assert4.equal((await h.register({ fcmToken: "bad" })).status, 400);
});
test3("enrollment stores only hashed bearer and consumes code durably", async () => {
  const h = await harness2(), r = await h.register();
  assert4.equal(r.status, 200);
  assert4.ok(r.body.deviceToken);
  const raw = await readFile2(h.devicesPath, "utf8");
  assert4.ok(!raw.includes(r.body.deviceToken));
  assert4.ok(!raw.includes(CODE3));
  assert4.equal((await stat(h.devicesPath)).mode & 511, 384);
  assert4.equal((await h.request("GET", `${BASE2}/config`)).body.enrollmentEnabled, false);
  assert4.equal((await h.register({ installationId: "other_install_1234567890" })).status, 409);
  const h2 = await harness2({ devicesPath: h.devicesPath });
  assert4.equal((await h2.register()).status, 409);
});
test3("concurrent enrollment cannot consume one code twice", async () => {
  const h = await harness2(), result = await Promise.all([h.register(), h.register({ installationId: "other_install_1234567890" })]);
  assert4.deepEqual(result.map((r) => r.status).sort(), [200, 409]);
});
test3("new admin code permits another device, old code remains consumed", async () => {
  const h = await harness2();
  await h.register();
  const nextCode = `${CODE3}_second`, e = { ...env(), SH_ANDROID_ENROLLMENT_CODE: nextCode };
  const h2 = await harness2({ devicesPath: h.devicesPath, env: e });
  assert4.equal((await h2.register({ enrollmentCode: nextCode, installationId: "install_second_1234567890" })).status, 200);
  const h3 = await harness2({ devicesPath: h.devicesPath });
  assert4.equal((await h3.register({ installationId: "install_third_1234567890" })).status, 409);
});
test3("unauthenticated calls/token/unregister fail even with trusted Origin", async () => {
  const h = await harness2();
  for (const [method, path] of [["GET", "/calls/call_1"], ["POST", "/devices/token"], ["POST", "/devices/unregister"]]) {
    const r = await h.request(method, BASE2 + path, {}, "", { headers: { origin: "https://www.smarthandicrafts.com" } });
    assert4.equal(r.status, 401);
  }
});
test3("bearer serves only minimal exact incoming call without SDP/phone/raw records", async () => {
  const h = await harness2(), r = await h.register(), answer = await h.request("GET", `${BASE2}/calls/call_1`, {}, r.body.deviceToken);
  assert4.equal(answer.status, 200);
  assert4.equal(answer.body.call.answerable, true);
  assert4.equal(answer.body.call.callId, "call_1");
  const raw = JSON.stringify(answer.body);
  assert4.ok(!raw.includes("PRIVATE SDP"));
  assert4.ok(!raw.includes("919999999999"));
  assert4.equal(new URL(answer.body.call.hubUrl).origin, "https://www.smarthandicrafts.com");
});
test3("unknown and outgoing exact calls are not exposed", async () => {
  const h = await harness2(), r = await h.register();
  assert4.equal((await h.request("GET", `${BASE2}/calls/no_such_call`, {}, r.body.deviceToken)).status, 404);
  h.setCall(incoming2("call_1", { direction: "outgoing" }));
  assert4.equal((await h.request("GET", `${BASE2}/calls/call_1`, {}, r.body.deviceToken)).status, 404);
});
test3("old/future/claimed incoming offers cannot be presented as answerable", async () => {
  const h = await harness2(), r = await h.register();
  for (const change of [{ started_at: new Date(NOW3 - 1e5).toISOString() }, { started_at: new Date(NOW3 + 6e3).toISOString() }, { handling: true }]) {
    h.setCall(incoming2("call_1", change));
    assert4.equal((await h.request("GET", `${BASE2}/calls/call_1`, {}, r.body.deviceToken)).body.call.answerable, false);
  }
});
test3("expired bearer cannot read or update", async () => {
  const h = await harness2(), r = await h.register();
  h.setNow(r.body.expiresAt + 1);
  assert4.equal((await h.request("GET", `${BASE2}/calls/call_1`, {}, r.body.deviceToken)).status, 401);
});
test3("token update and receiveCalls preference require same bearer", async () => {
  const h = await harness2(), r = await h.register();
  const result = await h.request("POST", `${BASE2}/devices/token`, { fcmToken: TOKEN2 + "new", receiveCalls: false }, r.body.deviceToken);
  assert4.equal(result.status, 200);
  assert4.equal(result.body.receiveCalls, false);
  await h.bridge.publishCallEvents([{ call_id: "call_1" }]);
  assert4.equal(h.sent.length, 0);
});
test3("self revocation removes FCM token and denies future reads", async () => {
  const h = await harness2(), r = await h.register();
  assert4.equal((await h.request("POST", `${BASE2}/devices/unregister`, {}, r.body.deviceToken)).status, 200);
  assert4.equal((await h.request("GET", `${BASE2}/calls/call_1`, {}, r.body.deviceToken)).status, 401);
  await h.bridge.publishCallEvents([{ call_id: "call_1" }]);
  assert4.equal(h.sent.length, 0);
});
test3("administrator revoked-ID environment denies existing device", async () => {
  const h = await harness2(), r = await h.register();
  const h2 = await harness2({ devicesPath: h.devicesPath, env: { ...env(), SH_ANDROID_REVOKED_DEVICE_IDS: r.body.deviceId } });
  assert4.equal((await h2.request("GET", `${BASE2}/calls/call_1`, {}, r.body.deviceToken)).status, 401);
  await h2.bridge.publishCallEvents([{ call_id: "call_1" }]);
  assert4.equal(h2.sent.length, 0);
});
test3("registration rate is bounded and caller-supplied proxy header does not bypass it", async () => {
  const h = await harness2();
  let r;
  for (let i = 0; i < 9; i++) r = await h.request("POST", `${BASE2}/devices/register`, { installationId: "install_1234567890abcdef", fcmToken: TOKEN2, enrollmentCode: "wrong" }, "", { headers: { "x-forwarded-for": `fake-${i}` } });
  assert4.equal(r.status, 429);
});
test3("malformed persistent registry fails closed instead of overwriting", async () => {
  const h = await harness2();
  await writeFile2(h.devicesPath, "broken");
  assert4.equal((await h.register()).status, 503);
  assert4.equal(await readFile2(h.devicesPath, "utf8"), "broken");
});
test3("incoming data is short lived and contains only exact routing state", async () => {
  const h = await harness2();
  await h.register();
  await h.bridge.publishCallEvents([{ call_id: "call_1" }]);
  assert4.equal(h.sent.length, 1);
  const d = h.sent[0].data;
  assert4.equal(d.type, "sh_operator_call");
  assert4.equal(d.event, "incoming");
  assert4.equal(d.call_id, "call_1");
  assert4.equal(Number(d.expires_at_ms) - Number(d.issued_at_ms), 3e4);
  assert4.ok(!JSON.stringify(d).includes("PRIVATE SDP"));
  assert4.ok(!JSON.stringify(d).includes("Test customer"));
});
test3("duplicate/parallel incoming webhook hints and restart produce one alert", async () => {
  const h = await harness2();
  await h.register();
  await Promise.all([h.bridge.publishCallEvents([{ call_id: "call_1" }]), h.bridge.publishCallEvents([{ call_id: "call_1" }])]);
  assert4.equal(h.sent.length, 1);
  const h2 = await harness2({ devicesPath: h.devicesPath });
  await h2.bridge.publishCallEvents([{ call_id: "call_1" }]);
  assert4.equal(h2.sent.length, 0);
});
test3("connected or terminal states cancel ringing only, preserving exact call ID", async () => {
  const h = await harness2();
  await h.register();
  await h.bridge.publishCallEvents([{ call_id: "call_1" }]);
  h.setCall(incoming2("call_1", { status: "connected", answerable: false }));
  await h.bridge.publishCallEvents([{ call_id: "call_1" }]);
  assert4.equal(h.sent[1].data.event, "ended");
  assert4.equal(h.sent[1].data.state, "connected");
  assert4.equal(h.sent[1].data.call_id, "call_1");
  h.setCall(incoming2("call_1", { status: "ended", active: false, answerable: false }));
  await h.bridge.publishCallEvents([{ call_id: "call_1" }]);
  assert4.equal(h.sent.length, 2);
});
test3("ended notification reaches opted-out device that was already ringing", async () => {
  const h = await harness2(), r = await h.register();
  await h.bridge.publishCallEvents([{ call_id: "call_1" }]);
  await h.request("POST", `${BASE2}/devices/token`, { fcmToken: TOKEN2, receiveCalls: false }, r.body.deviceToken);
  h.setCall(incoming2("call_1", { status: "missed", active: false, answerable: false }));
  await h.bridge.publishCallEvents([{ call_id: "call_1" }]);
  assert4.equal(h.sent.length, 2);
  assert4.equal(h.sent[1].data.event, "ended");
});
test3("unalerted terminal rows, outgoing rows and arbitrary event ids do not push", async () => {
  const h = await harness2();
  await h.register();
  h.setCall(incoming2("call_1", { status: "ended", active: false, answerable: false }));
  await h.bridge.publishCallEvents([{ call_id: "call_1" }]);
  h.setCall(incoming2("call_1", { direction: "outgoing" }));
  await h.bridge.publishCallEvents([{ call_id: "call_1" }]);
  h.setCall(incoming2());
  await h.bridge.publishCallEvents([{ id: "call_1" }]);
  assert4.equal(h.sent.length, 0);
});
test3("transient delivery failure retries once and later hints stay deduplicated", async () => {
  let attempts = 0;
  const h = await harness2({ delivery: /* @__PURE__ */ __name(async () => {
    attempts++;
    if (attempts === 1) throw Error("network");
    return { ok: true };
  }, "delivery") });
  await h.register();
  await h.bridge.publishCallEvents([{ call_id: "call_1" }]);
  await h.bridge.publishCallEvents([{ call_id: "call_1" }]);
  assert4.equal(attempts, 2);
  assert4.equal(h.bridge.status().sentCount, 1);
  assert4.equal(h.bridge.status().failedCount, 0);
});
test3("unregistered FCM tokens are removed without exposing secrets", async () => {
  const h = await harness2({ delivery: /* @__PURE__ */ __name(async () => {
    throw Object.assign(Error("unregistered"), { unregistered: true, status: 404 });
  }, "delivery") });
  await h.register();
  await h.bridge.publishCallEvents([{ call_id: "call_1" }]);
  const saved = JSON.parse(await readFile2(h.devicesPath, "utf8"));
  assert4.equal(saved.devices[0].fcmToken, "");
});
test3("Firebase HTTPv1 OAuth scope, token caching, fixed hosts and Android TTL are correct", async () => {
  const requests = [];
  const fetchImpl = /* @__PURE__ */ __name(async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, json: /* @__PURE__ */ __name(async () => url.includes("oauth2") ? { access_token: "test_oauth", expires_in: 3600 } : { name: "projects/sh-test-project/messages/test" }, "json") };
  }, "fetchImpl");
  const h = await harness2({ fetchImpl });
  await h.register();
  await h.bridge.publishCallEvents([{ call_id: "call_1" }]);
  h.setCall(incoming2("call_2"));
  await h.bridge.publishCallEvents([{ call_id: "call_2" }]);
  assert4.equal(requests.filter((row) => row.url.includes("oauth2")).length, 1);
  const claims2 = JSON.parse(Buffer.from(new URLSearchParams(requests[0].options.body).get("assertion").split(".")[1], "base64url"));
  assert4.equal(claims2.scope, "https://www.googleapis.com/auth/firebase.messaging");
  assert4.equal(claims2.aud, "https://oauth2.googleapis.com/token");
  const send = JSON.parse(requests[1].options.body);
  assert4.equal(send.message.android.ttl, "30s");
  assert4.equal(send.message.android.priority, "HIGH");
  assert4.equal(send.message.android.restricted_package_name, "com.smarthandicrafts.operatorhub");
  assert4.equal(requests[1].options.redirect, "error");
});
test3("new terminal state appearing during queued incoming work prevents stale ringing", async () => {
  let reads = 0;
  const h = await harness2({ readCall: /* @__PURE__ */ __name(async () => {
    reads++;
    return incoming2("call_1", reads > 1 ? { status: "ended", active: false, answerable: false } : {});
  }, "readCall") });
  await h.register();
  await h.bridge.publishCallEvents([{ call_id: "call_1" }]);
  assert4.equal(h.sent.length, 0);
});
var inboundMessage2 = /* @__PURE__ */ __name((change = {}) => ({
  verifiedIncoming: true,
  channel: { id: 123, channel_type: "whatsapp" },
  message: { id: 456, model: "discuss.channel", res_id: 123, date: new Date(NOW3).toISOString(), body: "PRIVATE CUSTOMER BODY" },
  ...change
}), "inboundMessage");
test3("only explicit trusted inbound message callbacks can produce native alerts", async () => {
  const h = await harness2();
  await h.register();
  await h.bridge.publishMessage(inboundMessage2({ verifiedIncoming: false }));
  await h.bridge.publishMessage(inboundMessage2({ verifiedIncoming: void 0 }));
  assert4.equal(h.sent.length, 0);
  await h.bridge.publishMessage(inboundMessage2());
  assert4.equal(h.sent.length, 1);
});
test3("message payload exposes exact positive routing IDs and no content", async () => {
  const h = await harness2();
  await h.register();
  await h.bridge.publishMessage(inboundMessage2());
  const d = h.sent[0].data;
  assert4.equal(d.type, "sh_operator_message");
  assert4.equal(d.channel_id, "123");
  assert4.equal(d.message_id, "456");
  assert4.equal(Number(d.expires_at_ms) - Number(d.issued_at_ms), 3e5);
  assert4.ok(!JSON.stringify(d).includes("PRIVATE CUSTOMER BODY"));
  const url = new URL(d.hub_url);
  assert4.equal(url.origin, "https://www.smarthandicrafts.com");
  assert4.equal(url.searchParams.get("channel_id"), "123");
});
test3("synthetic tests, wrong model/channel, internal groups and old messages are excluded", async () => {
  const h = await harness2();
  await h.register();
  const baseline = inboundMessage2();
  for (const change of [
    { message: { ...baseline.message, id: "test-123" } },
    { message: { ...baseline.message, model: "sale.order" } },
    { message: { ...baseline.message, res_id: 999 } },
    { channel: { id: 123, channel_type: "channel" } },
    { message: { ...baseline.message, date: new Date(NOW3 - 300001).toISOString() } },
    { message: { ...baseline.message, date: new Date(NOW3 + 5001).toISOString() } }
  ]) await h.bridge.publishMessage(inboundMessage2(change));
  assert4.equal(h.sent.length, 0);
});
test3("message dedupe survives concurrent worker/Zapier callbacks and server restart", async () => {
  const h = await harness2();
  await h.register();
  await Promise.all([h.bridge.publishMessage(inboundMessage2()), h.bridge.publishMessage(inboundMessage2())]);
  assert4.equal(h.sent.length, 1);
  const h2 = await harness2({ devicesPath: h.devicesPath });
  await h2.bridge.publishMessage(inboundMessage2());
  assert4.equal(h2.sent.length, 0);
});
test3("message opt-out and revoked bearer prevent additional delivery", async () => {
  const h = await harness2(), r = await h.register();
  await h.request("POST", `${BASE2}/devices/token`, { fcmToken: TOKEN2, receiveChats: false }, r.body.deviceToken);
  await h.bridge.publishMessage(inboundMessage2());
  assert4.equal(h.sent.length, 0);
  await h.request("POST", `${BASE2}/devices/token`, { fcmToken: TOKEN2, receiveChats: true }, r.body.deviceToken);
  await h.request("POST", `${BASE2}/devices/unregister`, {}, r.body.deviceToken);
  await h.bridge.publishMessage(inboundMessage2());
  assert4.equal(h.sent.length, 0);
});
test3("newly enrolled devices are not flooded with older message history", async () => {
  const h = await harness2();
  h.setNow(NOW3 + 6e4);
  await h.register();
  await h.bridge.publishMessage(inboundMessage2());
  assert4.equal(h.sent.length, 0);
});
test3("Odoo UTC date format is accepted without host-timezone dependency", async () => {
  const h = await harness2();
  await h.register();
  const value = inboundMessage2();
  value.message.date = new Date(NOW3).toISOString().replace("T", " ").slice(0, 19);
  await h.bridge.publishMessage(value);
  assert4.equal(h.sent.length, 1);
});
test3("FCM message request uses dedicated per-channel collapse and bounded five-minute TTL", async () => {
  const requests = [];
  const fetchImpl = /* @__PURE__ */ __name(async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, json: /* @__PURE__ */ __name(async () => url.includes("oauth2") ? { access_token: "test_oauth", expires_in: 3600 } : { name: "projects/sh-test-project/messages/test" }, "json") };
  }, "fetchImpl");
  const h = await harness2({ fetchImpl });
  await h.register();
  await h.bridge.publishMessage(inboundMessage2());
  const payload = JSON.parse(requests[1].options.body);
  assert4.equal(payload.message.android.collapse_key, "sh-chat-123");
  assert4.equal(payload.message.android.ttl, "300s");
  assert4.equal(payload.message.android.priority, "HIGH");
  assert4.equal(payload.message.notification, void 0);
});
test3("cloud test is authenticated and sends only to the authenticated installation", async () => {
  const h = await harness2();
  assert4.equal((await h.request("POST", `${BASE2}/devices/test`)).status, 401);
  const r = await h.register();
  const result = await h.request("POST", `${BASE2}/devices/test`, { fcmToken: "arbitrary_other_device_token" }, r.body.deviceToken);
  assert4.equal(result.status, 200);
  assert4.equal(result.body.accepted, true);
  assert4.equal(result.body.delivered, void 0);
  assert4.equal(h.sent.length, 1);
  assert4.equal(h.sent[0].device.fcmToken, TOKEN2);
  assert4.equal(h.sent[0].data.type, "sh_operator_test");
  assert4.equal(h.sent[0].data.test_id, result.body.testId);
  assert4.equal(Number(h.sent[0].data.expires_at_ms) - Number(h.sent[0].data.issued_at_ms), 3e5);
});
test3("cloud test has a dedicated three-per-minute bound", async () => {
  const h = await harness2(), r = await h.register();
  let result;
  for (let i = 0; i < 4; i++) result = await h.request("POST", `${BASE2}/devices/test`, {}, r.body.deviceToken);
  assert4.equal(result.status, 429);
  assert4.equal(h.sent.length, 3);
});
test3("cloud test FCM failure is not represented as device receipt or accepted success", async () => {
  const h = await harness2({ delivery: /* @__PURE__ */ __name(async () => {
    throw Error("network");
  }, "delivery") }), r = await h.register();
  const result = await h.request("POST", `${BASE2}/devices/test`, {}, r.body.deviceToken);
  assert4.equal(result.status, 503);
  assert4.equal(result.body.ok, false);
});
test3("actual patched worker notifies photo-only messages then stops before AI in all modes", async () => {
  const source = await readFile2(new URL("../../server.js", new URL("./operator-storage/operator-android-push.test.js", import.meta.url).href), "utf8");
  const code = source.slice(source.indexOf("async function aiModeProcessWorkerMessage("), source.indexOf("async function aiModeBackgroundTick("));
  const helper = source.slice(source.indexOf("function aiModeHasWorkerAttachments("), source.indexOf("function aiModeMessagePlainText("));
  for (const mode of ["manual", "assist", "chat", "zapier"]) {
    const pushed = [], processed = [];
    const context = {
      Date: { now: /* @__PURE__ */ __name(() => NOW3 + 1e4, "now") },
      console: { log() {
      } },
      aiModeMessagePlainText: /* @__PURE__ */ __name((m) => m.body || "", "aiModeMessagePlainText"),
      aiModeParseOdooDateMs: Date.parse,
      aiModeGlobalState: { mode, enabled_since_ms: 0 },
      AI_MODE_BACKGROUND_START_GRACE_MS: 0,
      AI_MODE_BACKGROUND_CUSTOMER_SETTLE_MS: 1e3,
      aiModeBackgroundState: { processed_count: 0 },
      aiModeBackgroundRememberProcessedId: /* @__PURE__ */ __name(async (id) => processed.push(id), "aiModeBackgroundRememberProcessedId"),
      sendOperatorPushNotification: /* @__PURE__ */ __name(async (value) => {
        pushed.push(value);
        return { ok: true };
      }, "sendOperatorPushNotification"),
      sendIncomingWhatsAppToZapier: /* @__PURE__ */ __name(() => {
        throw Error("Must not invoke Zapier for attachment-only messages");
      }, "sendIncomingWhatsAppToZapier"),
      aiModeCallLocalDecisionEngine: /* @__PURE__ */ __name(() => {
        throw Error("Must not invoke AI for attachment-only messages");
      }, "aiModeCallLocalDecisionEngine")
    };
    vm.runInNewContext(helper + code + ";this.process=aiModeProcessWorkerMessage;", context);
    const result = await context.process({ uid: 1, userContext: {}, channel: { id: 123 }, messages: [], latestCustomerMessage: { id: 456, date: new Date(NOW3).toISOString(), body: "", attachment_ids: [77] } });
    assert4.equal(result.attachment_only, true);
    assert4.equal(pushed.length, 1);
    assert4.equal(pushed[0].nativeIncomingVerified, true);
    assert4.deepEqual(processed, [456]);
  }
});
test3("actual patched worker still rejects genuinely empty messages without triggering AI", async () => {
  const source = await readFile2(new URL("../../server.js", new URL("./operator-storage/operator-android-push.test.js", import.meta.url).href), "utf8");
  const code = source.slice(source.indexOf("async function aiModeProcessWorkerMessage("), source.indexOf("async function aiModeBackgroundTick("));
  const helper = source.slice(source.indexOf("function aiModeHasWorkerAttachments("), source.indexOf("function aiModeMessagePlainText("));
  const context = { aiModeMessagePlainText: /* @__PURE__ */ __name((m) => m.body || "", "aiModeMessagePlainText") };
  vm.runInNewContext(helper + code + ";this.process=aiModeProcessWorkerMessage;", context);
  const result = await context.process({ latestCustomerMessage: { body: "", attachment_ids: [] } });
  assert4.equal(result.skipped, "empty_message");
});
test3("generated backend hooks native paths without depending on Web Push readiness", async () => {
  const source = await readFile2(new URL("../../server.js", new URL("./operator-storage/operator-android-push.test.js", import.meta.url).href), "utf8");
  const begin = source.indexOf("async function sendOperatorPushNotification("), next = source.indexOf("const zapierIncomingWhatsAppState", begin);
  const piece = source.slice(begin, next);
  assert4.ok(piece.indexOf("androidPushBridge.publishMessage") < piece.indexOf("if (!WEB_PUSH_ENABLED)"));
  assert4.equal((source.match(/nativeIncomingVerified: true/g) || []).length, 2);
  assert4.equal((source.match(/androidPushBridge.publishCallEvents\(/g) || []).length, 2);
  const fetched = source.slice(source.indexOf("async function aiModeFetchRecentWorkerMessages"), source.indexOf("function aiModeBuildWorkerConversationHistory"));
  assert4.equal((fetched.match(/"attachment_ids"/g) || []).length, 2);
  const publicTest = source.slice(source.indexOf('app.post("/api/push/test"'), source.indexOf("async function sendManualWhatsappCallPushTest"));
  assert4.ok(!publicTest.includes("nativeIncomingVerified"));
});

// tests/operator-storage/firestore-integration.test.js
/*! SOURCE tests/operator-storage/firestore-integration.test.js | SHA-256 5c40b65f58f289825aa665193ada8b1e36c9da9e30332867919e80201ee7ec10 */
import test4 from "node:test";
import assert5 from "node:assert/strict";
import { access as access2 } from "node:fs/promises";
import { createFirestoreDeviceRegistry as createFirestoreDeviceRegistry2 } from "../operator-firestore-registry.js";
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
__name(deferred, "deferred");
async function setup2() {
  const firestore = new FirestoreFake();
  const state = { now: NOW, call: incoming() };
  const registry = /* @__PURE__ */ __name(() => createFirestoreDeviceRegistry2({ firestore, clock: /* @__PURE__ */ __name(() => state.now, "clock"), bootstrapEnrollmentCode: CODE }), "registry");
  const create = /* @__PURE__ */ __name(async (options) => harness({
    deviceRegistry: registry(),
    clock: /* @__PURE__ */ __name(() => state.now, "clock"),
    readCall: /* @__PURE__ */ __name(async (id) => state.call?.call_id === id ? state.call : null, "readCall"),
    ...options
  }), "create");
  return { firestore, state, registry, create };
}
__name(setup2, "setup");
test4("Firestore readiness works with no legacy enrollment code and advertises administrator invitations", async () => {
  const s = await setup2();
  const h = await s.create({ env: { ...makeEnv(), SH_ANDROID_ENROLLMENT_CODE: "", SH_ANDROID_REGISTRY_BACKEND: " firestore " } });
  const ready = await h.request("GET", `${BASE}/config`);
  assert5.equal(ready.body.storageAvailable, true);
  assert5.equal(ready.body.enrollmentEnabled, false);
  assert5.equal(ready.body.capabilities.enrollmentInvitations, true);
  const invitation = await s.registry().issueEnrollment();
  assert5.equal((await h.register({ enrollmentCode: invitation.enrollmentCode })).status, 200);
});
test4("readiness failure is never overwritten by an available enrollment code", async () => {
  const s = await setup2();
  const registry = s.registry();
  const h = await s.create({ deviceRegistry: { ...registry, checkAvailability: /* @__PURE__ */ __name(async () => {
    throw Error("storage metadata unavailable");
  }, "checkAvailability") } });
  const result = await h.request("GET", `${BASE}/config`);
  assert5.equal(result.body.enrollmentEnabled, true);
  assert5.equal(result.body.storageAvailable, false);
});
test4("bridge enrollment and authentication survive backend replacement without an Odoo dependency or a local file", async () => {
  const s = await setup2(), first = await s.create(), enrolled = await first.register(), restarted = await s.create();
  assert5.equal(enrolled.status, 200);
  assert5.equal((await restarted.request("GET", `${BASE}/calls/call_1`, {}, enrolled.body.deviceToken)).status, 200);
  assert5.equal((await restarted.request("GET", `${BASE}/config`)).body.enrollmentEnabled, false);
  assert5.equal((await restarted.register({ installationId: "another_install_12345678" })).status, 409);
  await assert5.rejects(access2(first.devicesPath), { code: "ENOENT" });
  await assert5.rejects(access2(restarted.devicesPath), { code: "ENOENT" });
});
test4("two server instances cannot consume one enrollment code for different installations", async () => {
  const s = await setup2(), first = await s.create(), second = await s.create();
  const results = await Promise.all([first.register(), second.register({ installationId: "another_install_12345678" })]);
  assert5.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert5.equal((await s.registry().listDevices()).length, 1);
});
test4("a lost enrollment commit response can be recovered by the exact original installation", async () => {
  const s = await setup2(), first = await s.create();
  s.firestore.failAfterCommit = Error("simulated lost commit acknowledgement");
  assert5.equal((await first.register()).status, 503);
  const replay = await (await s.create()).register();
  assert5.equal(replay.status, 200);
  assert5.equal(replay.body.replayed, true);
  assert5.equal((await first.request("GET", `${BASE}/calls/call_1`, {}, replay.body.deviceToken)).status, 200);
  assert5.equal((await s.registry().listDevices()).length, 1);
});
test4("server storage permission outages preserve enrollment and advertise retryable availability", async () => {
  const s = await setup2(), first = await s.create(), enrolled = await first.register();
  const before = s.firestore.dump();
  s.firestore.failReads = Object.assign(Error("private IAM account details"), { status: 401, code: 7 });
  const unavailable = await first.request("GET", `${BASE}/calls/call_1`, {}, enrolled.body.deviceToken);
  assert5.equal(unavailable.status, 503);
  assert5.equal(unavailable.headers["Retry-After"], "5");
  const config = await first.request("GET", `${BASE}/config`);
  assert5.equal(config.body.storageAvailable, false);
  assert5.equal(config.body.capabilities.deviceLeaseRenewal, true);
  assert5.deepEqual(s.firestore.dump(), before);
  s.firestore.failReads = null;
  assert5.equal((await first.request("GET", `${BASE}/calls/call_1`, {}, enrolled.body.deviceToken)).status, 200);
});
test4("transactional delivery claims suppress simultaneous incoming notifications across server instances and restart", async () => {
  const s = await setup2(), entered = deferred(), release = deferred(), sends = [];
  const delivery = /* @__PURE__ */ __name(async (device, data) => {
    sends.push(data);
    entered.resolve();
    await release.promise;
    return { ok: true };
  }, "delivery");
  const first = await s.create({ delivery }), second = await s.create({ delivery });
  await first.register();
  const work = Promise.all([first.bridge.publishCallEvents([{ call_id: "call_1" }]), second.bridge.publishCallEvents([{ call_id: "call_1" }])]);
  await entered.promise;
  release.resolve();
  await work;
  assert5.equal(sends.length, 1);
  const restarted = await s.create();
  await restarted.bridge.publishCallEvents([{ call_id: "call_1" }]);
  assert5.equal(restarted.sent.length, 0);
  assert5.equal((await s.registry().getDeliveries({ callId: "call_1" }))[0].state, "sent");
});
test4("the actual registry deduplicates simultaneous Odoo worker and Zapier message hints across instances", async () => {
  const s = await setup2(), first = await s.create(), second = await s.create();
  await first.register();
  await Promise.all([first.bridge.publishMessage(inboundMessage()), second.bridge.publishMessage(inboundMessage())]);
  assert5.equal(first.sent.length + second.sent.length, 1);
  const restarted = await s.create();
  await restarted.bridge.publishMessage(inboundMessage());
  assert5.equal(restarted.sent.length, 0);
});
test4("an ended event cancels an in-flight incoming attempt and blocks a later stale incoming hint", async () => {
  const s = await setup2(), entered = deferred(), release = deferred(), received = [];
  const delivery = /* @__PURE__ */ __name(async (device, data) => {
    if (data.event === "incoming") {
      entered.resolve();
      await release.promise;
    }
    received.push(data);
    return { ok: true };
  }, "delivery");
  const first = await s.create({ delivery }), second = await s.create({ delivery });
  await first.register();
  const ringing = first.bridge.publishCallEvents([{ call_id: "call_1" }]);
  await entered.promise;
  s.state.call = incoming({ status: "ended", active: false, answerable: false });
  await second.bridge.publishCallEvents([{ call_id: "call_1" }]);
  assert5.equal(received[0].event, "ended");
  release.resolve();
  await ringing;
  assert5.equal(received[1].event, "incoming");
  s.state.call = incoming();
  const restarted = await s.create();
  await restarted.bridge.publishCallEvents([{ call_id: "call_1" }]);
  assert5.equal(restarted.sent.length, 0);
});
test4("failed incoming sends remain eligible for a later terminal cancellation", async () => {
  const s = await setup2();
  const first = await s.create({ delivery: /* @__PURE__ */ __name(async () => {
    throw Error("ambiguous network response");
  }, "delivery") });
  await first.register();
  await first.bridge.publishCallEvents([{ call_id: "call_1" }]);
  assert5.equal((await s.registry().getDeliveries({ callId: "call_1" }))[0].state, "failed");
  s.state.call = incoming({ status: "missed", active: false, answerable: false });
  const next = await s.create();
  await next.bridge.publishCallEvents([{ call_id: "call_1" }]);
  assert5.equal(next.sent.length, 1);
  assert5.equal(next.sent[0].data.event, "ended");
});
test4("FCM acceptance followed by a receipt write failure retains the send claim and avoids immediate duplicate delivery", async () => {
  const s = await setup2();
  let attempts = 0;
  const first = await s.create({ delivery: /* @__PURE__ */ __name(async () => {
    attempts++;
    s.firestore.failBeforeCommit = Error("receipt storage unavailable");
    return { ok: true };
  }, "delivery") });
  await first.register();
  const result = await first.bridge.publishCallEvents([{ call_id: "call_1" }]);
  assert5.equal(result[0].failed, 1);
  assert5.equal(first.bridge.status().sentCount, 0);
  assert5.equal((await s.registry().getDeliveries({ callId: "call_1" }))[0].state, "claimed");
  const next = await s.create();
  await next.bridge.publishCallEvents([{ call_id: "call_1" }]);
  assert5.equal(attempts, 1);
  assert5.equal(next.sent.length, 0);
});
test4("lost receipt commit acknowledgement does not resend a receipt that actually committed", async () => {
  const s = await setup2();
  const first = await s.create({ delivery: /* @__PURE__ */ __name(async () => {
    s.firestore.failAfterCommit = Error("lost receipt ACK");
    return { ok: true };
  }, "delivery") });
  await first.register();
  await first.bridge.publishCallEvents([{ call_id: "call_1" }]);
  assert5.equal((await s.registry().getDeliveries({ callId: "call_1" }))[0].state, "sent");
  const next = await s.create();
  await next.bridge.publishCallEvents([{ call_id: "call_1" }]);
  assert5.equal(next.sent.length, 0);
});
test4("stale receipt ownership is not reported as a successfully persisted notification", async () => {
  const s = await setup2(), deviceRegistry = s.registry();
  const first = await s.create({ deviceRegistry: { ...deviceRegistry, finishDelivery: /* @__PURE__ */ __name(async () => ({ finished: false }), "finishDelivery") } });
  await first.register();
  const result = await first.bridge.publishCallEvents([{ call_id: "call_1" }]);
  assert5.equal(result[0].sent, 0);
  assert5.equal(result[0].failed, 1);
  assert5.equal(first.bridge.status().sentCount, 0);
});
test4("revocation between a send claim and dispatch prevents the FCM request", async () => {
  const s = await setup2(), deviceRegistry = s.registry();
  let token;
  const first = await s.create({ deviceRegistry: { ...deviceRegistry, claimDelivery: /* @__PURE__ */ __name(async (value) => {
    const claim = await deviceRegistry.claimDelivery(value);
    if (claim.claimed) await deviceRegistry.revoke(token);
    return claim;
  }, "claimDelivery") } });
  token = (await first.register()).body.deviceToken;
  await first.bridge.publishCallEvents([{ call_id: "call_1" }]);
  assert5.equal(first.sent.length, 0);
  assert5.equal((await first.request("GET", `${BASE}/calls/call_1`, {}, token)).status, 401);
  assert5.equal((await deviceRegistry.getDeliveries({ callId: "call_1" }))[0].state, "cancelled");
});
test4("an unregistered old FCM token cannot erase a concurrently refreshed token", async () => {
  const s = await setup2(), deviceRegistry = s.registry();
  let token;
  const first = await s.create({ delivery: /* @__PURE__ */ __name(async () => {
    await deviceRegistry.updateToken(token, { fcmToken: TOKEN + "_new" });
    throw Object.assign(Error("old token unregistered"), { unregistered: true, status: 404 });
  }, "delivery") });
  const registered = await first.register();
  token = registered.body.deviceToken;
  await first.bridge.publishCallEvents([{ call_id: "call_1" }]);
  assert5.equal((await deviceRegistry.getDevice(registered.body.deviceId)).fcmToken, TOKEN + "_new");
});
test4("concurrent renewal and FCM refresh retain both changes across another backend replacement", async () => {
  const s = await setup2(), first = await s.create(), second = await s.create(), registered = await first.register();
  s.state.now = NOW + 29 * 864e5;
  const results = await Promise.all([
    first.request("POST", `${BASE}/devices/renew`, {}, registered.body.deviceToken),
    second.request("POST", `${BASE}/devices/token`, { fcmToken: TOKEN + "_refresh", receiveChats: false }, registered.body.deviceToken)
  ]);
  assert5.deepEqual(results.map((result) => result.status), [200, 200]);
  const row = await s.registry().getDevice(registered.body.deviceId);
  assert5.equal(row.fcmToken, TOKEN + "_refresh");
  assert5.equal(row.receiveChats, false);
  assert5.ok(row.tokenExpiresAt > registered.body.expiresAt);
  s.state.now = registered.body.expiresAt + 1;
  const restarted = await s.create();
  assert5.equal((await restarted.request("GET", `${BASE}/calls/call_1`, {}, registered.body.deviceToken)).status, 200);
});
test4("a slow authoritative call read cannot dispatch an alert after its payload expiry", async () => {
  const s = await setup2();
  let reads = 0;
  const first = await s.create({ readCall: /* @__PURE__ */ __name(async () => {
    reads++;
    if (reads === 3) s.state.now += 31e3;
    return incoming();
  }, "readCall") });
  await first.register();
  await first.bridge.publishCallEvents([{ call_id: "call_1" }]);
  assert5.equal(first.sent.length, 0);
  assert5.equal((await s.registry().getDeliveries({ callId: "call_1" }))[0].state, "cancelled");
});

// tests/operator-firestore-runtime.test.mjs
/*! SOURCE tests/operator-firestore-runtime.test.mjs | SHA-256 a7e8e8afcf81633d0283f30830d0abab43604b1a225852f42510563182a3c8f4 */
import test5 from "node:test";
import assert6 from "node:assert/strict";
import { generateKeyPairSync as generateKeyPairSync3 } from "node:crypto";
import { createOperatorFirestoreRuntime } from "../operator-firestore-runtime.js";
var key = generateKeyPairSync3("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
var account = {
  type: "service_account",
  project_id: "demo-sh-runtime",
  client_email: "runtime@demo-sh-runtime.iam.gserviceaccount.com",
  private_key: key
};
var env2 = {
  SH_ANDROID_REGISTRY_BACKEND: "firestore",
  SH_ANDROID_FIREBASE_PROJECT_ID: "demo-sh-runtime",
  SH_ANDROID_FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(account),
  SH_ANDROID_ENROLLMENT_CODE: "old_consumed_code_1234567890abcdef1234567890"
};
var logs = [];
var logger = { warn: /* @__PURE__ */ __name((value) => logs.push(value), "warn") };
function harness3(overrides = {}) {
  let settings, options, closed = false;
  class FakeFirestore {
    static {
      __name(this, "FakeFirestore");
    }
    constructor(value) {
      settings = value;
    }
    async terminate() {
      closed = true;
    }
  }
  const runtime = createOperatorFirestoreRuntime({
    env: { ...env2, ...overrides },
    logger,
    FirestoreClass: FakeFirestore,
    registryFactory: /* @__PURE__ */ __name((value) => {
      options = value;
      return { testRegistry: true };
    }, "registryFactory")
  });
  return { runtime, settings, options, isClosed: /* @__PURE__ */ __name(() => closed, "isClosed") };
}
__name(harness3, "harness");
test5("legacy mode does not initialize a database or inspect private credentials", () => {
  const h = harness3({ SH_ANDROID_REGISTRY_BACKEND: "file", SH_ANDROID_FIREBASE_SERVICE_ACCOUNT_JSON: "invalid" });
  assert6.equal(h.runtime.backend, "file");
  assert6.equal(h.settings, void 0);
});
test5("Firestore reuses only the server account for the exact configured project", async () => {
  const h = harness3();
  assert6.equal(h.runtime.configured, true);
  assert6.equal(h.settings.projectId, "demo-sh-runtime");
  assert6.equal(h.settings.databaseId, "(default)");
  assert6.equal(h.options.collectionPrefix, "sh_operator");
  assert6.equal(h.settings.credentials.private_key, key);
  await h.runtime.close();
  assert6.equal(h.isClosed(), true);
});
test5("a possibly consumed legacy enrollment code is disabled by default", () => {
  assert6.equal(harness3().options.bootstrapEnrollmentCode, "");
  assert6.equal(harness3({ SH_FIRESTORE_ALLOW_BOOTSTRAP_ENROLLMENT: "true" }).options.bootstrapEnrollmentCode, env2.SH_ANDROID_ENROLLMENT_CODE);
});
test5("invalid account, project, namespace and endpoint settings cannot fall back to file storage", () => {
  for (const value of [
    { SH_ANDROID_FIREBASE_SERVICE_ACCOUNT_JSON: "{broken" },
    { SH_ANDROID_FIREBASE_PROJECT_ID: "other-project" },
    { SH_OPERATOR_FIRESTORE_PREFIX: "nested/path" },
    { SH_OPERATOR_FIRESTORE_DATABASE: "bad/endpoint" },
    { FIRESTORE_EMULATOR_HOST: "untrusted.example:443" },
    { SH_ANDROID_REGISTRY_BACKEND: "typo" }
  ]) {
    const h = harness3(value);
    assert6.equal(h.runtime.configured, false);
    assert6.equal(h.runtime.deviceRegistry, void 0);
    assert6.notEqual(h.runtime.backend, "file");
    assert6.equal(h.settings, void 0);
  }
  assert6.ok(!logs.join("\n").includes("PRIVATE KEY"));
  assert6.ok(!logs.join("\n").includes("runtime@"));
});
test5("initialization error is sanitized and never exposes a credential", () => {
  class BrokenFirestore {
    static {
      __name(this, "BrokenFirestore");
    }
    constructor() {
      throw Error(`secret ${key}`);
    }
  }
  const runtime = createOperatorFirestoreRuntime({ env: env2, logger, FirestoreClass: BrokenFirestore });
  assert6.equal(runtime.configured, false);
  assert6.equal(runtime.deviceRegistry, void 0);
  assert6.ok(!logs.join("\n").includes(key));
});

// media-store/test/firestore-fake.mjs
/*! SOURCE media-store/test/firestore-fake.mjs | SHA-256 567af2e7a81bef4c5bc094b0497770e477c71d8aebcf93eff8878528ed73085f */
var clone2 = /* @__PURE__ */ __name((value) => structuredClone(value), "clone");
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
    this.documents = /* @__PURE__ */ new Map();
    this.versions = /* @__PURE__ */ new Map();
    this.collectionVersions = /* @__PURE__ */ new Map();
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
      const reads = /* @__PURE__ */ new Map(), queries = /* @__PURE__ */ new Map(), writes = /* @__PURE__ */ new Map();
      let wrote = false;
      const tx = {
        get: /* @__PURE__ */ __name(async (reference) => {
          if (wrote) throw Error("Reads must precede native writes");
          if (this.failReads) throw this.failReads;
          if (reference instanceof Doc) {
            reads.set(reference.path, versions.get(reference.path) || 0);
            return this.snapshot(reference, records);
          }
          queries.set(reference.path, collectionVersions.get(reference.path) || 0);
          return this.query(reference, records);
        }, "get"),
        set: /* @__PURE__ */ __name((ref, value) => {
          wrote = true;
          writes.set(ref.path, { ref, value: clone2(value) });
          return tx;
        }, "set"),
        create: /* @__PURE__ */ __name((ref, value) => {
          wrote = true;
          writes.set(ref.path, { ref, value: clone2(value), create: true });
          return tx;
        }, "create"),
        delete: /* @__PURE__ */ __name((ref) => {
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

// call-runtime/test/helpers.mjs
/*! SOURCE call-runtime/test/helpers.mjs | SHA-256 d5c8b843dd69e03b5a7035e480f0180a90c06d3d2f41fcf72559f004ba021d67 */
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
  const actor = /* @__PURE__ */ __name(async (context) => {
    const row = devices.get(typeof context === "string" ? context : context.device);
    return row ? { ...row, authenticated: true, canCall: true } : null;
  }, "actor");
  const resolveDevice = /* @__PURE__ */ __name(async (id) => structuredClone(devices.get(id)), "resolveDevice");
  const store = options.store || createFirestoreMediaStore({ firestore: db, clock: /* @__PURE__ */ __name(() => time, "clock") });
  const provider = {
    kind: "livekit-whatsapp",
    config: { fingerprint: "test-project-only", wsUrl: "wss://test.livekit.cloud" },
    rooms: { listParticipants: /* @__PURE__ */ __name(async () => [], "listParticipants") },
    probeControlApi: /* @__PURE__ */ __name(async () => ({ controlApiReachable: true, fingerprint: "test-project-only", audioVerified: false }), "probeControlApi"),
    acceptIncoming: /* @__PURE__ */ __name(async (data) => {
      effects.push({ kind: "accept", ...data });
      return {
        callId: data.callId,
        roomName: data.roomName,
        customerIdentity: customerIdentity(data.callId)
      };
    }, "acceptIncoming"),
    dialOutgoing: /* @__PURE__ */ __name(async (data) => {
      effects.push({ kind: "dial", ...data });
      return {
        callId: "call-out-1",
        roomName: data.roomName,
        customerIdentity: customerIdentity(data.requestId)
      };
    }, "dialOutgoing"),
    connectOutgoing: /* @__PURE__ */ __name(async (data) => {
      effects.push({ kind: "connect", ...data });
    }, "connectOutgoing"),
    issueOperatorJoin: /* @__PURE__ */ __name(async (data) => ({
      url: "wss://test.livekit.cloud",
      token: "synthetic-test-token",
      roomName: data.roomName,
      identity: operatorIdentity(data.deviceId, data.legId)
    }), "issueOperatorJoin"),
    inspectParticipants: /* @__PURE__ */ __name(async () => ({
      observedAt: time,
      customerActive: true,
      customerAudioPublished: true,
      operatorActive: true,
      operatorAudioPublished: true,
      sourceActive: true
    }), "inspectParticipants"),
    detachOperator: /* @__PURE__ */ __name(async (data) => {
      effects.push({ ...data, kind: "detach" });
    }, "detachOperator"),
    terminateCustomer: /* @__PURE__ */ __name(async (data) => {
      effects.push({ ...data, kind: "terminate" });
    }, "terminateCustomer"),
    ...options.provider
  };
  const proof = /* @__PURE__ */ __name(({ actor: who, call, transfer }) => ({
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
    now: /* @__PURE__ */ __name(() => time, "now"),
    rolloutGuard: /* @__PURE__ */ __name(async () => ({
      enabled: true,
      provider: provider.kind,
      clientProtocol: "sh-room-audio-v1",
      liveTwoDeviceEvidenceId: "SYNTHETIC-UNIT-TEST-NOT-LIVE"
    }), "rolloutGuard"),
    verifyReadiness: /* @__PURE__ */ __name(async (data) => proof(data), "verifyReadiness"),
    verifyProviderEvent: /* @__PURE__ */ __name(async (data) => data?.runtimeVerifiedMetaEvent?.verified ? { verified: true, type: "terminated", callId: data.runtimeVerifiedMetaEvent.callId } : null, "verifyProviderEvent")
  });
  const runtime = new CallRuntime({
    store,
    provider,
    transferController: controller,
    authenticate: actor,
    resolveDevice,
    listDevices: /* @__PURE__ */ __name(async () => [...devices.values()], "listDevices"),
    capabilities: /* @__PURE__ */ __name(async () => ({ roomCalling: true, transferEnabled: true }), "capabilities"),
    verifyReadiness: /* @__PURE__ */ __name(async (data) => proof(data), "verifyReadiness"),
    rejectIncoming: /* @__PURE__ */ __name(async (data) => {
      effects.push({ kind: "reject", ...data });
    }, "rejectIncoming"),
    notify: /* @__PURE__ */ __name(async (data) => {
      effects.push({ kind: "notify", event: data.event });
    }, "notify"),
    phoneNumberId: "business-1",
    minimumNativeBuild: 10,
    now: /* @__PURE__ */ __name(() => time, "now"),
    ...options.runtime
  });
  controller.verifyReadiness = (data) => runtime.verifyTransferReadiness(data);
  const incoming3 = /* @__PURE__ */ __name(async (id = "call-in-1") => runtime.ingestVerifiedMetaEvent({
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
  const accept = /* @__PURE__ */ __name(async (id = "call-in-1", device = "a") => runtime.accept(device, id, { requestId: "accept-0001" }), "accept");
  const ready = /* @__PURE__ */ __name(async (accepted, device = "a") => runtime.ready(
    device,
    accepted.call.sessionId,
    { version: accepted.call.version, readinessNonce: accepted.readinessNonce, evidence: { unitTest: true } }
  ), "ready");
  const connected = /* @__PURE__ */ __name(async () => {
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
    now: /* @__PURE__ */ __name(() => time, "now"),
    advance: /* @__PURE__ */ __name((ms) => {
      time += ms;
    }, "advance")
  };
}
__name(fixture, "fixture");

// tests/operator-gateway.test.mjs
/*! SOURCE tests/operator-gateway.test.mjs | SHA-256 72c5f1204477cb7af0ae946019d2c01980ec3b8dd5af86b7bcacef0442a091ad */
import test6 from "node:test";
import assert7 from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createOperatorMediaGateway, nativeCallHistoryEvent, verifyMetaWebhook } from "../operator-media-gateway.js";
import { sessionKey } from "../call-runtime/call-runtime.mjs";
import { registerOperatorAdminRoutes } from "../operator-admin.js";
var secret = "test-only-meta-signing-secret-not-a-real-key";
var signed = /* @__PURE__ */ __name((bytes) => ({ rawBodyBuffer: bytes, headers: {
  "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(bytes).digest("hex")
} }), "signed");
test6("webhook authentication uses exact received bytes and rejects changed/missing/malformed signatures", () => {
  const req = signed(Buffer.from('{"name":"Customer ✓","calls":[]}'));
  assert7.equal(verifyMetaWebhook(req, secret), true);
  assert7.equal(verifyMetaWebhook({ ...req, rawBodyBuffer: Buffer.from('{"calls":[]}') }, secret), false);
  for (const header of ["", "sha256=ab", "sha1=" + "a".repeat(64), "sha256=" + "z".repeat(64)])
    assert7.equal(verifyMetaWebhook({ ...req, headers: { "x-hub-signature-256": header } }, secret), false);
  assert7.equal(verifyMetaWebhook(req, ""), false);
  assert7.equal(verifyMetaWebhook({ headers: req.headers }, secret), false);
});
test6("history distinguishes signaling, actual audio, and unconfirmed end intent", () => {
  const at = 17931888e5, session2 = { id: "call", providerCallId: "call", direction: "incoming", version: 3, phoneNumberId: "12345" };
  const view = { version: 3, phase: "connecting", ownerDeviceId: "phone-a", roomReady: false };
  assert7.equal(nativeCallHistoryEvent({ session: session2, view }, at).native_projection.connected, false);
  assert7.equal(nativeCallHistoryEvent({ session: session2, view }, at).status, "connecting");
  const joined = { ...session2, mediaReadyAt: at - 5e3 };
  assert7.equal(nativeCallHistoryEvent({ session: joined, view: { ...view, phase: "connected", roomReady: true } }, at).status, "connected");
  const ending = nativeCallHistoryEvent({ session: joined, view: { ...view, terminal: { reason: "OPERATOR_ENDED", endedAt: at }, endConfirmed: false } }, at);
  assert7.equal(ending.status, "ending");
  assert7.equal(ending.native_projection.active, false);
  assert7.equal(ending.native_projection.end_confirmed, false);
  assert7.equal(ending.native_projection.duration_seconds, 5);
  assert7.equal(nativeCallHistoryEvent({ session: { ...session2, routeChoice: "legacy" }, view }, at), null);
});
function gateway(options = {}) {
  const records = /* @__PURE__ */ new Map(), events = [];
  let factoryArgs;
  const store = { durable: true, get: /* @__PURE__ */ __name(async (key2) => records.get(key2), "get") };
  const runtime = {
    locate: /* @__PURE__ */ __name(async (id) => records.get(sessionKey(id)), "locate"),
    isMediaAnchored: /* @__PURE__ */ __name(async (id) => !!records.get(sessionKey(id)), "isMediaAnchored"),
    ingestVerifiedMetaEvent: /* @__PURE__ */ __name(async (event) => {
      events.push(event);
      return { handled: true };
    }, "ingestVerifiedMetaEvent"),
    dispatchIncomingAlert: /* @__PURE__ */ __name(async () => {
    }, "dispatchIncomingAlert"),
    recoverSession: /* @__PURE__ */ __name(async () => {
    }, "recoverSession"),
    claimLegacyIncoming: /* @__PURE__ */ __name(async () => ({ allowed: true }), "claimLegacyIncoming")
  };
  const instance = createOperatorMediaGateway({
    env: {
      SH_ANDROID_REGISTRY_BACKEND: "firestore",
      WHATSAPP_PHONE_NUMBER_ID: "12345",
      META_WHATSAPP_APP_SECRET: secret,
      SH_NATIVE_CALLS_ENABLED: "true"
    },
    firestoreRuntime: { configured: true, firestore: {}, collectionPrefix: "sh_operator", deviceRegistry: {} },
    storeFactory: /* @__PURE__ */ __name(() => store, "storeFactory"),
    runtimeFactory: /* @__PURE__ */ __name((args) => {
      factoryArgs = args;
      return {
        runtime,
        controller: {},
        verifyConfiguration: /* @__PURE__ */ __name(async () => ({ controlApiReachable: true }), "verifyConfiguration")
      };
    }, "runtimeFactory"),
    logger: { warn() {
    } },
    ...options
  });
  return { instance, records, events, store, args: /* @__PURE__ */ __name(() => factoryArgs, "args") };
}
__name(gateway, "gateway");
test6("incomplete provider configuration never exposes a persisted native call to legacy controls", async () => {
  const h = gateway({ runtimeFactory: /* @__PURE__ */ __name(() => {
    throw Error("bad provider config");
  }, "runtimeFactory") });
  h.records.set(sessionKey("native-call"), { id: "native-call", routeChoice: "native" });
  assert7.equal(await h.instance.hasNativeCall("native-call"), true);
  await assert7.rejects(() => h.instance.assertLegacyControl("native-call"), (error) => error.statusCode === 409);
  await assert7.rejects(() => h.instance.claimLegacyIncoming("native-call", "legacy_attempt"), (error) => error.statusCode === 503);
  assert7.equal((await h.instance.claimLegacyIncoming("untracked-call", "legacy_attempt")).allowed, true);
});
test6("unavailable persistent storage does not fall through to a local legacy answer", async () => {
  const h = gateway({ firestoreRuntime: { configured: false } });
  await assert7.rejects(() => h.instance.hasNativeCall("native-call"), (error) => error.statusCode === 503);
});
test6("verified event correlation has stable distinct fallbacks when normalized IDs are missing", async () => {
  const h = gateway();
  const row = {
    call_id: "provider-call",
    phone_number_id: "12345",
    direction: "incoming",
    event: "connect",
    timestamp: 123,
    session: { sdp_type: "offer", sdp: "v=0\r\nm=audio 9 RTP/SAVPF 111\r\n" }
  };
  await h.instance.ingestVerifiedEvents([row, row, { ...row, timestamp: 124 }, { ...row, phone_number_id: "different" }]);
  assert7.equal(h.events.length, 3);
  assert7.equal(h.events[0].eventId, h.events[1].eventId);
  assert7.notEqual(h.events[0].eventId, h.events[2].eventId);
  assert7.equal(h.events[0].offerSdp, row.session.sdp);
});
test6("a verified combined SDP and ACCEPTED webhook preserves both events with independent stable IDs", async () => {
  const h = gateway();
  const row = {
    id: "combined-provider-event",
    call_id: "outgoing-call",
    phone_number_id: "12345",
    direction: "outgoing",
    event: "connect",
    provider_status: "ACCEPTED",
    timestamp: 123,
    session: { sdp_type: "answer", sdp: "v=0\r\nm=audio 9 RTP/SAVPF 111\r\n" },
    raw: { call: { biz_opaque_callback_data: "out_durable_attempt" } }
  };
  const first = await h.instance.ingestVerifiedEvents([row]);
  assert7.equal(first.handled, 2);
  assert7.deepEqual(h.events.map((event) => event.type), ["connect", "accepted"]);
  assert7.notEqual(h.events[0].eventId, h.events[1].eventId);
  assert7.equal(h.events[0].answerSdp, row.session.sdp);
  assert7.equal(h.events[1].opaqueSessionId, "out_durable_attempt");
  await h.instance.ingestVerifiedEvents([row]);
  assert7.equal(h.events[0].eventId, h.events[2].eventId);
  assert7.equal(h.events[1].eventId, h.events[3].eventId);
  await h.instance.ingestVerifiedEvents([{ ...row, event: "terminate" }]);
  assert7.equal(h.events.length, 5);
  assert7.equal(h.events[4].type, "terminate");
  assert7.notEqual(h.events[4].eventId, h.events[1].eventId);
});
test6("a durable incoming alert is delivered before slow history projection can block recovery", async () => {
  const f = fixture({ runtime: { phoneNumberId: "12345" } });
  const historyEntered = deferred2(), historyReleased = deferred2(), recoveryDone = deferred2(), alerts = [];
  const recover = f.runtime.recoverSession.bind(f.runtime);
  f.runtime.recoverSession = async (...args) => {
    try {
      return await recover(...args);
    } finally {
      recoveryDone.resolve();
    }
  };
  const instance = createOperatorMediaGateway({
    env: { WHATSAPP_PHONE_NUMBER_ID: "12345", META_WHATSAPP_APP_SECRET: secret, SH_NATIVE_CALLS_ENABLED: "true" },
    firestoreRuntime: { configured: true, firestore: {}, collectionPrefix: "sh_operator", deviceRegistry: {} },
    storeFactory: /* @__PURE__ */ __name(() => f.store, "storeFactory"),
    runtimeFactory: /* @__PURE__ */ __name((args) => {
      f.runtime.notify = args.notify;
      return { runtime: f.runtime, controller: f.controller, verifyConfiguration: /* @__PURE__ */ __name(async () => ({ controlApiReachable: true }), "verifyConfiguration") };
    }, "runtimeFactory"),
    pushBridge: { publishRoomEvent: /* @__PURE__ */ __name(async (event) => {
      if (await event.stillCurrent()) alerts.push(event.event);
    }, "publishRoomEvent") },
    onCallState: /* @__PURE__ */ __name(async () => {
      historyEntered.resolve();
      await historyReleased.promise;
    }, "onCallState"),
    logger: { warn() {
    } },
    now: f.now
  });
  await instance.ingestVerifiedEvents([{
    id: "slow-history-offer",
    call_id: "slow-history-call",
    phone_number_id: "12345",
    direction: "incoming",
    event: "connect",
    timestamp: f.now() / 1e3,
    session: { sdp_type: "offer", sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" }
  }]);
  await historyEntered.promise;
  try {
    assert7.deepEqual(alerts, ["incoming"]);
    const session2 = await f.runtime.locate("slow-history-call");
    assert7.equal(session2.outbox.find((item) => item.event === "incoming").status, "done");
  } finally {
    historyReleased.resolve();
  }
  await recoveryDone.promise;
  assert7.deepEqual(alerts, ["incoming"]);
});
test6("automatic pilot membership requires explicit server policy and fresh supported enrolled devices", async () => {
  const at = 18e11;
  const valid = /* @__PURE__ */ __name((id) => ({ id, credentialGeneration: 1, tokenExpiresAt: at + 6e4, nativeBuild: 10, mediaProtocol: "sh-room-audio-v1", receiveCalls: true }), "valid");
  const rows2 = [
    valid("phone-a"),
    valid("phone-b"),
    { ...valid("old-build"), nativeBuild: 9 },
    { ...valid("expired"), tokenExpiresAt: at },
    { ...valid("revoked"), revokedAt: at - 1 },
    { ...valid("wrong-protocol"), mediaProtocol: "legacy" },
    { ...valid("notifications-disabled"), receiveCalls: false },
    valid("blocked")
  ];
  const registry = { listDevices: /* @__PURE__ */ __name(async () => rows2, "listDevices") };
  const env3 = {
    SH_ANDROID_REGISTRY_BACKEND: "firestore",
    WHATSAPP_PHONE_NUMBER_ID: "12345",
    META_WHATSAPP_APP_SECRET: secret,
    SH_NATIVE_CALLS_ENABLED: "true",
    SH_NATIVE_TRANSFER_PILOT_ENABLED: "true",
    SH_NATIVE_PILOT_USE_ENROLLED_DEVICES: "true",
    SH_ANDROID_REVOKED_DEVICE_IDS: "blocked"
  };
  const make = /* @__PURE__ */ __name((envValue) => gateway({
    env: envValue,
    now: /* @__PURE__ */ __name(() => at, "now"),
    firestoreRuntime: { configured: true, firestore: {}, collectionPrefix: "sh_operator", deviceRegistry: registry }
  }), "make");
  assert7.deepEqual((await make(env3).args().capabilities()).pilotDeviceIds, ["phone-a", "phone-b"]);
  assert7.deepEqual((await make({ ...env3, SH_NATIVE_PILOT_USE_ENROLLED_DEVICES: "false" }).args().capabilities()).pilotDeviceIds, []);
  assert7.deepEqual(
    (await make({ ...env3, SH_NATIVE_PILOT_DEVICE_IDS: "explicit-a, explicit-b" }).args().capabilities()).pilotDeviceIds,
    ["explicit-a", "explicit-b"]
  );
  assert7.equal((await make({ ...env3, SH_NATIVE_TRANSFER_PILOT_ENABLED: "false" }).args().capabilities()).pilotEnabled, false);
});
test6("native device identity is derived from the current registry and metadata is authenticated", async () => {
  let updated = 0;
  const row = { id: "android_test_1234567890", credentialGeneration: 2, tokenExpiresAt: Date.now() + 1e5, nativeBuild: 9 };
  const registry = { authenticate: /* @__PURE__ */ __name(async () => row, "authenticate"), updateNativeClient: /* @__PURE__ */ __name(async (_token, patch) => {
    updated++;
    return { ...row, ...patch };
  }, "updateNativeClient") };
  const h = gateway({ firestoreRuntime: { configured: true, firestore: {}, collectionPrefix: "sh_operator", deviceRegistry: registry } });
  const context = { headers: { authorization: "Bearer " + "a".repeat(60), "x-sh-native-build": "10", "x-sh-media-protocol": "sh-room-audio-v1" }, body: { userId: "SUDO" } };
  const actor = await h.args().authenticate(context);
  assert7.equal(actor.userId, "native:" + row.id);
  assert7.equal(actor.nativeBuild, 10);
  assert7.equal(updated, 1);
  await assert7.rejects(() => h.args().authenticate({ headers: { ...context.headers, authorization: "" } }), (e) => e.statusCode === 401);
  await assert7.rejects(() => h.args().authenticate({ headers: { ...context.headers, "x-sh-native-build": "-1" } }), (e) => e.statusCode === 400);
});
function adminHarness(envPatch = {}) {
  const routes = /* @__PURE__ */ new Map();
  let issued = 0;
  registerOperatorAdminRoutes(
    { get: /* @__PURE__ */ __name((path, fn) => routes.set("GET " + path, fn), "get"), post: /* @__PURE__ */ __name((path, fn) => routes.set("POST " + path, fn), "post") },
    {
      authorize: /* @__PURE__ */ __name((req) => req.admin === true, "authorize"),
      env: {
        APP_URL: "https://ai-agent-debate.onrender.com",
        PROFILE_SESSION_SECRET: "test-signing-secret-with-at-least-32-chars",
        PROFILE_PASS_SUDO: "test-only",
        ...envPatch
      },
      firestoreRuntime: { configured: true, deviceRegistry: { issueEnrollment: /* @__PURE__ */ __name(async () => {
        issued++;
        return { enrollmentCode: "test-code" };
      }, "issueEnrollment") } },
      mediaGateway: {}
    }
  );
  return { issued: /* @__PURE__ */ __name(() => issued, "issued"), async request({ admin = false, origin = "https://ai-agent-debate.onrender.com", header = "1", label = "Phone" } = {}) {
    const result = {};
    const res = { set() {
      return this;
    }, status(value) {
      result.status = value;
      return this;
    }, json(value) {
      result.body = value;
    } };
    await routes.get("POST /api/operator-android/admin/enrollment")({ admin, method: "POST", headers: { origin, "x-sh-admin-action": header }, body: { label } }, res);
    return result;
  } };
}
__name(adminHarness, "adminHarness");
test6("enrollment issuance needs existing SUDO authorization, exact origin and admin action header", async () => {
  const h = adminHarness();
  assert7.equal((await h.request()).status, 401);
  assert7.equal((await h.request({ admin: true, origin: "https://evil.example" })).status, 403);
  assert7.equal((await h.request({ admin: true, header: "" })).status, 403);
  assert7.equal((await h.request({ admin: true, label: "" })).status, 400);
  assert7.equal(h.issued(), 0);
  assert7.equal((await h.request({ admin: true })).body.ok, true);
  assert7.equal(h.issued(), 1);
});
test6("predictable fallback sessions cannot administer enrollment with blank profile configuration", async () => {
  const h = adminHarness({ PROFILE_SESSION_SECRET: "", PROFILE_PASS_SUDO: "" });
  assert7.equal((await h.request({ admin: true })).status, 503);
  assert7.equal(h.issued(), 0);
});

// media/test/provider.test.mjs
/*! SOURCE media/test/provider.test.mjs | SHA-256 99e5a76057b9dc2aef4096fca3839fa7b419d5c70f03f294e57bc30d156b2b69 */
import test7 from "node:test";
import assert8 from "node:assert/strict";
import {
  LiveKitWhatsAppProvider,
  readLiveKitConfig,
  operatorIdentity as operatorIdentity2,
  customerIdentity as customerIdentity2,
  mediaReleaseCapabilities
} from "../media/livekit-provider.mjs";
var fakeEnv = Object.freeze({
  LIVEKIT_URL: "wss://sh-unit-test.livekit.cloud",
  LIVEKIT_API_KEY: "unit-test-key",
  LIVEKIT_API_SECRET: "unit-test-only-secret-never-a-real-provider-credential",
  WHATSAPP_CALL_ACCESS_TOKEN: "unit-test-meta-token",
  WHATSAPP_GRAPH_API_VERSION: "v23.0"
});
var sdp = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=unit-test\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
var claims = /* @__PURE__ */ __name((token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()), "claims");
async function withSdkTransport(operation, responder) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(options.body);
    const call = { path, body, options };
    calls.push(call);
    const result = responder ? await responder(call) : {};
    return result instanceof Response ? result : new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  try {
    await operation(new LiveKitWhatsAppProvider(readLiveKitConfig(fakeEnv)), calls);
  } finally {
    globalThis.fetch = previous;
  }
}
__name(withSdkTransport, "withSdkTransport");
test7("configuration fails closed; old transfer flags cannot enable media release", () => {
  assert8.throws(() => readLiveKitConfig({}), { code: "MEDIA_CONFIG_MISSING" });
  for (const origin of [
    "http://sh.livekit.cloud",
    "https://sh.livekit.cloud.evil.example",
    "https://localhost",
    "https://user:pass@sh.livekit.cloud",
    "https://sh.livekit.cloud/path"
  ]) {
    assert8.throws(() => readLiveKitConfig({ ...fakeEnv, LIVEKIT_URL: origin }), { code: "MEDIA_CONFIG_INVALID" });
  }
  assert8.equal(mediaReleaseCapabilities({ WHATSAPP_CALL_TRANSFER_ENABLED: "true" }).enabled, false);
});
test7("official SDK serializes incoming real SDP offer and does not claim connected audio", async () => {
  await withSdkTransport(async (provider, calls) => {
    const result = await provider.acceptIncoming({ callId: "provider-call-1", phoneNumberId: "123456", offerSdp: sdp });
    assert8.equal(calls.length, 1);
    assert8.equal(calls[0].path, "/twirp/livekit.Connector/AcceptWhatsAppCall");
    assert8.equal(calls[0].body.sdp.type, "offer");
    assert8.equal(calls[0].body.sdp.sdp, sdp);
    assert8.equal(calls[0].body.whatsappCallId, "provider-call-1");
    assert8.equal(result.audioConnected, false);
    assert8.equal(result.signalingAccepted, true);
    assert8.equal(result.customerIdentity, customerIdentity2("provider-call-1"));
  }, () => ({ roomName: "returned-room" }));
});
test7("official SDK outgoing dial and answer use separate operations and stable request correlation", async () => {
  await withSdkTransport(async (provider, calls) => {
    const result = await provider.dialOutgoing({ phoneNumberId: "123456", to: "919000000000", requestId: "outgoing-unit-1" });
    await provider.connectOutgoing({ callId: result.callId, answerSdp: sdp });
    assert8.deepEqual(calls.map((x) => x.path.split("/").at(-1)), ["DialWhatsAppCall", "ConnectWhatsAppCall"]);
    assert8.equal(calls[0].body.whatsappBizOpaqueCallbackData, "outgoing-unit-1");
    assert8.equal(calls[0].body.ringingTimeout, "45s");
    assert8.equal(calls[1].body.sdp.type, "answer");
    assert8.equal(result.audioConnected, false);
  }, (call) => call.path.endsWith("DialWhatsAppCall") ? { whatsappCallId: "meta-outgoing-1", roomName: "outgoing-room" } : {});
});
test7("invalid/absent audio offer cannot signal a provider call", async () => {
  await withSdkTransport(async (provider, calls) => {
    await assert8.rejects(provider.acceptIncoming({ callId: "c", phoneNumberId: "p", offerSdp: "" }), { code: "INVALID_SDP" });
    assert8.equal(calls.length, 0);
  });
});
test7("ambiguous outgoing failure is not retried by SDK failover and error does not expose secrets", async () => {
  await withSdkTransport(async (provider, calls) => {
    await assert8.rejects(provider.dialOutgoing({ phoneNumberId: "123456", to: "919000000000", requestId: "outgoing-unit-1" }), (error) => {
      assert8.equal(error.outcomeUnknown, true);
      assert8.equal(error.code, "MEDIA_REQUEST_UNCERTAIN");
      assert8.equal(String(error).includes(fakeEnv.WHATSAPP_CALL_ACCESS_TOKEN), false);
      return true;
    });
    assert8.equal(calls.length, 1);
  }, () => new Response(
    JSON.stringify({ code: "internal", msg: fakeEnv.WHATSAPP_CALL_ACCESS_TOKEN }),
    { status: 500, headers: { "Content-Type": "application/json" } }
  ));
});
test7("customer-end cleanup uses USER_INITIATED and omits unnecessary Meta token", async () => {
  await withSdkTransport(async (provider, calls) => {
    await provider.terminateCustomer({ callId: "meta-call", reason: "USER_INITIATED" });
    assert8.equal(calls[0].body.disconnectReason, "USER_INITIATED");
    assert8.ok(!calls[0].body.whatsappApiKey);
    await provider.terminateCustomer({ callId: "meta-call", reason: "BUSINESS_INITIATED" });
    assert8.equal(calls[1].body.whatsappApiKey, fakeEnv.WHATSAPP_CALL_ACCESS_TOKEN);
  });
});
test7("join tokens use official SDK, exact room, microphone-only publishing and unique device legs", async () => {
  const provider = new LiveKitWhatsAppProvider(readLiveKitConfig(fakeEnv));
  const a = await provider.issueOperatorJoin({ roomName: "room-1", deviceId: "device-a", legId: "leg-1" });
  const b = await provider.issueOperatorJoin({ roomName: "room-1", deviceId: "device-b", legId: "leg-1" });
  const c = await provider.issueOperatorJoin({ roomName: "room-1", deviceId: "device-a", legId: "leg-2" });
  assert8.notEqual(a.identity, b.identity);
  assert8.notEqual(a.identity, c.identity);
  const token = claims(a.token);
  assert8.equal(token.sub, a.identity);
  assert8.equal(token.video.room, "room-1");
  assert8.equal(token.video.roomJoin, true);
  assert8.equal(token.video.canPublishData, false);
  assert8.deepEqual(token.video.canPublishSources, ["microphone"]);
  assert8.ok(!token.video.roomAdmin && !token.video.roomCreate && !token.video.roomList && !token.sip);
  assert8.ok(token.exp - token.nbf <= 120);
});
test7("source detach revokes only that operator and never invokes customer disconnect", async () => {
  await withSdkTransport(async (provider, calls) => {
    const identity = operatorIdentity2("device-a", "leg-a");
    await provider.detachOperator({ roomName: "room-1", identity, revokeBeforeMs: 18e11 });
    assert8.equal(calls.length, 1);
    assert8.equal(calls[0].path, "/twirp/livekit.RoomService/RemoveParticipant");
    assert8.equal(calls[0].body.identity, identity);
    assert8.equal(calls[0].body.revokeTokenTs, "1800000060");
    await assert8.rejects(provider.detachOperator({ roomName: "room-1", identity: customerIdentity2("call-1") }), { code: "INVALID_OPERATOR_LEG" });
    assert8.equal(calls.length, 1);
  });
});
test7("control API success and participant tracks explicitly do not establish live audio", async () => {
  await withSdkTransport(async (provider) => {
    const result = await provider.probeControlApi();
    assert8.equal(result.controlApiReachable, true);
    assert8.equal(result.audioVerified, false);
    assert8.equal(result.transferEnabled, false);
    const observed = await provider.inspectParticipants({ roomName: "r", customerIdentity: "customer", operatorIdentity: "target", sourceIdentity: "source" });
    assert8.equal(observed.operatorAudioPublished, true);
    assert8.equal(observed.customerAudioPublished, true);
    assert8.equal(observed.bidirectionalAudioVerified, false);
  }, (call) => call.path.endsWith("ListParticipants") ? {
    participants: ["customer", "target", "source"].map((identity) => ({ identity, state: "ACTIVE", tracks: [{ sid: identity, type: "AUDIO" }] }))
  } : { rooms: [] });
});

// media/test/helpers.mjs
/*! SOURCE media/test/helpers.mjs | SHA-256 4ae7d800a1303020e0a01a8d4ff42a6f0a247edd05a2445701d4de8e9a7c7a24 */
import { newBridgedCall, TransferController as TransferController2, callStoreKey, deviceReservationKey } from "../media/transfer-controller.mjs";
import { operatorIdentity as operatorIdentity3 } from "../media/livekit-provider.mjs";
var TestStore = class {
  static {
    __name(this, "TestStore");
  }
  constructor({ replayTransaction = false } = {}) {
    this.durable = true;
    this.rows = /* @__PURE__ */ new Map();
    this.tail = Promise.resolve();
    this.replayTransaction = replayTransaction;
  }
  async get(key2) {
    return structuredClone(this.rows.get(key2));
  }
  async transaction(operation) {
    const run = this.tail.catch(() => {
    }).then(async () => {
      for (let attempt = 0; attempt < (this.replayTransaction ? 2 : 1); attempt++) {
        const staged = structuredClone(this.rows);
        let wrote = false;
        const value = await operation({
          get: /* @__PURE__ */ __name(async (key2) => {
            if (wrote) throw new Error("Firestore transactions require all reads before writes");
            return structuredClone(staged.get(key2));
          }, "get"),
          set: /* @__PURE__ */ __name((key2, row) => {
            wrote = true;
            staged.set(key2, structuredClone(row));
          }, "set"),
          delete: /* @__PURE__ */ __name((key2) => {
            wrote = true;
            staged.delete(key2);
          }, "delete")
        });
        if (!this.replayTransaction || attempt === 1) {
          this.rows = staged;
          return value;
        }
      }
    });
    this.tail = run;
    return run;
  }
};
function deferred3() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
__name(deferred3, "deferred");
function fixture2(options = {}) {
  const store = options.store || new TestStore();
  let now = 18e11;
  const effects = [];
  const devices = new Map(["a", "b", "c", "d"].map((deviceId) => [deviceId, {
    deviceId,
    userId: deviceId === "b" ? "user-a" : `user-${deviceId}`,
    tenantId: "smart",
    mediaProtocol: "sh-room-audio-v1",
    revoked: false,
    receiveCalls: true
  }]));
  const provider = {
    kind: "livekit-whatsapp",
    issueOperatorJoin: /* @__PURE__ */ __name(async ({ roomName, deviceId, legId }) => ({ roomName, identity: operatorIdentity3(deviceId, legId), token: "unit-test-only" }), "issueOperatorJoin"),
    inspectParticipants: /* @__PURE__ */ __name(async () => ({
      observedAt: now,
      customerActive: true,
      customerAudioPublished: true,
      operatorActive: true,
      operatorAudioPublished: true,
      sourceActive: true,
      bidirectionalAudioVerified: false
    }), "inspectParticipants"),
    detachOperator: /* @__PURE__ */ __name(async (data) => {
      effects.push({ kind: "detach", ...data });
    }, "detachOperator"),
    terminateCustomer: /* @__PURE__ */ __name(async (data) => {
      effects.push({ kind: "terminate", ...data });
    }, "terminateCustomer"),
    ...options.provider
  };
  const validProof = /* @__PURE__ */ __name(({ actor, call, transfer }) => ({
    verified: true,
    bidirectionalAudio: true,
    callId: call.id,
    transferId: transfer.id,
    attemptId: transfer.attemptId,
    deviceId: actor.deviceId,
    identity: transfer.targetIdentity,
    readinessNonce: transfer.readinessNonce,
    observedAt: now
  }), "validProof");
  const authenticate = /* @__PURE__ */ __name(async (context) => {
    const row = devices.get(context);
    return row ? { ...row, authenticated: true, canCall: true } : null;
  }, "authenticate");
  const controller = new TransferController2({
    store,
    provider,
    authenticate,
    resolveDevice: /* @__PURE__ */ __name(async (device) => devices.get(device), "resolveDevice"),
    now: /* @__PURE__ */ __name(() => now, "now"),
    rolloutGuard: /* @__PURE__ */ __name(async () => ({ enabled: true, provider: provider.kind, clientProtocol: "sh-room-audio-v1", liveTwoDeviceEvidenceId: "UNIT-TEST-ONLY-NOT-LIVE" }), "rolloutGuard"),
    verifyReadiness: /* @__PURE__ */ __name(async (data) => validProof(data), "verifyReadiness"),
    verifyProviderEvent: /* @__PURE__ */ __name(async (event) => event === "verified-terminate" ? { verified: true, type: "terminated", callId: "call-1" } : null, "verifyProviderEvent"),
    ...options.controller
  });
  const seed = /* @__PURE__ */ __name(async (callId = "call-1", ownerDevice = "a") => {
    const owner = devices.get(ownerDevice);
    const call = newBridgedCall({
      callId,
      roomName: `room-${callId}`,
      customerIdentity: `customer-${callId}`,
      tenantId: "smart",
      owner: { deviceId: ownerDevice, userId: owner.userId, legId: `initial-${callId}` },
      now
    });
    await store.transaction(async (tx) => {
      if (await tx.get(callStoreKey(callId))) throw new Error("Refuse to overwrite an existing call");
      tx.set(callStoreKey(callId), call);
      tx.set(deviceReservationKey(ownerDevice), { callId, kind: "owner" });
    });
    return call;
  }, "seed");
  const invite = /* @__PURE__ */ __name(async (owner = "a", toDeviceId = "b", callId = "call-1", requestId = "request-0001") => {
    const current = await store.get(callStoreKey(callId));
    return controller.invite(owner, { callId, toDeviceId, expectedVersion: current.version, requestId });
  }, "invite");
  const accept = /* @__PURE__ */ __name(async (invitation) => controller.accept(invitation.transfer.toDeviceId, {
    callId: invitation.callId,
    transferId: invitation.transfer.id,
    expectedVersion: invitation.version
  }), "accept");
  const ready = /* @__PURE__ */ __name(async (accepted) => controller.confirmReady(accepted.transfer.toDeviceId, {
    callId: accepted.callId,
    transferId: accepted.transfer.id,
    expectedVersion: accepted.version,
    readinessNonce: accepted.readinessNonce,
    evidence: { unitTest: true }
  }), "ready");
  return {
    store,
    controller,
    provider,
    effects,
    devices,
    seed,
    invite,
    accept,
    ready,
    validProof,
    now: /* @__PURE__ */ __name(() => now, "now"),
    advance: /* @__PURE__ */ __name((ms) => {
      now += ms;
    }, "advance")
  };
}
__name(fixture2, "fixture");

// media/test/transfer.test.mjs
/*! SOURCE media/test/transfer.test.mjs | SHA-256 2adb5f6a4961a3a395d4d8a941cb4cddda2cba0743c011b6789364545c98f2d1 */
import test8 from "node:test";
import assert9 from "node:assert/strict";
import { TransferController as TransferController3, callStoreKey as callStoreKey2, deviceReservationKey as deviceReservationKey2, MAX_TRANSFERS_PER_CALL } from "../media/transfer-controller.mjs";
test8("rollout fails closed even when someone sets an enabled boolean", async () => {
  const f = fixture2({ controller: { rolloutGuard: /* @__PURE__ */ __name(async () => true, "rolloutGuard") } });
  await f.seed();
  await assert9.rejects(f.invite(), { code: "TRANSFER_MEDIA_NOT_VALIDATED" });
  assert9.equal((await f.store.get(callStoreKey2("call-1"))).owner.deviceId, "a");
});
test8("missing durable transaction store is rejected", () => {
  assert9.throws(() => new TransferController3({ store: { durable: false } }), { code: "DURABLE_STORE_REQUIRED" });
});
test8("request body identity does not authenticate a device", async () => {
  const f = fixture2();
  await f.seed();
  await assert9.rejects(f.controller.invite({ operator_device_id: "a" }, {
    callId: "call-1",
    toDeviceId: "b",
    requestId: "forged-0001",
    expectedVersion: 1
  }), { code: "UNAUTHENTICATED_DEVICE" });
  const invitation = await f.invite();
  await assert9.rejects(f.controller.accept("c", {
    callId: "call-1",
    transferId: invitation.transfer.id,
    expectedVersion: invitation.version
  }), { code: "TRANSFER_FORBIDDEN" });
});
test8("revoked devices and legacy clients cannot receive transfers", async () => {
  const f = fixture2();
  await f.seed();
  f.devices.get("b").revoked = true;
  await assert9.rejects(f.invite(), { code: "TARGET_UNAVAILABLE" });
  f.devices.get("b").revoked = false;
  f.devices.get("b").mediaProtocol = "legacy-browser";
  await assert9.rejects(f.invite(), { code: "TARGET_UNAVAILABLE" });
});
test8("same user on two devices has different legs; source kept until ready", async () => {
  const f = fixture2();
  const original = await f.seed();
  const accepted = await f.accept(await f.invite());
  assert9.notEqual(accepted.join.identity, original.owner.identity);
  assert9.equal(accepted.ownerDeviceId, "a");
  assert9.equal(accepted.transfer.status, "connecting");
  assert9.deepEqual(f.effects, []);
  const committed = await f.ready(accepted);
  assert9.equal(committed.ownerDeviceId, "b");
  assert9.equal(committed.transfer.status, "completing");
  assert9.deepEqual(f.effects, []);
  await f.controller.drainOutbox("call-1");
  assert9.equal(f.effects.length, 1);
  assert9.equal(f.effects[0].kind, "detach");
  assert9.equal(f.effects[0].identity, original.owner.identity);
  assert9.equal((await f.store.get(callStoreKey2("call-1"))).transfer.status, "completed");
});
test8("idempotent invitation and accept do not create new transfer or customer calls", async () => {
  const f = fixture2();
  await f.seed();
  const [first, second] = await Promise.all([f.invite(), f.invite()]);
  assert9.equal(first.transfer.id, second.transfer.id);
  const [a, b] = await Promise.all([f.accept(first), f.accept(first)]);
  assert9.equal(a.join.identity, b.join.identity);
  assert9.equal(a.readinessNonce, b.readinessNonce);
  assert9.deepEqual(f.effects, []);
  await assert9.rejects(f.invite("a", "c", "call-1", "request-0001"), { code: "REQUEST_ID_CONFLICT" });
});
test8("atomic reservation prevents two different calls from inviting the same target", async () => {
  const f = fixture2();
  await f.seed();
  await f.seed("call-2", "c");
  const results = await Promise.allSettled([f.invite("a", "b"), f.invite("c", "b", "call-2")]);
  assert9.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert9.equal(results.find((r) => r.status === "rejected").reason.code, "TARGET_BUSY");
});
test8("unverified client readiness leaves source owner and microphone untouched", async () => {
  const f = fixture2({ controller: { verifyReadiness: void 0 } });
  await f.seed();
  const accepted = await f.accept(await f.invite());
  await assert9.rejects(f.ready(accepted), { code: "CLIENT_MEDIA_NOT_INTEGRATED" });
  assert9.equal((await f.store.get(callStoreKey2("call-1"))).owner.deviceId, "a");
  assert9.deepEqual(f.effects, []);
});
test8("published track without received/sent audio evidence cannot commit", async () => {
  const f = fixture2({ controller: { verifyReadiness: /* @__PURE__ */ __name(async () => ({ verified: true }), "verifyReadiness") } });
  await f.seed();
  const accepted = await f.accept(await f.invite());
  await assert9.rejects(f.ready(accepted), { code: "MEDIA_NOT_VERIFIED" });
  assert9.equal((await f.store.get(callStoreKey2("call-1"))).owner.deviceId, "a");
});
test8("missing customer or target media never releases source", async () => {
  const f = fixture2({ provider: { inspectParticipants: /* @__PURE__ */ __name(async () => ({ customerActive: false }), "inspectParticipants") } });
  await f.seed();
  const accepted = await f.accept(await f.invite());
  await assert9.rejects(f.ready(accepted), { code: "MEDIA_NOT_READY" });
  assert9.deepEqual(f.effects, []);
});
test8("stale readiness nonce, version and old telemetry are rejected", async () => {
  const f = fixture2();
  await f.seed();
  const accepted = await f.accept(await f.invite());
  await assert9.rejects(f.ready({ ...accepted, readinessNonce: "old-attempt" }), { code: "READINESS_STALE" });
  await assert9.rejects(f.ready({ ...accepted, version: accepted.version - 1 }), { code: "STALE_CALL_VERSION" });
  f.controller.verifyReadiness = async (data) => ({ ...f.validProof(data), observedAt: f.now() - 6e3 });
  await assert9.rejects(f.ready(accepted), { code: "MEDIA_NOT_VERIFIED" });
});
test8("target decline keeps source, detaches only target and frees reservation", async () => {
  const f = fixture2();
  const original = await f.seed();
  const accepted = await f.accept(await f.invite());
  const stopped = await f.controller.stopTransfer("b", {
    callId: "call-1",
    transferId: accepted.transfer.id,
    expectedVersion: accepted.version,
    action: "decline"
  });
  assert9.equal(stopped.ownerDeviceId, "a");
  assert9.equal((await f.store.get(deviceReservationKey2("b"))).kind, "cleanup");
  await f.controller.drainOutbox("call-1");
  assert9.equal(await f.store.get(deviceReservationKey2("b")), void 0);
  assert9.equal(f.effects.length, 1);
  assert9.equal(f.effects[0].identity, accepted.join.identity);
  assert9.notEqual(f.effects[0].identity, original.owner.identity);
});
test8("invitation expires during readiness I/O; late proof cannot take ownership", async () => {
  const wait = deferred3();
  const entered = deferred3();
  const f = fixture2({ controller: { verifyReadiness: /* @__PURE__ */ __name(async (data) => {
    entered.resolve();
    await wait.promise;
    return f.validProof(data);
  }, "verifyReadiness") } });
  await f.seed();
  const accepted = await f.accept(await f.invite());
  const confirmation = f.ready(accepted);
  await entered.promise;
  f.advance(61e3);
  wait.resolve();
  await assert9.rejects(confirmation);
  await f.controller.expire("call-1");
  const call = await f.store.get(callStoreKey2("call-1"));
  assert9.equal(call.owner.deviceId, "a");
  assert9.equal(call.transfer.status, "expired");
});
test8("source cancellation wins against delayed readiness verification", async () => {
  const wait = deferred3();
  const entered = deferred3();
  const f = fixture2({ controller: { verifyReadiness: /* @__PURE__ */ __name(async (data) => {
    entered.resolve();
    await wait.promise;
    return f.validProof(data);
  }, "verifyReadiness") } });
  await f.seed();
  const accepted = await f.accept(await f.invite());
  const confirmation = f.ready(accepted);
  await entered.promise;
  await f.controller.stopTransfer("a", { callId: "call-1", transferId: accepted.transfer.id, expectedVersion: accepted.version, action: "cancel" });
  wait.resolve();
  await assert9.rejects(confirmation, { code: "STALE_CALL_VERSION" });
  assert9.equal((await f.store.get(callStoreKey2("call-1"))).owner.deviceId, "a");
});
test8("customer termination wins while readiness is in flight", async () => {
  const wait = deferred3();
  const entered = deferred3();
  const f = fixture2({ controller: { verifyReadiness: /* @__PURE__ */ __name(async (data) => {
    entered.resolve();
    await wait.promise;
    return f.validProof(data);
  }, "verifyReadiness") } });
  await f.seed();
  const accepted = await f.accept(await f.invite());
  const confirmation = f.ready(accepted);
  await entered.promise;
  const ended = await f.controller.providerEnded("verified-terminate");
  assert9.equal(ended.active, false);
  wait.resolve();
  await assert9.rejects(confirmation, { code: "CALL_ENDED" });
  await f.controller.drainOutbox("call-1");
  const terminal = await f.store.get(callStoreKey2("call-1"));
  assert9.equal(terminal.active, false);
  assert9.equal(terminal.transfer.status, "cancelled");
  assert9.equal(f.effects.filter((e) => e.kind === "terminate").length, 1);
  assert9.equal(f.effects.find((e) => e.kind === "terminate").reason, "USER_INITIATED");
});
test8("termination during token issuance prevents returning a join token", async () => {
  const wait = deferred3();
  const entered = deferred3();
  const f = fixture2();
  await f.seed();
  const invitation = await f.invite();
  const original = f.provider.issueOperatorJoin;
  f.provider.issueOperatorJoin = async (data) => {
    entered.resolve();
    await wait.promise;
    return original(data);
  };
  const acceptance = f.accept(invitation);
  await entered.promise;
  await f.controller.providerEnded("verified-terminate");
  wait.resolve();
  await assert9.rejects(acceptance, { code: "CALL_ENDED" });
});
test8("unsigned provider payload cannot terminate a call", async () => {
  const f = fixture2();
  await f.seed();
  await assert9.rejects(f.controller.providerEnded({ callId: "call-1", verified: true }), { code: "UNVERIFIED_WEBHOOK" });
  assert9.equal((await f.store.get(callStoreKey2("call-1"))).active, true);
});
test8("failed source cleanup is persisted; a restarted worker retries detach without ending customer", async () => {
  const f = fixture2();
  const original = await f.seed();
  const accepted = await f.accept(await f.invite());
  await f.ready(accepted);
  f.provider.detachOperator = async () => {
    throw new Error("transient transport failure");
  };
  await f.controller.drainOutbox("call-1");
  let call = await f.store.get(callStoreKey2("call-1"));
  assert9.equal(call.owner.deviceId, "b");
  assert9.equal(call.transfer.status, "completing");
  assert9.equal(call.outbox[0].status, "pending");
  assert9.equal((await f.store.get(deviceReservationKey2("a"))).kind, "cleanup");
  f.advance(3e3);
  f.provider.detachOperator = async (data) => f.effects.push({ kind: "detach", ...data });
  const restarted = new TransferController3({ ...f.controller, store: f.store, provider: f.provider });
  await restarted.drainOutbox("call-1");
  call = await f.store.get(callStoreKey2("call-1"));
  assert9.equal(call.transfer.status, "completed");
  assert9.equal(await f.store.get(deviceReservationKey2("a")), void 0);
  assert9.equal(f.effects.length, 1);
  assert9.equal(f.effects[0].identity, original.owner.identity);
});
test8("source cannot end customer after handoff commits; terminal retries are idempotent", async () => {
  const f = fixture2();
  await f.seed();
  const accepted = await f.accept(await f.invite());
  const committed = await f.ready(accepted);
  await assert9.rejects(f.controller.endByOperator("a", { callId: "call-1", expectedVersion: committed.version }), { code: "NOT_CALL_OWNER" });
  const ended = await f.controller.endByOperator("b", { callId: "call-1", expectedVersion: committed.version });
  assert9.equal(ended.active, false);
  await f.controller.providerEnded("verified-terminate");
  await f.controller.drainOutbox("call-1");
  await f.controller.drainOutbox("call-1");
  assert9.equal(f.effects.filter((e) => e.kind === "terminate").length, 1);
  assert9.equal((await f.store.get(callStoreKey2("call-1"))).transfer.status, "cancelled");
});
test8("terminal call never becomes transferable on old idempotent invitation replay", async () => {
  const f = fixture2();
  await f.seed();
  const invitation = await f.invite();
  await f.controller.providerEnded("verified-terminate");
  const replay = await f.invite();
  assert9.equal(replay.active, false);
  assert9.equal(replay.transfer.id, invitation.transfer.id);
  await assert9.rejects(f.accept(invitation), { code: "CALL_ENDED" });
  await assert9.rejects(f.invite("a", "b", "call-1", "new-request-0002"), { code: "CALL_ENDED" });
});
test8("device revocation while readiness is in flight prevents ownership commit", async () => {
  const wait = deferred3();
  const entered = deferred3();
  const f = fixture2({ controller: { verifyReadiness: /* @__PURE__ */ __name(async (data) => {
    entered.resolve();
    await wait.promise;
    return f.validProof(data);
  }, "verifyReadiness") } });
  await f.seed();
  const accepted = await f.accept(await f.invite());
  const confirmation = f.ready(accepted);
  await entered.promise;
  f.devices.get("b").revoked = true;
  wait.resolve();
  await assert9.rejects(confirmation, { code: "DEVICE_BINDING_INVALID" });
  assert9.equal((await f.store.get(callStoreKey2("call-1"))).owner.deviceId, "a");
});
test8("re-enrollment to another operator cannot inherit an already accepted target leg", async () => {
  const f = fixture2();
  await f.seed();
  const accepted = await f.accept(await f.invite());
  f.devices.get("b").userId = "replacement-operator";
  await assert9.rejects(f.ready(accepted), { code: "DEVICE_BINDING_CHANGED" });
  assert9.equal((await f.store.get(callStoreKey2("call-1"))).owner.deviceId, "a");
  assert9.deepEqual(f.effects, []);
});
test8("cleanup reservations cannot be mistaken for a live invite or source ownership", async () => {
  const f = fixture2();
  await f.seed();
  const invitation = await f.invite();
  const original = await f.store.get(deviceReservationKey2("b"));
  await f.store.transaction(async (tx) => {
    tx.set(deviceReservationKey2("b"), { ...original, kind: "cleanup", identity: "stale-target-leg" });
  });
  await assert9.rejects(f.accept(invitation), { code: "TRANSFER_CHANGED" });
  await f.store.transaction(async (tx) => tx.set(deviceReservationKey2("b"), original));
  const accepted = await f.accept(invitation);
  await f.store.transaction(async (tx) => {
    tx.set(deviceReservationKey2("a"), { callId: "call-1", kind: "cleanup", identity: "stale-source-leg" });
  });
  await assert9.rejects(f.ready(accepted), { code: "TRANSFER_CHANGED" });
  assert9.equal((await f.store.get(callStoreKey2("call-1"))).owner.deviceId, "a");
  assert9.deepEqual(f.effects, []);
});
test8("an operator end is immediate local intent, not a false provider-end confirmation", async () => {
  const f = fixture2();
  await f.seed();
  const ending = await f.controller.endByOperator("a", { callId: "call-1", expectedVersion: 1 });
  assert9.equal(ending.active, false);
  assert9.equal(ending.status, "ending");
  assert9.equal(ending.endConfirmed, false);
  f.provider.terminateCustomer = async () => {
    throw new Error("offline");
  };
  await f.controller.drainOutbox("call-1");
  assert9.equal((await f.store.get(callStoreKey2("call-1"))).status, "ending");
  const ended = await f.controller.providerEnded("verified-terminate");
  assert9.equal(ended.status, "ended");
  assert9.equal(ended.endConfirmed, true);
});
test8("another workspace cannot read or act on a call using a valid enrolled device", async () => {
  const f = fixture2();
  await f.seed();
  f.devices.get("c").tenantId = "another-workspace";
  await assert9.rejects(f.controller.endByOperator("c", { callId: "call-1", expectedVersion: 1 }), { code: "CALL_FORBIDDEN" });
});
test8("revocation during token issuance cannot return a usable new join token", async () => {
  const wait = deferred3();
  const entered = deferred3();
  const f = fixture2();
  await f.seed();
  const invitation = await f.invite();
  const issue = f.provider.issueOperatorJoin;
  f.provider.issueOperatorJoin = async (data) => {
    entered.resolve();
    await wait.promise;
    return issue(data);
  };
  const acceptance = f.accept(invitation);
  await entered.promise;
  f.devices.get("b").revoked = true;
  wait.resolve();
  await assert9.rejects(acceptance, { code: "DEVICE_BINDING_INVALID" });
  assert9.equal((await f.store.get(callStoreKey2("call-1"))).owner.deviceId, "a");
});
test8("Firestore callback retries do not duplicate tokens, ownership changes or provider cleanup", async () => {
  const f = fixture2({ store: new TestStore({ replayTransaction: true }) });
  await f.seed();
  let tokens = 0;
  const issue = f.provider.issueOperatorJoin;
  f.provider.issueOperatorJoin = async (data) => {
    tokens++;
    return issue(data);
  };
  const accepted = await f.accept(await f.invite());
  await f.ready(accepted);
  await f.controller.drainOutbox("call-1");
  const call = await f.store.get(callStoreKey2("call-1"));
  assert9.equal(tokens, 1);
  assert9.equal(f.effects.length, 1);
  assert9.equal(call.owner.deviceId, "b");
  assert9.equal(call.transfer.status, "completed");
  assert9.equal(call.outbox[0].attempts, 1);
});
test8("cleanup success followed by lost database acknowledgement recovers after its execution lease", async () => {
  const f = fixture2();
  await f.seed();
  const accepted = await f.accept(await f.invite());
  await f.ready(accepted);
  const transaction = f.store.transaction.bind(f.store);
  let failAcknowledgement = false;
  f.store.transaction = async (operation) => {
    if (failAcknowledgement) {
      failAcknowledgement = false;
      throw new Error("simulated lost acknowledgement");
    }
    return transaction(operation);
  };
  f.provider.detachOperator = async (data) => {
    f.effects.push({ kind: "detach", ...data });
    failAcknowledgement = true;
  };
  await assert9.rejects(f.controller.drainOutbox("call-1"), /simulated lost acknowledgement/);
  assert9.equal((await f.store.get(callStoreKey2("call-1"))).outbox[0].status, "running");
  assert9.equal((await f.store.get(deviceReservationKey2("a"))).kind, "cleanup");
  f.advance(46e3);
  f.provider.detachOperator = async (data) => {
    f.effects.push({ kind: "detach-already-absent", ...data });
  };
  await f.controller.drainOutbox("call-1");
  const call = await f.store.get(callStoreKey2("call-1"));
  assert9.equal(call.transfer.status, "completed");
  assert9.equal(call.outbox[0].attempts, 2);
  assert9.equal(await f.store.get(deviceReservationKey2("a")), void 0);
  assert9.ok(f.effects.every((effect) => effect.kind.startsWith("detach")));
});
test8("bounded transfer history preserves replay and end-call writes when the cap is reached", async () => {
  const f = fixture2();
  await f.seed();
  let first;
  for (let i = 0; i < MAX_TRANSFERS_PER_CALL; i++) {
    const invitation = await f.invite("a", "b", "call-1", `request-cap-${i}`);
    first ||= invitation;
    await f.controller.stopTransfer("a", {
      callId: "call-1",
      transferId: invitation.transfer.id,
      expectedVersion: invitation.version,
      action: "cancel"
    });
  }
  await assert9.rejects(f.invite("a", "b", "call-1", "request-beyond-cap"), { code: "TRANSFER_HISTORY_LIMIT" });
  const replay = await f.invite("a", "b", "call-1", "request-cap-0");
  assert9.equal(replay.transfer.id, first.transfer.id);
  assert9.equal(replay.replayed, true);
  const call = await f.store.get(callStoreKey2("call-1"));
  assert9.ok(Buffer.byteLength(JSON.stringify(call)) < 256 * 1024);
  const ended = await f.controller.endByOperator("a", { callId: "call-1", expectedVersion: call.version });
  assert9.equal(ended.active, false);
});
test8("concurrent cleanup workers honor execution leases and ignore an older late acknowledgement", async () => {
  const f = fixture2();
  await f.seed();
  const accepted = await f.accept(await f.invite());
  await f.ready(accepted);
  const entered = deferred3();
  const release = deferred3();
  let removals = 0;
  f.provider.detachOperator = async (data) => {
    removals++;
    if (removals === 1) {
      entered.resolve();
      await release.promise;
    }
    f.effects.push({ kind: "detach", ...data });
  };
  const originalWorker = f.controller.drainOutbox("call-1", { limit: 1 });
  await entered.promise;
  assert9.deepEqual(await f.controller.drainOutbox("call-1", { limit: 1 }), []);
  f.advance(46e3);
  await f.controller.drainOutbox("call-1", { limit: 1 });
  const recovered = await f.store.get(callStoreKey2("call-1"));
  assert9.equal(recovered.transfer.status, "completed");
  assert9.equal(recovered.outbox[0].attempts, 2);
  release.resolve();
  await originalWorker;
  const final = await f.store.get(callStoreKey2("call-1"));
  assert9.equal(final.version, recovered.version);
  assert9.equal(final.outbox[0].status, "done");
  assert9.equal(removals, 2);
  assert9.equal(new Set(f.effects.map((effect) => effect.identity)).size, 1);
});

// call-runtime/test/runtime.test.mjs
/*! SOURCE call-runtime/test/runtime.test.mjs | SHA-256 7c78db590b734b1fbdd070f40cc825cd5984df021692f6d2da80b72e2f7b860a */
import test9 from "node:test";
import assert10 from "node:assert/strict";
import { sessionKey as sessionKey2, eventKey } from "../call-runtime/call-runtime.mjs";
import { callStoreKey as callStoreKey3, deviceReservationKey as deviceReservationKey3 } from "../media/transfer-controller.mjs";
test9("unconfigured room calling and unverified business events fail closed", async () => {
  const f = fixture({ runtime: { capabilities: /* @__PURE__ */ __name(async () => ({ roomCalling: false }), "capabilities") } });
  await assert10.rejects(f.incoming(), { code: "ROOM_CALLING_NOT_ENABLED" });
  await assert10.rejects(f.runtime.ingestVerifiedMetaEvent({ verified: false }), { code: "UNVERIFIED_WEBHOOK" });
  await assert10.rejects(f.runtime.capabilities("unknown"), { code: "UNAUTHENTICATED_DEVICE" });
  assert10.deepEqual(f.effects, []);
});
test9("incoming route is durable and SDK accept is not Connected", async () => {
  const f = fixture();
  await f.incoming();
  assert10.equal(await f.runtime.isMediaAnchored("call-in-1"), true);
  const accepted = await f.accept();
  assert10.equal(accepted.call.phase, "joining");
  assert10.equal(accepted.call.roomReady, false);
  assert10.ok(accepted.join.legId);
  assert10.ok(accepted.join.customerIdentity);
  assert10.ok(accepted.readinessNonce);
  assert10.equal(await f.store.get(callStoreKey3("call-in-1")), void 0);
  const ready = await f.ready(accepted);
  assert10.equal(ready.call.phase, "connected");
  assert10.equal(ready.call.roomReady, true);
  assert10.ok(ready.call.version > accepted.call.version);
  assert10.equal((await f.store.get(deviceReservationKey3("a"))).kind, "owner");
  assert10.equal(f.effects.filter((row) => row.kind === "accept").length, 1);
});
test9("priority incoming alert uses the durable job without waiting for media or transfer housekeeping", async () => {
  const f = fixture();
  await f.incoming();
  const before = await f.runtime.locate("call-in-1");
  const unexpected = /* @__PURE__ */ __name(async () => {
    throw Error("Housekeeping must follow the incoming notification");
  }, "unexpected");
  f.runtime.reconcileEligibility = unexpected;
  f.runtime.syncTransferNotifications = unexpected;
  f.controller.expire = unexpected;
  const result = await f.runtime.dispatchIncomingAlert("call-in-1");
  assert10.equal(result.dispatched, true);
  assert10.deepEqual(f.effects, [{ kind: "notify", event: "incoming" }]);
  const after = await f.runtime.locate("call-in-1");
  assert10.equal(after.version, before.version);
  assert10.equal(after.phase, "ringing");
  const alert = after.outbox.find((item) => item.event === "incoming");
  assert10.equal(alert.status, "done");
  assert10.equal(alert.attempts, 1);
});
test9("priority incoming alerts skip expired, already answered and browser-claimed calls", async () => {
  for (const change of ["expired", "answered", "legacy"]) {
    const f = fixture();
    await f.incoming();
    if (change === "expired") f.advance(90001);
    if (change === "answered") await f.accept();
    if (change === "legacy") await f.runtime.claimLegacyIncoming("call-in-1", "legacy-alert-check");
    const result = await f.runtime.dispatchIncomingAlert("call-in-1");
    assert10.equal(result.dispatched, false, change);
    assert10.equal(f.effects.filter((item) => item.kind === "notify" && item.event === "incoming").length, 0, change);
  }
});
test9("customer end after an incoming alert lease is claimed prevents the stale send", async () => {
  const f = fixture();
  await f.incoming();
  const read = f.store.get.bind(f.store);
  let interrupt = true;
  f.runtime.store = { ...f.store, get: /* @__PURE__ */ __name(async (key2) => {
    if (interrupt && key2 === sessionKey2("call-in-1")) {
      interrupt = false;
      await f.runtime.ingestVerifiedMetaEvent({
        verified: true,
        eventId: "end-after-alert-claim",
        type: "terminate",
        callId: "call-in-1",
        phoneNumberId: "business-1"
      });
    }
    return read(key2);
  }, "get") };
  await f.runtime.dispatchIncomingAlert("call-in-1");
  assert10.equal(f.effects.filter((item) => item.kind === "notify" && item.event === "incoming").length, 0);
  assert10.equal((await f.runtime.locate("call-in-1")).phase, "ended");
});
test9("priority and ordinary recovery workers share one lease and never duplicate an incoming alert", async () => {
  const f = fixture(), entered = deferred2(), released = deferred2();
  await f.incoming();
  await f.incoming();
  let notifications = 0;
  f.runtime.notify = async (event) => {
    assert10.equal(event.event, "incoming");
    notifications++;
    entered.resolve();
    await released.promise;
  };
  const priority = f.runtime.dispatchIncomingAlert("call-in-1");
  await entered.promise;
  try {
    await Promise.all([f.runtime.dispatchIncomingAlert("call-in-1"), f.runtime.recoverSession("call-in-1")]);
    assert10.equal(notifications, 1);
  } finally {
    released.resolve();
  }
  await priority;
  await f.runtime.recoverSession("call-in-1");
  assert10.equal(notifications, 1);
  assert10.equal((await f.runtime.locate("call-in-1")).outbox.find((item) => item.event === "incoming").attempts, 1);
});
test9("failed priority notification remains recoverable and a later terminal event suppresses its retry", async () => {
  const f = fixture();
  await f.incoming();
  let attempts = 0;
  f.runtime.notify = async () => {
    attempts++;
    throw Error("Synthetic FCM outage");
  };
  const result = await f.runtime.dispatchIncomingAlert("call-in-1");
  assert10.equal(result.dispatched, false);
  assert10.equal(attempts, 1);
  assert10.equal((await f.runtime.locate("call-in-1")).outbox.find((item) => item.event === "incoming").status, "pending");
  await f.runtime.dispatchIncomingAlert("call-in-1");
  assert10.equal(attempts, 1);
  await f.runtime.ingestVerifiedMetaEvent({
    verified: true,
    eventId: "end-before-alert-retry",
    type: "terminate",
    callId: "call-in-1",
    phoneNumberId: "business-1"
  });
  f.advance(3e3);
  await f.runtime.dispatchIncomingAlert("call-in-1");
  assert10.equal(attempts, 1);
});
test9("racing answers choose one enrolled device and never issue a second connector accept", async () => {
  const f = fixture();
  await f.incoming();
  const results = await Promise.allSettled([f.accept("call-in-1", "a"), f.accept("call-in-1", "b")]);
  assert10.equal(results.filter((row) => row.status === "fulfilled").length, 1);
  assert10.equal(f.effects.filter((row) => row.kind === "accept").length, 1);
  assert10.equal((await f.store.get(sessionKey2("call-in-1"))).owner.deviceId, "a");
});
test9("replayed accept resumes the same leg without accepting Meta again", async () => {
  const f = fixture();
  await f.incoming();
  const first = await f.accept();
  const second = await f.accept();
  assert10.equal(first.join.identity, second.join.identity);
  assert10.equal(first.readinessNonce, second.readinessNonce);
  assert10.equal(f.effects.filter((row) => row.kind === "accept").length, 1);
});
test9("terminate before delayed incoming offer cannot resurrect ringing or issue audio", async () => {
  const f = fixture();
  await f.runtime.ingestVerifiedMetaEvent({ verified: true, eventId: "terminal-first", type: "terminate", callId: "call-in-1", phoneNumberId: "business-1" });
  await f.incoming();
  assert10.equal((await f.runtime.status("a", "call-in-1")).call.phase, "ended");
  await assert10.rejects(f.accept(), { code: "CALL_ENDED" });
  assert10.equal(f.effects.length, 0);
});
test9("customer hangup during initial readiness prevents canonical connected call creation", async () => {
  const f = fixture(), entered = deferred2(), wait = deferred2();
  await f.incoming();
  const accepted = await f.accept();
  f.runtime.verifyReadiness = async (data) => {
    entered.resolve();
    await wait.promise;
    return f.proof(data);
  };
  const ready = f.ready(accepted);
  await entered.promise;
  await f.runtime.ingestVerifiedMetaEvent({ verified: true, eventId: "during-ready-end", type: "terminate", callId: "call-in-1", phoneNumberId: "business-1" });
  wait.resolve();
  await assert10.rejects(ready, { code: "CALL_CHANGED" });
  assert10.equal(await f.store.get(callStoreKey3("call-in-1")), void 0);
});
test9("outgoing idempotency and unknown dial result never redial", async () => {
  const f = fixture();
  f.provider.dialOutgoing = async (data) => {
    f.effects.push({ kind: "dial", ...data });
    throw Error("lost HTTP response");
  };
  let sessionId;
  await assert10.rejects(f.runtime.outgoing("a", { to: "919999999999", requestId: "dial-request-1" }), (error) => {
    sessionId = error.sessionId;
    return error.code === "MEDIA_REQUEST_UNCERTAIN";
  });
  const replay = await f.runtime.outgoing("a", { to: "919999999999", requestId: "dial-request-1" });
  assert10.equal(replay.call.sessionId, sessionId);
  assert10.equal(replay.call.phase, "uncertain");
  assert10.equal(f.effects.filter((row) => row.kind === "dial").length, 1);
  await assert10.rejects(f.runtime.outgoing("a", { to: "918888888888", requestId: "dial-request-1" }), { code: "REQUEST_ID_CONFLICT" });
  assert10.equal((await f.store.get(deviceReservationKey3("a"))).kind, "pending");
});
test9("early outgoing answer correlates opaque session and survives lost dial acknowledgement", async () => {
  const f = fixture();
  f.provider.dialOutgoing = async (data) => {
    await f.runtime.ingestVerifiedMetaEvent({
      verified: true,
      eventId: "early-connect",
      type: "connect",
      direction: "outgoing",
      callId: "call-out-1",
      phoneNumberId: "business-1",
      opaqueSessionId: data.requestId,
      answerSdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
    });
    throw Error("response lost after connect");
  };
  await assert10.rejects(f.runtime.outgoing("a", { to: "919999999999", requestId: "early-request-1" }), { code: "MEDIA_REQUEST_UNCERTAIN" });
  const state = await f.runtime.status("a", "call-out-1");
  assert10.equal(state.call.phase, "connecting");
  assert10.equal(state.call.providerCallId, "call-out-1");
  await f.runtime.recoverSession(state.call.sessionId);
  assert10.equal(f.effects.filter((row) => row.kind === "connect").length, 1);
});
test9("cancel before outgoing provider ID keeps reservation until late call cleanup", async () => {
  const f = fixture(), entered = deferred2(), wait = deferred2();
  const original = f.provider.dialOutgoing;
  f.provider.dialOutgoing = async (data) => {
    entered.resolve(data.requestId);
    await wait.promise;
    return original(data);
  };
  const dialing = f.runtime.outgoing("a", { to: "919999999999", requestId: "cancel-request-1" });
  const id = await entered.promise, state = await f.runtime.status("a", id);
  await f.runtime.end("a", id, { version: state.call.version, requestId: "end-before-id-1" });
  await f.runtime.recoverSession(id);
  assert10.ok(await f.store.get(deviceReservationKey3("a")));
  wait.resolve();
  const result = await dialing;
  assert10.equal(result.call.roomReady, false);
  await f.runtime.recoverSession(id);
  await f.runtime.recoverSession(id);
  assert10.equal((await f.runtime.status("a", id)).call.phase, "ended");
  assert10.equal(await f.store.get(deviceReservationKey3("a")), void 0);
  assert10.ok(f.effects.some((row) => row.kind === "terminate" && row.callId === "call-out-1"));
});
test9("revocation sweeper ends active media server-side without a cooperative phone", async () => {
  const f = fixture();
  await f.connected();
  f.devices.get("a").revoked = true;
  await f.runtime.recoverSession("call-in-1");
  const call = await f.store.get(callStoreKey3("call-in-1"));
  assert10.equal(call.active, false);
  assert10.equal(call.terminal.policyReason, "CREDENTIAL_REVOKED");
  assert10.ok(f.effects.some((row) => row.kind === "detach"));
  await assert10.rejects(f.runtime.status("a", "call-in-1"), { code: "DEVICE_BINDING_INVALID" });
});
test9("changed credential generation cannot confirm old initial readiness", async () => {
  const f = fixture();
  await f.incoming();
  const accepted = await f.accept();
  f.devices.get("a").credentialGeneration++;
  await assert10.rejects(f.ready(accepted), { code: "NOT_CALL_OWNER" });
  assert10.equal(await f.store.get(callStoreKey3("call-in-1")), void 0);
});
test9("runtime transfer preserves source until confirmed target evidence and detaches source only", async () => {
  const f = fixture();
  const connected = await f.connected();
  const invitation = await f.runtime.transfer("a", "call-in-1", "invite", { toDeviceId: "b", version: connected.call.version, requestId: "transfer-req-1" });
  const accepted = await f.runtime.transfer("b", "call-in-1", "accept", { transferId: invitation.call.transfer.id, version: invitation.call.version });
  assert10.equal(accepted.call.ownerDeviceId, "a");
  assert10.ok(accepted.join.customerIdentity);
  const committed = await f.runtime.transfer("b", "call-in-1", "ready", {
    transferId: invitation.call.transfer.id,
    version: accepted.call.version,
    readinessNonce: accepted.readinessNonce,
    evidence: { unitTest: true }
  });
  assert10.equal(committed.call.ownerDeviceId, "b");
  assert10.equal(f.effects.filter((row) => row.kind === "terminate").length, 0);
  await f.runtime.recoverSession("call-in-1");
  assert10.equal((await f.store.get(callStoreKey3("call-in-1"))).transfer.status, "completed");
  assert10.equal(f.effects.filter((row) => row.kind === "terminate").length, 0);
});
test9("re-enrolled target cannot accept a prior transfer notification", async () => {
  const f = fixture();
  const connected = await f.connected();
  const invitation = await f.runtime.transfer("a", "call-in-1", "invite", { toDeviceId: "b", version: connected.call.version, requestId: "transfer-req-2" });
  f.devices.get("b").credentialGeneration++;
  await assert10.rejects(
    f.runtime.transfer("b", "call-in-1", "accept", { transferId: invitation.call.transfer.id, version: invitation.call.version }),
    { code: "DEVICE_BINDING_CHANGED" }
  );
  await f.runtime.recoverSession("call-in-1");
  assert10.equal((await f.store.get(callStoreKey3("call-in-1"))).owner.deviceId, "a");
  assert10.equal(f.effects.filter((row) => row.kind === "terminate").length, 0);
});
test9("provider project changes never send an existing call to a new media project", async () => {
  const f = fixture();
  await f.incoming();
  f.provider.config.fingerprint = "new-project";
  await assert10.rejects(f.accept(), { code: "MEDIA_PROJECT_CHANGED" });
  assert10.equal(f.effects.length, 0);
});
test9("legacy and native first answers arbitrate atomically without tearing down the winner", async () => {
  const f = fixture();
  await f.incoming();
  const results = await Promise.allSettled([f.runtime.claimLegacyIncoming("call-in-1", "legacy-device-a"), f.accept()]);
  assert10.equal(results.filter((row) => row.status === "fulfilled").length, 1);
  const session2 = await f.store.get(sessionKey2("call-in-1"));
  if (session2.routeChoice === "legacy") {
    assert10.equal(await f.runtime.isMediaAnchored("call-in-1"), false);
    assert10.equal((await f.runtime.claimLegacyIncoming("call-in-1", "legacy-device-a")).replayed, true);
    await f.runtime.recoverSession(session2.id);
    assert10.equal(f.effects.filter((row) => ["accept", "reject", "terminate"].includes(row.kind)).length, 0);
  } else assert10.equal(await f.runtime.isMediaAnchored("call-in-1"), true);
});
test9("a native-owned call cannot be claimed or rejected by a browser operation", async () => {
  const f = fixture();
  await f.incoming();
  await f.accept();
  await assert10.rejects(f.runtime.claimLegacyIncoming("call-in-1", "legacy-device-b"), { code: "CALL_OWNED_BY_NATIVE" });
  assert10.equal(await f.runtime.isMediaAnchored("call-in-1"), true);
});
test9("rejecting an unaccepted incoming call confirms only actual reject acknowledgement", async () => {
  const f = fixture();
  await f.incoming();
  const status = await f.runtime.status("a", "call-in-1");
  await f.runtime.end("a", "call-in-1", { version: status.call.version, requestId: "reject-req-1", reject: true });
  f.runtime.rejectIncoming = async () => {
    throw Error("temporary");
  };
  await f.runtime.recoverSession("call-in-1");
  assert10.equal((await f.runtime.status("a", "call-in-1")).call.endConfirmed, false);
  assert10.equal(f.effects.filter((row) => row.kind === "terminate").length, 0);
  f.advance(3e3);
  f.runtime.rejectIncoming = async (data) => f.effects.push({ kind: "reject", ...data });
  await f.runtime.recoverSession("call-in-1");
  assert10.equal((await f.runtime.status("a", "call-in-1")).call.endConfirmed, true);
});
test9("cancel by request ID before delayed outgoing POST prevents any dial", async () => {
  const f = fixture();
  const cancel = await f.runtime.cancelOutgoing("a", "never-dial-request-1");
  assert10.equal(cancel.cancelled, true);
  assert10.equal(cancel.awaitingOriginalRequest, true);
  const result = await f.runtime.outgoing("a", { to: "919999999999", requestId: "never-dial-request-1" });
  assert10.equal(result.cancelled, true);
  assert10.equal(result.call.phase, "ended");
  assert10.equal(await f.store.get(deviceReservationKey3("a")), void 0);
  assert10.equal(f.effects.length, 0);
});
test9("lost answer acknowledgement is not replayed after corroborated media readiness", async () => {
  const f = fixture();
  const dialing = await f.runtime.outgoing("a", { to: "919999999999", requestId: "connect-once-1" });
  await f.runtime.ingestVerifiedMetaEvent({
    verified: true,
    eventId: "connect-ready",
    type: "connect",
    callId: "call-out-1",
    phoneNumberId: "business-1",
    opaqueSessionId: dialing.call.sessionId,
    answerSdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
  });
  f.provider.connectOutgoing = async () => {
    f.effects.push({ kind: "connect" });
    throw Error("lost acknowledgement");
  };
  await f.runtime.recoverSession(dialing.call.sessionId);
  await f.runtime.ingestVerifiedMetaEvent({ verified: true, eventId: "accepted-connect-once", type: "accepted", callId: "call-out-1", phoneNumberId: "business-1" });
  const resumed = await f.runtime.accept("a", dialing.call.sessionId, { requestId: "connect-once-1" });
  await f.ready(resumed);
  f.advance(3e3);
  await f.runtime.recoverSession(dialing.call.sessionId);
  assert10.equal(f.effects.filter((row) => row.kind === "connect").length, 1);
});
test9("outgoing SDP and ringback evidence cannot become Connected before trusted customer acceptance", async () => {
  const f = fixture();
  const dialing = await f.runtime.outgoing("a", { to: "919999999999", requestId: "answer-gate-request" });
  await f.runtime.ingestVerifiedMetaEvent({
    verified: true,
    eventId: "ringback-connect",
    type: "connect",
    callId: "call-out-1",
    phoneNumberId: "business-1",
    answerSdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
  });
  const joining = await f.runtime.accept("a", dialing.call.sessionId, { requestId: "answer-gate-request" });
  assert10.equal(joining.call.customerAcceptedAt, null);
  await assert10.rejects(f.ready(joining), { code: "CUSTOMER_NOT_ACCEPTED" });
  assert10.equal(await f.store.get(callStoreKey3("call-out-1")), void 0);
  assert10.equal((await f.runtime.status("a", dialing.call.sessionId)).call.roomReady, false);
  await assert10.rejects(f.runtime.ingestVerifiedMetaEvent({ verified: false, type: "accepted" }), { code: "UNVERIFIED_WEBHOOK" });
  await f.runtime.ingestVerifiedMetaEvent({ verified: true, eventId: "recipient-accepted", type: "accepted", callId: "call-out-1", phoneNumberId: "business-1" });
  const accepted = await f.runtime.accept("a", dialing.call.sessionId, { requestId: "answer-gate-request" });
  assert10.equal(accepted.call.customerAcceptedAt, f.now());
  assert10.equal(accepted.call.roomReady, false);
  const connected = await f.ready(accepted);
  assert10.equal(connected.call.phase, "connected");
  assert10.equal(connected.call.roomReady, true);
});
test9("early ACCEPTED before call-ID correlation is durable and consumed by the eventual SDK result", async () => {
  const f = fixture(), entered = deferred2(), wait = deferred2();
  const dial = f.provider.dialOutgoing;
  f.provider.dialOutgoing = async (data) => {
    entered.resolve();
    await wait.promise;
    return dial(data);
  };
  const pending = f.runtime.outgoing("a", { to: "919999999999", requestId: "early-accepted-request" });
  await entered.promise;
  const event = { verified: true, eventId: "accept-before-id", type: "accepted", callId: "call-out-1", phoneNumberId: "business-1" };
  const uncorrelated = await f.runtime.ingestVerifiedMetaEvent(event);
  assert10.equal(uncorrelated.handled, false);
  const marker = await f.store.get(eventKey("accepted:call-out-1"));
  assert10.equal(marker.kind, "customer-accepted");
  assert10.equal(marker.acceptedAt, f.now());
  f.advance(1e3);
  await f.runtime.ingestVerifiedMetaEvent(event);
  wait.resolve();
  const result = await pending;
  assert10.equal(result.call.customerAcceptedAt, marker.acceptedAt);
  assert10.equal(result.call.roomReady, false);
  assert10.equal(f.effects.filter((item) => item.kind === "dial").length, 1);
});
test9("early ACCEPTED with opaque correlation resolves a lost dial response without redial", async () => {
  const f = fixture();
  f.provider.dialOutgoing = async (data) => {
    f.effects.push({ kind: "dial" });
    await f.runtime.ingestVerifiedMetaEvent({
      verified: true,
      eventId: "accept-with-opaque",
      type: "accepted",
      callId: "call-out-1",
      phoneNumberId: "business-1",
      opaqueSessionId: data.requestId
    });
    throw Error("dial response lost after accepted webhook");
  };
  let sessionId;
  await assert10.rejects(f.runtime.outgoing("a", { to: "919999999999", requestId: "opaque-accept-request" }), (error) => {
    sessionId = error.sessionId;
    return error.code === "MEDIA_REQUEST_UNCERTAIN";
  });
  const resumed = await f.runtime.accept("a", sessionId, { requestId: "opaque-accept-request" });
  assert10.equal(resumed.call.customerAcceptedAt, f.now());
  assert10.ok(resumed.join);
  assert10.equal((await f.store.get(sessionKey2(sessionId))).operations.dial.status, "acknowledged");
  assert10.equal(f.effects.filter((item) => item.kind === "dial").length, 1);
});
test9("terminal before late ACCEPTED wins even when the dial response arrives afterwards", async () => {
  const f = fixture(), entered = deferred2(), wait = deferred2();
  const dial = f.provider.dialOutgoing;
  f.provider.dialOutgoing = async (data) => {
    entered.resolve();
    await wait.promise;
    return dial(data);
  };
  const pending = f.runtime.outgoing("a", { to: "919999999999", requestId: "declined-answer-request" });
  await entered.promise;
  await f.runtime.ingestVerifiedMetaEvent({ verified: true, eventId: "customer-declined", type: "terminate", callId: "call-out-1", phoneNumberId: "business-1" });
  await f.runtime.ingestVerifiedMetaEvent({ verified: true, eventId: "late-customer-accepted", type: "accepted", callId: "call-out-1", phoneNumberId: "business-1" });
  wait.resolve();
  const result = await pending;
  assert10.equal(result.call.phase, "ended");
  assert10.equal(result.call.customerAcceptedAt, null);
  assert10.equal(result.call.roomReady, false);
  assert10.equal(await f.store.get(callStoreKey3("call-out-1")), void 0);
  const terminal = result.call.terminal;
  f.advance(1e3);
  await f.runtime.ingestVerifiedMetaEvent({ verified: true, eventId: "duplicate-late-accepted", type: "accepted", callId: "call-out-1", phoneNumberId: "business-1" });
  const state = (await f.runtime.status("a", result.call.sessionId)).call;
  assert10.deepEqual(state.terminal, terminal);
  assert10.equal(state.customerAcceptedAt, null);
  assert10.equal(state.roomReady, false);
});
test9("duplicate ACCEPTED cannot change the acceptance time or regress a connected call", async () => {
  const f = fixture();
  const dial = await f.runtime.outgoing("a", { to: "919999999999", requestId: "accepted-replay-request" });
  const event = { verified: true, eventId: "accepted-first-event", type: "accepted", callId: "call-out-1", phoneNumberId: "business-1" };
  await f.runtime.ingestVerifiedMetaEvent(event);
  const joining = await f.runtime.accept("a", dial.call.sessionId, { requestId: "accepted-replay-request" });
  await f.ready(joining);
  const acceptedAt = f.now();
  f.advance(1e3);
  const replay = await f.runtime.ingestVerifiedMetaEvent(event);
  assert10.equal(replay.replayed, true);
  await f.runtime.ingestVerifiedMetaEvent({ ...event, eventId: "accepted-repeated-status" });
  await f.runtime.ingestVerifiedMetaEvent({ ...event, type: "connect", eventId: "late-answer-after-connected", answerSdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" });
  const state = (await f.runtime.status("a", dial.call.sessionId)).call;
  assert10.equal(state.customerAcceptedAt, acceptedAt);
  assert10.equal(state.phase, "connected");
  assert10.equal(state.roomReady, true);
  assert10.equal((await f.store.get(sessionKey2(dial.call.sessionId))).phase, "connected");
});
test9("verified channel linkage is idempotent metadata and does not stale pending readiness", async () => {
  const f = fixture();
  await f.incoming();
  const accepted = await f.accept();
  assert10.equal(accepted.call.channelId, 0);
  const linked = await f.runtime.attachVerifiedChannel("call-in-1", 321);
  assert10.equal(linked.attached, true);
  const state = (await f.runtime.status("a", "call-in-1")).call;
  assert10.equal(state.channelId, 321);
  assert10.equal(state.version, accepted.call.version);
  assert10.equal((await f.runtime.attachVerifiedChannel("call-in-1", 321)).attached, true);
  assert10.equal((await f.runtime.attachVerifiedChannel("call-in-1", 654)).attached, false);
  await assert10.rejects(f.runtime.attachVerifiedChannel("call-in-1", -1), { code: "INVALID_CHANNEL_ID" });
  const connected = await f.ready(accepted);
  assert10.equal(connected.call.channelId, 321);
  assert10.equal(connected.call.roomReady, true);
});
test9("customer terminal event wins atomically against target readiness and preserves ended owner", async () => {
  const f = fixture(), entered = deferred2(), wait = deferred2();
  const connected = await f.connected();
  const invited = await f.runtime.transfer("a", "call-in-1", "invite", { toDeviceId: "b", version: connected.call.version, requestId: "race-transfer-1" });
  const accepted = await f.runtime.transfer("b", "call-in-1", "accept", { transferId: invited.call.transfer.id, version: invited.call.version });
  f.runtime.verifyReadiness = async (data) => {
    entered.resolve();
    await wait.promise;
    return f.proof(data);
  };
  const ready = f.runtime.transfer("b", "call-in-1", "ready", {
    transferId: invited.call.transfer.id,
    version: accepted.call.version,
    readinessNonce: accepted.readinessNonce,
    evidence: {}
  });
  await entered.promise;
  await f.runtime.ingestVerifiedMetaEvent({ verified: true, eventId: "customer-race-end", type: "terminate", callId: "call-in-1", phoneNumberId: "business-1" });
  const ended = await f.store.get(callStoreKey3("call-in-1"));
  assert10.equal(ended.active, false);
  assert10.equal(ended.owner.deviceId, "a");
  wait.resolve();
  await assert10.rejects(ready);
  assert10.equal((await f.store.get(callStoreKey3("call-in-1"))).owner.deviceId, "a");
});
test9("decline/expiry transfer notifications are exact and failed FCM remains pending", async () => {
  const f = fixture();
  const connected = await f.connected();
  const invited = await f.runtime.transfer("a", "call-in-1", "invite", { toDeviceId: "b", version: connected.call.version, requestId: "notify-transfer-1" });
  await f.runtime.transfer("b", "call-in-1", "decline", { transferId: invited.call.transfer.id, version: invited.call.version });
  f.runtime.notify = async () => {
    throw Error("FCM failed");
  };
  await f.runtime.recoverSession("call-in-1");
  const session2 = await f.store.get(sessionKey2("call-in-1"));
  const ended = session2.outbox.find((row) => row.event === "transfer-ended");
  assert10.equal(ended.transferId, invited.call.transfer.id);
  assert10.equal(ended.toDeviceId, "b");
  assert10.equal(ended.status, "pending");
  assert10.equal((await f.store.get(callStoreKey3("call-in-1"))).owner.deviceId, "a");
});
test9("credential generation change during target telemetry cannot commit ownership", async () => {
  const f = fixture(), entered = deferred2(), wait = deferred2();
  const connected = await f.connected();
  const invited = await f.runtime.transfer("a", "call-in-1", "invite", { toDeviceId: "b", version: connected.call.version, requestId: "credential-race-1" });
  const accepted = await f.runtime.transfer("b", "call-in-1", "accept", { transferId: invited.call.transfer.id, version: invited.call.version });
  f.runtime.verifyReadiness = async (data) => {
    entered.resolve();
    await wait.promise;
    return f.proof(data);
  };
  const ready = f.runtime.transfer("b", "call-in-1", "ready", {
    transferId: invited.call.transfer.id,
    version: accepted.call.version,
    readinessNonce: accepted.readinessNonce,
    evidence: {}
  });
  await entered.promise;
  f.devices.get("b").credentialGeneration++;
  wait.resolve();
  await assert10.rejects(ready, { code: "DEVICE_BINDING_CHANGED" });
  assert10.equal((await f.store.get(callStoreKey3("call-in-1"))).owner.deviceId, "a");
});
test9("connected owner can restore its same leg beyond the original joining timeout", async () => {
  const f = fixture();
  await f.connected();
  f.advance(18e4);
  const resumed = await f.runtime.accept("a", "call-in-1", { requestId: "resume-after-minutes" });
  assert10.equal(resumed.call.roomReady, true);
  assert10.ok(resumed.join.token);
  assert10.equal(f.effects.filter((row) => row.kind === "accept").length, 1);
});
test9("cancel after durable attempt but before dispatch does not call the provider", async () => {
  const f = fixture(), entered = deferred2(), wait = deferred2();
  let authentications = 0;
  f.runtime.authenticate = async (context) => {
    if (++authentications === 2) {
      entered.resolve();
      await wait.promise;
    }
    return f.actor(context);
  };
  const dialing = f.runtime.outgoing("a", { to: "919999999999", requestId: "cancel-preflight-1" });
  await entered.promise;
  const cancel = await f.runtime.cancelOutgoing("a", "cancel-preflight-1");
  assert10.equal(cancel.cancelled, true);
  wait.resolve();
  await assert10.rejects(dialing, { code: "CALL_ENDED" });
  assert10.equal(f.effects.filter((row) => row.kind === "dial").length, 0);
  assert10.equal((await f.runtime.status("a", cancel.sessionId)).call.endConfirmed, true);
});
test9("a killed operator process is cleaned after confirmed exact-leg absence and reconnect grace", async () => {
  const f = fixture();
  await f.connected();
  f.provider.inspectParticipants = async () => ({ observedAt: f.now(), operatorActive: false, customerActive: true });
  await f.runtime.recoverSession("call-in-1");
  f.advance(3e4);
  await f.runtime.recoverSession("call-in-1");
  assert10.equal((await f.store.get(callStoreKey3("call-in-1"))).active, true);
  f.advance(16e3);
  await f.runtime.recoverSession("call-in-1");
  const call = await f.store.get(callStoreKey3("call-in-1"));
  assert10.equal(call.active, false);
  assert10.equal(call.terminal.policyReason, "OPERATOR_DISCONNECTED");
  assert10.equal(await f.store.get(deviceReservationKey3("a")), void 0);
});
test9("provider API outage never counts as operator disappearance and reappearance clears the grace", async () => {
  const f = fixture();
  await f.connected();
  f.provider.inspectParticipants = async () => ({ observedAt: f.now(), operatorActive: false });
  await f.runtime.recoverSession("call-in-1");
  f.advance(6e4);
  f.provider.inspectParticipants = async () => {
    throw Error("control API offline");
  };
  await f.runtime.recoverSession("call-in-1");
  assert10.equal((await f.store.get(callStoreKey3("call-in-1"))).active, true);
  f.provider.inspectParticipants = async () => ({ observedAt: f.now(), operatorActive: true });
  await f.runtime.recoverSession("call-in-1");
  assert10.equal((await f.store.get(sessionKey2("call-in-1"))).ownerAbsent, void 0);
  assert10.equal(f.effects.filter((row) => row.kind === "terminate").length, 0);
});
test9("official room-not-found observation cannot leave a device permanently reserved", async () => {
  const f = fixture();
  await f.connected();
  f.provider.inspectParticipants = async () => {
    throw Object.assign(Error("room absent"), { providerCode: "not_found" });
  };
  await f.runtime.recoverSession("call-in-1");
  f.advance(46e3);
  await f.runtime.recoverSession("call-in-1");
  assert10.equal((await f.store.get(callStoreKey3("call-in-1"))).active, false);
  assert10.equal(await f.store.get(deviceReservationKey3("a")), void 0);
});
test9("old source absence result cannot terminate a newly committed target owner", async () => {
  const f = fixture(), entered = deferred2(), wait = deferred2();
  const connected = await f.connected();
  const originalInspect = f.provider.inspectParticipants;
  const originalOwner = (await f.store.get(callStoreKey3("call-in-1"))).owner.identity;
  f.provider.inspectParticipants = async () => ({ observedAt: f.now(), operatorActive: false });
  await f.runtime.recoverSession("call-in-1");
  f.advance(46e3);
  const invited = await f.runtime.transfer("a", "call-in-1", "invite", { toDeviceId: "b", version: connected.call.version, requestId: "absence-transfer-1" });
  const accepted = await f.runtime.transfer("b", "call-in-1", "accept", { transferId: invited.call.transfer.id, version: invited.call.version });
  f.provider.inspectParticipants = async (data) => {
    if (data.operatorIdentity === originalOwner) {
      entered.resolve();
      await wait.promise;
      return { observedAt: f.now(), operatorActive: false };
    }
    return originalInspect(data);
  };
  const sweep = f.runtime.recoverSession("call-in-1");
  await entered.promise;
  await f.runtime.transfer("b", "call-in-1", "ready", {
    transferId: invited.call.transfer.id,
    version: accepted.call.version,
    readinessNonce: accepted.readinessNonce,
    evidence: {}
  });
  wait.resolve();
  await sweep;
  const call = await f.store.get(callStoreKey3("call-in-1"));
  assert10.equal(call.active, true);
  assert10.equal(call.owner.deviceId, "b");
  assert10.equal(f.effects.filter((row) => row.kind === "terminate").length, 0);
});

// call-runtime/test/readiness.test.mjs
/*! SOURCE call-runtime/test/readiness.test.mjs | SHA-256 0615d5bc3492d570bc7a85474401e7cbbc245f337249e2519305cd72b6678d21 */
import test10 from "node:test";
import assert11 from "node:assert/strict";
import { createNativeReadinessVerifier } from "../call-runtime/readiness.mjs";
import { LiveKitWhatsAppProvider as LiveKitWhatsAppProvider2, readLiveKitConfig as readLiveKitConfig2, operatorIdentity as operatorIdentity4 } from "../media/livekit-provider.mjs";
function inputs() {
  const identity = operatorIdentity4("phone-a", "leg-1");
  const actor = { deviceId: "phone-a" }, call = {
    id: "call-1",
    roomName: "room-1",
    customerIdentity: "customer-1",
    owner: { deviceId: "phone-a", identity, legId: "leg-1" },
    readinessNonce: "nonce-1"
  };
  const evidence = {
    protocol: "sh-room-audio-v1",
    legId: "leg-1",
    identity,
    roomName: "room-1",
    participantSid: "PA_OPERATOR",
    localAudioTrackSid: "TR_MIC",
    customerIdentity: "customer-1",
    customerAudioTrackSid: "TR_CUSTOMER",
    sampleDurationMs: 1e3,
    sampleAgeMs: 10,
    outbound: { packetsDelta: 30, bytesDelta: 3e3 },
    inbound: { packetsDelta: 31, bytesDelta: 4e3, decodedFramesDelta: 960 },
    iceState: "succeeded",
    dtlsState: "connected"
  };
  const participants = [
    { sid: "PA_OPERATOR", identity, state: "ACTIVE", tracks: [{ sid: "TR_MIC", type: "AUDIO", muted: false }] },
    { sid: "PA_CUSTOMER", identity: "customer-1", state: "ACTIVE", tracks: [{ sid: "TR_CUSTOMER", type: "AUDIO", muted: false }] }
  ];
  return { actor, call, evidence, participants };
}
__name(inputs, "inputs");
test10("official SDK participant decoding corroborates exact native audio track evidence", async () => {
  const data = inputs(), previous = globalThis.fetch, requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ participants: data.participants }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const provider = new LiveKitWhatsAppProvider2(readLiveKitConfig2({
      LIVEKIT_URL: "wss://unit.livekit.cloud",
      LIVEKIT_API_KEY: "unit-key",
      LIVEKIT_API_SECRET: "unit-test-secret",
      WHATSAPP_CALL_ACCESS_TOKEN: "unit-meta-token"
    }));
    const verify = createNativeReadinessVerifier({ provider, now: /* @__PURE__ */ __name(() => 18e11, "now") });
    const result = await verify(data);
    assert11.equal(result.verified, true);
    assert11.equal(result.audiblePlaybackVerified, false);
    assert11.equal(result.identity, data.call.owner.identity);
    assert11.equal(result.readinessNonce, "nonce-1");
    assert11.equal(requests.length, 1);
    assert11.match(requests[0].url, /RoomService\/ListParticipants$/);
    assert11.equal(requests[0].body.room, "room-1");
  } finally {
    globalThis.fetch = previous;
  }
});
test10("connected flag, old sample, wrong leg and missing decoded frames never prove readiness", async () => {
  let calls = 0;
  const provider = { rooms: { listParticipants: /* @__PURE__ */ __name(async () => {
    calls++;
    return [];
  }, "listParticipants") }, run: /* @__PURE__ */ __name(async (_name, fn) => fn(), "run") };
  const verify = createNativeReadinessVerifier({ provider });
  for (const patch of [
    { connected: true },
    { sampleAgeMs: 2500 },
    { legId: "old-leg" },
    { inbound: { packetsDelta: 1, bytesDelta: 1, decodedFramesDelta: 0 } },
    { dtlsState: "connecting" }
  ]) {
    const data = inputs();
    data.evidence = Object.keys(patch).length === 1 && patch.connected ? patch : { ...data.evidence, ...patch };
    await assert11.rejects(verify(data));
  }
  assert11.equal(calls, 0);
});
test10("a real native report for a different provider participant or muted track is refused", async () => {
  const data = inputs();
  const provider = { rooms: { listParticipants: /* @__PURE__ */ __name(async () => [{
    sid: "PA_OTHER",
    identity: data.call.owner.identity,
    state: 2,
    tracks: []
  }], "listParticipants") }, run: /* @__PURE__ */ __name(async (_name, fn) => fn(), "run") };
  await assert11.rejects(createNativeReadinessVerifier({ provider })(data), { code: "MEDIA_NOT_READY" });
});

// call-runtime/test/startup.test.mjs
/*! SOURCE call-runtime/test/startup.test.mjs | SHA-256 5222775402617a250d6c11ff7815720e48d5c23c350a4ddb4b6eb038487d8237 */
import test11 from "node:test";
import assert12 from "node:assert/strict";
import { createNativeCallRuntime } from "../call-runtime/startup.mjs";
function startup(f, policy) {
  return createNativeCallRuntime({
    store: f.store,
    provider: f.provider,
    authenticate: f.actor,
    resolveDevice: /* @__PURE__ */ __name(async (id) => f.devices.get(id), "resolveDevice"),
    listDevices: /* @__PURE__ */ __name(async () => [...f.devices.values()], "listDevices"),
    capabilities: /* @__PURE__ */ __name(async () => policy, "capabilities"),
    phoneNumberId: "business-1",
    minimumNativeBuild: 10,
    now: f.now
  });
}
__name(startup, "startup");
test11("a config flag and successful control probe alone never enable production transfer", async () => {
  const f = fixture(), policy = { roomCalling: true, transferEnabled: true, mode: "production" };
  const service = startup(f, policy);
  assert12.equal((await service.runtime.capabilities("a")).roomCalling, false);
  await service.verifyConfiguration();
  const capabilities = await service.runtime.capabilities("a");
  assert12.equal(capabilities.roomCalling, true);
  assert12.equal(capabilities.transferEnabled, false);
  assert12.equal(capabilities.nativeRoomUrl, "wss://test.livekit.cloud");
});
test11("explicit pilot needs at least two exact enrolled IDs and rejects arbitrary targets", async () => {
  const f = fixture();
  const connected = await f.connected();
  const policy = { roomCalling: true, transferEnabled: true, mode: "pilot", pilotEnabled: true, pilotDeviceIds: [] };
  const service = startup(f, policy);
  await service.verifyConfiguration();
  assert12.equal((await service.runtime.capabilities("a")).transferEnabled, false);
  policy.pilotDeviceIds = ["a", "b"];
  assert12.equal((await service.runtime.capabilities("a")).transferEnabled, true);
  assert12.equal((await service.runtime.capabilities("c")).transferEnabled, false);
  await assert12.rejects(service.runtime.transfer("a", "call-in-1", "invite", {
    toDeviceId: "c",
    version: connected.call.version,
    requestId: "pilot-forbidden-1",
    mode: "production",
    pilotDeviceIds: ["a", "c"]
  }), { code: "DEVICE_NOT_IN_TRANSFER_PILOT" });
  const invited = await service.runtime.transfer("a", "call-in-1", "invite", { toDeviceId: "b", version: connected.call.version, requestId: "pilot-allowed-1" });
  assert12.equal(invited.call.transfer.toDeviceId, "b");
});
test11("removing a device from the pilot or revoking it blocks an old invitation", async () => {
  const f = fixture();
  const connected = await f.connected();
  const policy = { roomCalling: true, transferEnabled: true, mode: "pilot", pilotEnabled: true, pilotDeviceIds: ["a", "b"] };
  const service = startup(f, policy);
  await service.verifyConfiguration();
  const invited = await service.runtime.transfer("a", "call-in-1", "invite", { toDeviceId: "b", version: connected.call.version, requestId: "pilot-remove-1" });
  policy.pilotDeviceIds = ["a", "c"];
  await assert12.rejects(
    service.runtime.transfer("b", "call-in-1", "accept", { transferId: invited.call.transfer.id, version: invited.call.version }),
    { code: "DEVICE_NOT_IN_TRANSFER_PILOT" }
  );
  assert12.equal(f.effects.filter((row) => row.kind === "terminate").length, 0);
});
test11("production evidence must bind current project and native build", async () => {
  const f = fixture(), policy = { roomCalling: true, transferEnabled: true, mode: "production", transferValidation: {
    enabled: true,
    provider: "livekit-whatsapp",
    providerFingerprint: "another-project",
    clientProtocol: "sh-room-audio-v1",
    nativeBuild: 10,
    liveTwoDeviceEvidenceId: "UNIT-TEST-ONLY-NOT-LIVE"
  } };
  const service = startup(f, policy);
  await service.verifyConfiguration();
  assert12.equal((await service.runtime.capabilities("a")).transferEnabled, false);
  policy.transferValidation.providerFingerprint = f.provider.config.fingerprint;
  policy.transferValidation.nativeBuild = 9;
  assert12.equal((await service.runtime.capabilities("a")).transferEnabled, false);
  policy.transferValidation.nativeBuild = 10;
  assert12.equal((await service.runtime.capabilities("a")).transferEnabled, true);
});

// call-runtime/test/routes.test.mjs
/*! SOURCE call-runtime/test/routes.test.mjs | SHA-256 b3f98ff37197db89e13cf4c20f7245e68f543cb675a0f11635a105d3c638491d */
import test12 from "node:test";
import assert13 from "node:assert/strict";
import { mountNativeCallRoutes } from "../call-runtime/routes.mjs";
function router(f) {
  const handlers = /* @__PURE__ */ new Map(), scheduled = [];
  const app = Object.fromEntries(["get", "post"].map((method) => [method, (path, fn) => handlers.set(`${method.toUpperCase()} ${path}`, fn)]));
  mountNativeCallRoutes(app, { runtime: f.runtime, scheduleRecovery: /* @__PURE__ */ __name((id) => scheduled.push(id), "scheduleRecovery") });
  const call = /* @__PURE__ */ __name(async (method, path, request = {}) => {
    const output = { headers: {} };
    const response = {
      set(key2, value) {
        output.headers[key2] = value;
        return this;
      },
      status(code) {
        output.status = code;
        return this;
      },
      json(value) {
        output.body = value;
        return this;
      }
    };
    await handlers.get(`${method} /api/operator-android${path}`)({ method, body: {}, params: {}, query: {}, ...request }, response);
    return output;
  }, "call");
  return { call, scheduled };
}
__name(router, "router");
test12("native route refuses cookie-only or body-provided operator identity", async () => {
  const f = fixture();
  await f.incoming();
  const r = router(f);
  const response = await r.call("POST", "/calls/:callId/accept", {
    headers: { cookie: "session_id=odoo-only" },
    params: { callId: "call-in-1" },
    body: { requestId: "spoofed-request-1", deviceId: "a", authenticated: true, canCall: true }
  });
  assert13.equal(response.status, 401);
  assert13.equal(response.body.code, "UNAUTHENTICATED_DEVICE");
  assert13.equal(f.effects.length, 0);
});
test12("status and capability wrappers are private, secret-free and do not schedule mutation recovery", async () => {
  const f = fixture();
  await f.incoming();
  const r = router(f), before = f.db.commits;
  const response = await r.call("GET", "/calls/:callId/status", { device: "a", params: { callId: "call-in-1" } });
  assert13.equal(response.status, 200);
  assert13.equal(response.headers["Cache-Control"], "no-store");
  assert13.ok(response.body.call.sessionId);
  assert13.doesNotMatch(JSON.stringify(response.body), /offerSdp|answerSdp|token|v=0/);
  assert13.equal(f.db.commits, before);
  assert13.equal(r.scheduled.length, 0);
  const capabilities = await r.call("GET", "/capabilities", { device: "a" });
  assert13.equal(capabilities.body.capabilities.nativeRoomCalls, true);
  assert13.equal(capabilities.body.capabilities.nativeRoomUrl, "wss://test.livekit.cloud");
});

// media-store/test/firestore-media-store.test.mjs
/*! SOURCE media-store/test/firestore-media-store.test.mjs | SHA-256 ef0a7cb596c65ec58ba76747d8b6c2d783a3271d66ed36311df188199c600a73 */
import test13 from "node:test";
import assert14 from "node:assert/strict";
import { createFirestoreMediaStore as createFirestoreMediaStore2, recoverMediaWork, MediaStoreError, sessionStoreKey, eventStoreKey } from "../media-store/firestore-media-store.mjs";
import { TransferController as TransferController4, callStoreKey as callStoreKey4, deviceReservationKey as deviceReservationKey4, newBridgedCall as newBridgedCall2 } from "../media/transfer-controller.mjs";
var NOW4 = 18e11;
function harness4(options = {}) {
  const db = options.firestore || new FirestoreFake2();
  let current = NOW4;
  const make = /* @__PURE__ */ __name(() => createFirestoreMediaStore2({ firestore: db, clock: /* @__PURE__ */ __name(() => current, "clock"), ...options }), "make");
  const store = make(), f = fixture2({ store, ...options.fixture });
  const advance = /* @__PURE__ */ __name((ms) => {
    current += ms;
    f.advance(ms);
  }, "advance");
  return { ...f, db, store, make, advance, clock: /* @__PURE__ */ __name(() => current, "clock") };
}
__name(harness4, "harness");
var rows = /* @__PURE__ */ __name((h, collection) => Object.entries(h.db.dump()).filter(([key2]) => key2.startsWith(`sh_operator_media_${collection}/`)).map(([, value]) => value), "rows");
var rejectsCode = /* @__PURE__ */ __name((operation, code) => assert14.rejects(operation, (error) => error.code === code), "rejectsCode");
test13("factory is lazy; absent get returns undefined and namespaces cannot escape", async () => {
  const h = harness4();
  assert14.equal(h.db.transactionRuns, 0);
  assert14.equal(h.store.durable, true);
  assert14.equal(await h.store.get(callStoreKey4("missing")), void 0);
  await rejectsCode(() => h.store.get("sh_operator_devices/secret"), "INVALID_MEDIA_STORE_INPUT");
  await rejectsCode(() => h.store.get("media_calls/../../device"), "INVALID_MEDIA_STORE_INPUT");
});
test13("initial call and owner are created atomically and cannot overwrite a busy device", async () => {
  const h = harness4();
  await h.seed();
  await rejectsCode(() => h.seed("call-2"), "RECORD_ALREADY_EXISTS");
  assert14.equal(await h.store.get(callStoreKey4("call-2")), void 0);
  assert14.equal((await h.store.get(deviceReservationKey4("a"))).callId, "call-1");
  const call = newBridgedCall2({
    callId: "call-3",
    roomName: "room-3",
    customerIdentity: "customer-3",
    tenantId: "smart",
    owner: { deviceId: "d", userId: "user-d", legId: "leg-initial-3" },
    now: NOW4
  });
  await h.store.createCall(call);
  await rejectsCode(() => h.store.createCall(call), "CALL_ALREADY_EXISTS");
});
test13("call-only initialization, direct call deletion and owner reservation deletion are prohibited", async () => {
  const h = harness4();
  const call = newBridgedCall2({
    callId: "bad",
    roomName: "room-bad",
    customerIdentity: "customer-bad",
    tenantId: "smart",
    owner: { deviceId: "a", userId: "user-a", legId: "leg-bad" },
    now: NOW4
  });
  await rejectsCode(() => h.store.transaction(async (tx) => tx.set(callStoreKey4("bad"), call)), "OWNER_RESERVATION_REQUIRED");
  await h.seed();
  await rejectsCode(() => h.store.transaction(async (tx) => tx.delete(callStoreKey4("call-1"))), "CALL_DELETE_FORBIDDEN");
  await rejectsCode(() => h.store.transaction(async (tx) => {
    await tx.get(deviceReservationKey4("a"));
    tx.delete(deviceReservationKey4("a"));
  }), "OWNER_RESERVATION_PROTECTED");
});
test13("transaction returns exact callback result and staged writes do not permit late reads", async () => {
  const h = harness4();
  await h.seed();
  const result = await h.store.transaction(async (tx) => {
    const call = await tx.get(callStoreKey4("call-1"));
    return { nested: [call.id, 7] };
  });
  assert14.deepEqual(result, { nested: ["call-1", 7] });
  await rejectsCode(() => h.store.transaction(async (tx) => {
    const call = await tx.get(callStoreKey4("call-1"));
    tx.set(callStoreKey4("call-1"), call);
    await tx.get(deviceReservationKey4("a"));
  }), "READS_BEFORE_WRITES");
});
test13("semantic call version and envelope revision are distinct during outbox bookkeeping", async () => {
  const h = harness4();
  await h.seed();
  const accepted = await h.accept(await h.invite());
  await h.ready(accepted);
  const before = await h.store.get(callStoreKey4("call-1"));
  const beforeRevision = rows(h, "calls")[0].revision;
  h.provider.detachOperator = async () => {
    throw Error("transient");
  };
  await h.controller.drainOutbox("call-1", { limit: 1 });
  const after = await h.store.get(callStoreKey4("call-1"));
  assert14.equal(after.version, before.version);
  assert14.equal(after.outbox[0].attempts, 1);
  assert14.ok(rows(h, "calls")[0].revision > beforeRevision);
});
test13("invitation and cleanup projections are created in the same transaction as call state", async () => {
  const h = harness4();
  await h.seed();
  const invited = await h.invite();
  assert14.equal(rows(h, "transfers").length, 1);
  assert14.equal(rows(h, "transfers")[0].transferId, invited.transfer.id);
  assert14.equal(rows(h, "jobs").length, 1);
  assert14.equal(rows(h, "jobs")[0].workType, "expire");
  const accepted = await h.accept(invited);
  await h.ready(accepted);
  assert14.equal(rows(h, "jobs").filter((row) => row.workType === "cleanup").length, 1);
  assert14.equal(rows(h, "jobs").find((row) => row.workType === "expire").sourceDueAtMs, Number.MAX_SAFE_INTEGER);
  assert14.equal((await h.store.get(deviceReservationKey4("a"))).kind, "cleanup");
});
test13("two store/controller instances cannot reserve one target for different calls", async () => {
  const h = harness4();
  await h.seed();
  await h.seed("call-2", "c");
  const other = new TransferController4({ ...h.controller, store: h.make() });
  const result = await Promise.allSettled([h.invite("a", "b"), other.invite("c", { callId: "call-2", toDeviceId: "b", expectedVersion: 1, requestId: "second-0001" })]);
  assert14.equal(result.filter((row) => row.status === "fulfilled").length, 1);
  assert14.equal(result.find((row) => row.status === "rejected").reason.code, "TARGET_BUSY");
  assert14.ok(h.db.conflicts > 0);
});
test13("customer terminal state wins while readiness waits outside transaction", async () => {
  const h = harness4(), entered = deferred3(), wait = deferred3();
  await h.seed();
  const accepted = await h.accept(await h.invite());
  h.controller.verifyReadiness = async (data) => {
    entered.resolve();
    await wait.promise;
    return h.validProof(data);
  };
  const readiness = h.ready(accepted);
  await entered.promise;
  const other = new TransferController4({ ...h.controller, store: h.make() });
  await other.providerEnded("verified-terminate");
  wait.resolve();
  await rejectsCode(() => readiness, "CALL_ENDED");
  const terminal = await h.store.get(callStoreKey4("call-1"));
  assert14.equal(terminal.active, false);
  assert14.equal(terminal.owner.deviceId, "a");
  await rejectsCode(() => h.store.transaction(async (tx) => {
    const call = await tx.get(callStoreKey4("call-1"));
    call.active = true;
    call.status = "connected";
    delete call.terminal;
    call.version++;
    tx.set(callStoreKey4("call-1"), call);
  }), "TERMINAL_CALL_WINS");
});
test13("ending can become ended with confirmation, but cannot lose terminal confirmation", async () => {
  const h = harness4();
  await h.seed();
  const intent = await h.controller.endByOperator("a", { callId: "call-1", expectedVersion: 1 });
  assert14.equal(intent.status, "ending");
  await h.controller.drainOutbox("call-1", { limit: 1 });
  const ended = await h.store.get(callStoreKey4("call-1"));
  assert14.equal(ended.status, "ended");
  assert14.equal(ended.terminal.reason, "BUSINESS_INITIATED");
  await rejectsCode(() => h.store.transaction(async (tx) => {
    const row = await tx.get(callStoreKey4("call-1"));
    delete row.terminal.confirmedAt;
    row.version++;
    tx.set(callStoreKey4("call-1"), row);
  }), "TERMINAL_CALL_WINS");
});
test13("terminal reason cannot change and malformed confirmation timestamps are rejected", async () => {
  const h = harness4();
  await h.seed();
  await h.controller.endByOperator("a", { callId: "call-1", expectedVersion: 1 });
  await rejectsCode(() => h.store.transaction(async (tx) => {
    const call = await tx.get(callStoreKey4("call-1"));
    call.terminal.reason = "USER_INITIATED";
    call.version++;
    tx.set(callStoreKey4("call-1"), call);
  }), "TERMINAL_CALL_WINS");
  await rejectsCode(() => h.store.transaction(async (tx) => {
    const call = await tx.get(callStoreKey4("call-1"));
    call.terminal.confirmedAt = "now";
    call.version++;
    tx.set(callStoreKey4("call-1"), call);
  }), "INVALID_MEDIA_STORE_INPUT");
  await h.controller.providerEnded("verified-terminate");
  const ended = await h.store.get(callStoreKey4("call-1"));
  assert14.equal(ended.terminal.reason, "BUSINESS_INITIATED");
  assert14.equal(ended.outbox.find((job) => job.kind === "terminate").reason, "USER_INITIATED");
});
test13("cleanup targets and accepted transfer media generation cannot be retargeted", async () => {
  const h = harness4();
  await h.seed();
  const accepted = await h.accept(await h.invite());
  await rejectsCode(() => h.store.transaction(async (tx) => {
    const call = await tx.get(callStoreKey4("call-1"));
    call.transfer.targetIdentity = "other-room-participant";
    call.version++;
    tx.set(callStoreKey4("call-1"), call);
  }), "TRANSFER_GENERATION_WINS");
  await h.ready(accepted);
  for (const field of ["identity", "roomName", "deviceId"]) await rejectsCode(() => h.store.transaction(async (tx) => {
    const call = await tx.get(callStoreKey4("call-1"));
    call.outbox[0][field] = "other-target";
    tx.set(callStoreKey4("call-1"), call);
  }), "CLEANUP_TARGET_IMMUTABLE");
});
test13("stale semantic version, historical request rewrite and completed-job resurrection fail", async () => {
  const h = harness4();
  await h.seed();
  const accepted = await h.accept(await h.invite());
  await h.ready(accepted);
  await h.controller.drainOutbox("call-1");
  await rejectsCode(() => h.store.transaction(async (tx) => {
    const call = await tx.get(callStoreKey4("call-1"));
    call.version--;
    tx.set(callStoreKey4("call-1"), call);
  }), "STALE_CALL_VERSION");
  await rejectsCode(() => h.store.transaction(async (tx) => {
    const call = await tx.get(callStoreKey4("call-1"));
    call.requests = {};
    call.version++;
    tx.set(callStoreKey4("call-1"), call);
  }), "CALL_IDEMPOTENCY_IMMUTABLE");
  await rejectsCode(() => h.store.transaction(async (tx) => {
    const call = await tx.get(callStoreKey4("call-1"));
    call.outbox[0].status = "pending";
    tx.set(callStoreKey4("call-1"), call);
  }), "CLEANUP_GENERATION_WINS");
});
test13("failed commit leaves call, reservations and projections all unchanged", async () => {
  const h = harness4();
  await h.seed();
  const before = h.db.dump();
  h.db.failBeforeCommit = Object.assign(Error("private credential SDK text"), { status: 401 });
  await assert14.rejects(() => h.invite(), (error) => error instanceof MediaStoreError && error.statusCode === 503 && !error.message.includes("credential"));
  assert14.deepEqual(h.db.dump(), before);
});
test13("lost commit acknowledgement replays invitation result without a new transfer", async () => {
  const h = harness4();
  await h.seed();
  const original = h.db.runTransaction.bind(h.db);
  let lose = true;
  h.db.runTransaction = async (callback) => {
    const previous = h.db.commits;
    const result = await original(callback);
    if (lose && h.db.commits > previous) {
      lose = false;
      throw Error("lost acknowledgement");
    }
    return result;
  };
  await rejectsCode(() => h.invite(), "MEDIA_STORE_UNAVAILABLE");
  const stored = await h.store.get(callStoreKey4("call-1"));
  const replay = await h.invite();
  assert14.equal(replay.transfer.id, stored.transfer.id);
  assert14.equal(replay.replayed, true);
  assert14.equal(rows(h, "transfers").length, 1);
  assert14.deepEqual(h.effects, []);
});
test13("due discovery is a bounded indexed query and competing workers get exclusive leases", async () => {
  const h = harness4();
  await h.seed();
  await h.invite();
  h.advance(60001);
  const [first, second] = await Promise.all([h.store.claimDueWork({ workerId: "worker-a", limit: 1 }), h.make().claimDueWork({ workerId: "worker-b", limit: 1 })]);
  assert14.equal(first.length + second.length, 1);
  assert14.equal(h.db.queries.length, 2);
  for (const query of h.db.queries) {
    assert14.equal(query.limit, 1);
    assert14.equal(query.filters[0][0], "availableAtMs");
  }
  const claim = [...first, ...second][0];
  assert14.equal(claim.workType, "expire");
  assert14.equal(claim.claimGeneration, 1);
  assert14.equal((await h.store.claimDueWork({ workerId: "worker-c", limit: 32 })).length, 0);
});
test13("crashed worker lease is recoverable; old acknowledgement cannot release newer generation", async () => {
  const h = harness4();
  await h.seed();
  await h.invite();
  h.advance(60001);
  const [first] = await h.store.claimDueWork({ workerId: "worker-a" });
  h.advance(60001);
  assert14.equal((await h.store.renewWorkLease(first)).renewed, false);
  const [second] = await h.make().claimDueWork({ workerId: "worker-b" });
  assert14.equal(second.claimGeneration, 2);
  assert14.notEqual(first.claimId, second.claimId);
  assert14.equal((await h.store.releaseWork(first)).released, false);
  assert14.equal((await h.store.releaseWork(second)).released, true);
});
test13("call changes preserve scanner lease while canonical outbox lease runs independently", async () => {
  const h = harness4();
  await h.seed();
  const accepted = await h.accept(await h.invite());
  await h.ready(accepted);
  const [claim] = await h.store.claimDueWork({ workerId: "worker-a" });
  const entered = deferred3(), wait = deferred3();
  h.provider.detachOperator = async () => {
    entered.resolve();
    await wait.promise;
  };
  const execution = h.controller.drainOutbox("call-1", { limit: 1 });
  await entered.promise;
  const projection = rows(h, "jobs").find((row) => row.workType === "cleanup");
  assert14.equal(projection.claimId, claim.claimId);
  assert14.equal(projection.claimUntilMs, NOW4 + 6e4);
  assert14.equal(projection.data.status, "running");
  assert14.equal(projection.data.leaseUntil, NOW4 + 45e3);
  assert14.equal((await h.make().claimDueWork({ workerId: "worker-b" })).length, 0);
  wait.resolve();
  await execution;
  assert14.equal((await h.store.releaseWork(claim)).released, true);
  assert14.equal(rows(h, "jobs").find((row) => row.workType === "cleanup").sourceDueAtMs, Number.MAX_SAFE_INTEGER);
});
test13("restart recovery expires unanswered invitation and releases only the target reservation", async () => {
  const h = harness4();
  await h.seed();
  await h.invite();
  h.advance(60001);
  const restarted = new TransferController4({ ...h.controller, store: h.make(), rolloutGuard: /* @__PURE__ */ __name(async () => false, "rolloutGuard") });
  const result = await recoverMediaWork({ store: h.make(), controller: restarted, workerId: "restart-worker" });
  assert14.equal(result[0].processed, true);
  const call = await h.store.get(callStoreKey4("call-1"));
  assert14.equal(call.transfer.status, "expired");
  assert14.equal(call.owner.deviceId, "a");
  assert14.equal(await h.store.get(deviceReservationKey4("b")), void 0);
  assert14.equal((await h.store.get(deviceReservationKey4("a"))).kind, "owner");
});
test13("terminal calls remain discoverable and cleanup proceeds even with rollout off", async () => {
  const h = harness4();
  await h.seed();
  await h.controller.endByOperator("a", { callId: "call-1", expectedVersion: 1 });
  h.controller.rolloutGuard = async () => false;
  await recoverMediaWork({ store: h.store, controller: h.controller, workerId: "worker", drainLimit: 1 });
  await recoverMediaWork({ store: h.store, controller: h.controller, workerId: "worker", drainLimit: 1 });
  const call = await h.store.get(callStoreKey4("call-1"));
  assert14.equal(call.status, "ended");
  assert14.equal(call.active, false);
  assert14.ok(call.outbox.every((job) => job.status === "done"));
  assert14.equal(await h.store.get(deviceReservationKey4("a")), void 0);
  assert14.equal(h.effects.filter((effect) => effect.kind === "terminate").length, 1);
});
test13("failed cleanup remains reserved and is retried after backoff on another worker", async () => {
  const h = harness4();
  await h.seed();
  const accepted = await h.accept(await h.invite());
  await h.ready(accepted);
  h.provider.detachOperator = async () => {
    throw Error("temporary");
  };
  await recoverMediaWork({ store: h.store, controller: h.controller, workerId: "worker-a" });
  assert14.equal((await h.store.get(deviceReservationKey4("a"))).kind, "cleanup");
  assert14.equal((await h.store.claimDueWork({ workerId: "too-soon" })).length, 0);
  h.advance(3e3);
  h.provider.detachOperator = async (data) => h.effects.push(data);
  await recoverMediaWork({ store: h.make(), controller: new TransferController4({ ...h.controller, store: h.make() }), workerId: "worker-b" });
  assert14.equal((await h.store.get(callStoreKey4("call-1"))).transfer.status, "completed");
  assert14.equal(await h.store.get(deviceReservationKey4("a")), void 0);
});
test13("history adapters cannot delete registered devices or use unbounded recovery limits", async () => {
  const h = harness4();
  await rejectsCode(() => h.store.transaction(async (tx) => tx.delete("sh_operator_devices/phone")), "INVALID_MEDIA_STORE_INPUT");
  await rejectsCode(() => h.store.claimDueWork({ workerId: "worker", limit: 5e3 }), "INVALID_MEDIA_STORE_INPUT");
  await rejectsCode(() => h.store.claimDueWork({ workerId: "worker", limit: 0 }), "INVALID_MEDIA_STORE_INPUT");
});
test13("malformed envelope and SDK authentication failure remain unavailable, never empty state", async () => {
  const h = harness4();
  await h.seed();
  h.db.failReads = Object.assign(Error("SDK private error"), { status: 401 });
  await rejectsCode(() => h.store.get(callStoreKey4("call-1")), "MEDIA_STORE_UNAVAILABLE");
  h.db.failReads = null;
  const key2 = callStoreKey4("call-1").split("/")[1];
  h.db.seed("sh_operator_media_calls", key2, { schema: 9 });
  await rejectsCode(() => h.store.get(callStoreKey4("call-1")), "MEDIA_STORE_UNAVAILABLE");
});
function session(id = "out_request-0001") {
  const call = newBridgedCall2({
    callId: id,
    roomName: "stable-room-1",
    customerIdentity: "customer-leg-1",
    tenantId: "smart",
    owner: { deviceId: "a", userId: "user-a", legId: "initial-session-leg" },
    now: NOW4
  });
  return {
    id,
    tenantId: "smart",
    provider: "livekit-whatsapp",
    direction: "outgoing",
    phase: "dialing",
    version: 1,
    owner: call.owner,
    phoneNumberId: "123456789",
    roomName: call.roomName,
    customerIdentity: call.customerIdentity,
    offerSdp: "PRIVATE SYNTHETIC SDP",
    operations: {},
    outbox: [],
    nextActionAtMs: NOW4 + 45e3,
    createdAt: NOW4,
    updatedAt: NOW4
  };
}
__name(session, "session");
async function seedSession(h, value = session()) {
  await h.store.transaction(async (tx) => {
    assert14.equal(await tx.get(sessionStoreKey(value.id)), void 0);
    assert14.equal(await tx.get(deviceReservationKey4("a")), void 0);
    tx.create(sessionStoreKey(value.id), value);
    tx.create(deviceReservationKey4("a"), { callId: value.id, sessionId: value.id, deviceId: "a", kind: "pending" });
  });
  return value;
}
__name(seedSession, "seedSession");
test13("pre-media sessions and pending reservations persist private SDP without exposing it in job discovery", async () => {
  const h = harness4(), value = await seedSession(h);
  assert14.equal((await h.make().get(sessionStoreKey(value.id))).offerSdp, value.offerSdp);
  assert14.equal((await h.store.get(deviceReservationKey4("a"))).kind, "pending");
  h.advance(45001);
  const claims2 = await h.store.claimDueWork({ workerId: "recovery" });
  assert14.equal(claims2[0].workType, "session");
  assert14.equal(claims2[0].sessionId, value.id);
  assert14.ok(!JSON.stringify(claims2).includes("SDP"));
  assert14.ok(!JSON.stringify(rows(h, "jobs")).includes("SDP"));
});
test13("event marker and session state update are atomic and duplicate events cannot overwrite state", async () => {
  const h = harness4(), value = await seedSession(h), key2 = eventStoreKey("evt:provider-connect-1");
  const process = /* @__PURE__ */ __name((store) => store.transaction(async (tx) => {
    const previous = await tx.get(key2);
    const current = await tx.get(sessionStoreKey(value.id));
    if (previous) return { replayed: true };
    current.providerCallId = "provider-call-1";
    current.phase = "connecting";
    current.version++;
    tx.set(sessionStoreKey(value.id), current);
    tx.create(key2, { id: "evt:provider-connect-1", sessionId: value.id, createdAt: NOW4 });
    return { replayed: false };
  }), "process");
  const results = await Promise.all([process(h.store), process(h.make())]);
  assert14.deepEqual(results.map((row) => row.replayed).sort(), [false, true]);
  assert14.equal((await h.store.get(sessionStoreKey(value.id))).version, 2);
  await rejectsCode(() => h.store.transaction(async (tx) => {
    const row = await tx.get(key2);
    row.sessionId = "other";
    tx.set(key2, row);
  }), "EVENT_ALREADY_PROCESSED");
  await rejectsCode(() => h.store.transaction(async (tx) => tx.delete(key2)), "CALL_DELETE_FORBIDDEN");
});
test13("outgoing call ID binds before readiness, then pending owner promotes atomically to the actual call", async () => {
  const h = harness4(), value = await seedSession(h);
  await h.store.transaction(async (tx) => {
    const row = await tx.get(sessionStoreKey(value.id));
    row.providerCallId = "provider-call-1";
    row.phase = "connecting";
    row.version++;
    tx.set(sessionStoreKey(value.id), row);
  });
  const target = newBridgedCall2({
    callId: "provider-call-1",
    roomName: value.roomName,
    customerIdentity: value.customerIdentity,
    tenantId: value.tenantId,
    owner: value.owner,
    now: NOW4
  });
  await h.store.transaction(async (tx) => {
    const row = await tx.get(sessionStoreKey(value.id));
    await tx.get(deviceReservationKey4("a"));
    await tx.get(callStoreKey4("provider-call-1"));
    row.phase = "connected";
    row.version++;
    row.nextActionAtMs = null;
    tx.set(sessionStoreKey(value.id), row);
    tx.create(callStoreKey4("provider-call-1"), target);
    tx.set(deviceReservationKey4("a"), { callId: "provider-call-1", kind: "owner" });
  });
  assert14.equal((await h.store.get(deviceReservationKey4("a"))).callId, "provider-call-1");
  assert14.equal((await h.store.get(callStoreKey4("provider-call-1"))).active, true);
  await rejectsCode(() => h.store.transaction(async (tx) => {
    const row = await tx.get(sessionStoreKey(value.id));
    row.providerCallId = "another-provider-call";
    row.version++;
    tx.set(sessionStoreKey(value.id), row);
  }), "SESSION_IDENTITY_IMMUTABLE");
});
test13("unsafe pending-to-owner promotion is rejected before connected media state", async () => {
  const h = harness4(), value = await seedSession(h);
  await rejectsCode(() => h.store.transaction(async (tx) => {
    await tx.get(deviceReservationKey4("a"));
    tx.set(deviceReservationKey4("a"), { callId: "provider-call-1", kind: "owner" });
  }), "DEVICE_RESERVATION_CONFLICT");
  assert14.equal((await h.store.get(deviceReservationKey4("a"))).kind, "pending");
});
test13("terminal-before-dial-result remains terminal while later provider ID can be recorded for cleanup", async () => {
  const h = harness4(), value = await seedSession(h);
  await h.store.transaction(async (tx) => {
    const row2 = await tx.get(sessionStoreKey(value.id));
    row2.phase = "ending";
    row2.terminal = { reason: "BUSINESS_INITIATED", endedAt: NOW4 };
    row2.version++;
    tx.set(sessionStoreKey(value.id), row2);
  });
  await h.store.transaction(async (tx) => {
    const row2 = await tx.get(sessionStoreKey(value.id));
    await tx.get(deviceReservationKey4("a"));
    row2.providerCallId = "late-provider-call";
    row2.version++;
    tx.set(sessionStoreKey(value.id), row2);
    tx.set(deviceReservationKey4("a"), { callId: "late-provider-call", sessionId: value.id, deviceId: "a", kind: "cleanup", identity: value.owner.identity });
  });
  const row = await h.store.get(sessionStoreKey(value.id));
  assert14.equal(row.phase, "ending");
  assert14.equal(row.terminal.endedAt, NOW4);
  await rejectsCode(() => h.store.transaction(async (tx) => {
    const current = await tx.get(sessionStoreKey(value.id));
    delete current.terminal;
    current.phase = "connected";
    current.version++;
    tx.set(sessionStoreKey(value.id), current);
  }), "TERMINAL_SESSION_WINS");
  assert14.equal((await h.store.get(deviceReservationKey4("a"))).kind, "cleanup");
});
test13("restart session recovery receives only exact session ID and cannot free a timed-out pending reservation automatically", async () => {
  const h = harness4(), value = await seedSession(h);
  h.advance(45001);
  const called = [];
  await recoverMediaWork({ store: h.make(), controller: h.controller, workerId: "restart", recoverSession: /* @__PURE__ */ __name(async (id, { claim }) => {
    called.push(id);
    assert14.equal(claim.sessionId, value.id);
    await h.store.transaction(async (tx) => {
      const row = await tx.get(sessionStoreKey(id));
      row.nextActionAtMs = null;
      tx.set(sessionStoreKey(id), row);
    });
  }, "recoverSession") });
  assert14.deepEqual(called, [value.id]);
  assert14.equal((await h.store.get(deviceReservationKey4("a"))).kind, "pending");
  assert14.equal((await h.store.claimDueWork({ workerId: "again" })).length, 0);
});
test13("issued session operation identity and original execution deadline cannot be replaced or replayed", async () => {
  const h = harness4(), value = session();
  value.operations.dial = { id: "request-0001", status: "issued", issuedAt: NOW4, leaseUntil: NOW4 + 45e3 };
  await seedSession(h, value);
  for (const field of ["id", "issuedAt", "leaseUntil"]) await rejectsCode(() => h.store.transaction(async (tx) => {
    const row = await tx.get(sessionStoreKey(value.id));
    row.operations.dial[field] = field === "id" ? "replacement-request" : NOW4 + 9e4;
    tx.set(sessionStoreKey(value.id), row);
  }), "SESSION_OPERATION_IMMUTABLE");
  await h.store.transaction(async (tx) => {
    const row = await tx.get(sessionStoreKey(value.id));
    row.operations.dial.status = "uncertain";
    tx.set(sessionStoreKey(value.id), row);
  });
  await rejectsCode(() => h.store.transaction(async (tx) => {
    const row = await tx.get(sessionStoreKey(value.id));
    row.operations.dial.status = "issued";
    tx.set(sessionStoreKey(value.id), row);
  }), "SESSION_OPERATION_GENERATION_WINS");
  await h.store.transaction(async (tx) => {
    const row = await tx.get(sessionStoreKey(value.id));
    row.operations.dial.status = "acknowledged";
    tx.set(sessionStoreKey(value.id), row);
  });
  await rejectsCode(() => h.store.transaction(async (tx) => {
    const row = await tx.get(sessionStoreKey(value.id));
    row.operations.dial.status = "uncertain";
    tx.set(sessionStoreKey(value.id), row);
  }), "SESSION_OPERATION_GENERATION_WINS");
  await rejectsCode(() => h.store.transaction(async (tx) => {
    const row = await tx.get(sessionStoreKey(value.id));
    delete row.operations.dial;
    tx.set(sessionStoreKey(value.id), row);
  }), "SESSION_OPERATION_IMMUTABLE");
});
test13("session job targets, completion and attempts remain durable across delayed writes", async () => {
  const h = harness4(), value = session();
  value.outbox = [{
    id: "notify-transfer-1",
    kind: "notify",
    event: "transfer-incoming",
    transferId: "transfer-1",
    toDeviceId: "b",
    status: "pending",
    attempts: 0,
    notBefore: 0
  }];
  await seedSession(h, value);
  for (const field of ["kind", "event", "transferId", "toDeviceId"]) await rejectsCode(() => h.store.transaction(async (tx) => {
    const row = await tx.get(sessionStoreKey(value.id));
    row.outbox[0][field] = field === "kind" ? "connect" : "different";
    tx.set(sessionStoreKey(value.id), row);
  }), "CLEANUP_TARGET_IMMUTABLE");
  await h.store.transaction(async (tx) => {
    const row = await tx.get(sessionStoreKey(value.id));
    Object.assign(row.outbox[0], { status: "running", attempts: 1, leaseId: "first-claim", leaseUntil: NOW4 + 45e3 });
    tx.set(sessionStoreKey(value.id), row);
  });
  await h.store.transaction(async (tx) => {
    const row = await tx.get(sessionStoreKey(value.id));
    row.outbox[0].status = "done";
    delete row.outbox[0].leaseId;
    delete row.outbox[0].leaseUntil;
    tx.set(sessionStoreKey(value.id), row);
  });
  for (const mutate of [(row) => {
    row.outbox = [];
  }, (row) => {
    row.outbox[0].status = "pending";
  }, (row) => {
    row.outbox[0].attempts = 0;
  }]) {
    await rejectsCode(() => h.store.transaction(async (tx) => {
      const row = await tx.get(sessionStoreKey(value.id));
      mutate(row);
      tx.set(sessionStoreKey(value.id), row);
    }), "CLEANUP_GENERATION_WINS");
  }
});
test13("malformed session execution state is rejected and terminal confirmation cannot be removed", async () => {
  const h = harness4(), value = session();
  value.phase = "ended";
  value.terminal = { reason: "FAILED", endedAt: 0, confirmedAt: 0 };
  await seedSession(h, value);
  await rejectsCode(() => h.store.transaction(async (tx) => {
    const row = await tx.get(sessionStoreKey(value.id));
    delete row.terminal.confirmedAt;
    row.version++;
    tx.set(sessionStoreKey(value.id), row);
  }), "TERMINAL_SESSION_WINS");
  await rejectsCode(() => h.store.transaction(async (tx) => {
    const row = await tx.get(sessionStoreKey(value.id));
    row.outbox.push({ id: "bad", kind: "detach", status: "running", attempts: 1, notBefore: 0 });
    tx.set(sessionStoreKey(value.id), row);
  }), "INVALID_MEDIA_STORE_INPUT");
});
test13("legacy route claims are immutable and never permit native customer-media effects", async () => {
  const h = harness4(), value = session("incoming-legacy");
  Object.assign(value, {
    direction: "incoming",
    owner: null,
    phase: "answered_elsewhere",
    routeChoice: "legacy",
    legacyClaim: { operationId: "browser-operation-1", claimedAt: NOW4 },
    terminal: { reason: "LEGACY_CLAIMED", endedAt: NOW4, nativeOnly: true }
  });
  await h.store.transaction(async (tx) => tx.create(sessionStoreKey(value.id), value));
  await rejectsCode(() => h.store.transaction(async (tx) => {
    const row = await tx.get(sessionStoreKey(value.id));
    row.legacyClaim.operationId = "replacement";
    row.version++;
    tx.set(sessionStoreKey(value.id), row);
  }), "SESSION_ROUTE_IMMUTABLE");
  for (const kind of ["connect", "reject", "terminate", "detach"]) await rejectsCode(() => h.store.transaction(async (tx) => {
    const row = await tx.get(sessionStoreKey(value.id));
    row.outbox.push({ id: `bad-${kind}`, kind, status: "pending", attempts: 0, notBefore: 0 });
    tx.set(sessionStoreKey(value.id), row);
  }), "INVALID_MEDIA_STORE_INPUT");
  await h.store.transaction(async (tx) => {
    const row = await tx.get(sessionStoreKey(value.id));
    row.phase = "ended";
    row.terminal.confirmedAt = NOW4 + 1e3;
    row.version++;
    row.outbox.push({ id: "native-notification-close", kind: "notify", event: "ended", status: "pending", attempts: 0, notBefore: 0 });
    tx.set(sessionStoreKey(value.id), row);
  });
  assert14.equal((await h.store.get(sessionStoreKey(value.id))).terminal.reason, "LEGACY_CLAIMED");
});
test13("provider customer acceptance timestamp is valid, versioned and immutable once assigned", async () => {
  const h = harness4(), value = await seedSession(h);
  await rejectsCode(() => h.store.transaction(async (tx) => {
    const row = await tx.get(sessionStoreKey(value.id));
    row.customerAcceptedAt = "untrusted";
    row.version++;
    tx.set(sessionStoreKey(value.id), row);
  }), "INVALID_MEDIA_STORE_INPUT");
  await rejectsCode(() => h.store.transaction(async (tx) => {
    const row = await tx.get(sessionStoreKey(value.id));
    row.customerAcceptedAt = NOW4;
    tx.set(sessionStoreKey(value.id), row);
  }), "STALE_SESSION_VERSION");
  await h.store.transaction(async (tx) => {
    const row = await tx.get(sessionStoreKey(value.id));
    row.customerAcceptedAt = NOW4;
    row.version++;
    tx.set(sessionStoreKey(value.id), row);
  });
  for (const changed of [null, NOW4 + 1]) await rejectsCode(() => h.store.transaction(async (tx) => {
    const row = await tx.get(sessionStoreKey(value.id));
    row.customerAcceptedAt = changed;
    row.version++;
    tx.set(sessionStoreKey(value.id), row);
  }), "SESSION_IDENTITY_IMMUTABLE");
});
