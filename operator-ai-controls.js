import { randomUUID } from 'node:crypto';

export const SH_CHAT_AI_FEATURES = Object.freeze(['drafts', 'productSuggestions', 'voiceFallback', 'autoReplies']);
const defaultFeatures = Object.freeze({ drafts: true, productSuggestions: true, voiceFallback: true, autoReplies: false });

export function validOperatorAiFeatures(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === SH_CHAT_AI_FEATURES.length &&
    SH_CHAT_AI_FEATURES.every(key => Object.hasOwn(value, key) && typeof value[key] === 'boolean');
}

export function createOperatorAiControls({ getStore, getAvailability, onChange, epoch = randomUUID(), clock = Date.now } = {}) {
  const stopped = { masterEnabled: false, features: defaultFeatures, legacyMode: 'manual', revision: 0 };
  let current = null;
  let loading = null;
  let changing = false;
  let retryAt = 0;
  const active = new Map(SH_CHAT_AI_FEATURES.map(feature => [feature, new Set()]));

  function availability() {
    const configured = getAvailability(current?.legacyMode);
    return Object.fromEntries(SH_CHAT_AI_FEATURES.map(feature => [feature, configured?.[feature] === true]));
  }
  function view() {
    const { masterEnabled, features, legacyMode, revision } = current || stopped;
    return { settingsReady: current !== null, masterEnabled, features: { ...features }, legacyMode, revision, epoch,
      availableFeatures: availability() };
  }
  function enabled(feature) {
    return current?.masterEnabled === true && current.features[feature] === true && getAvailability(current.legacyMode)?.[feature] === true;
  }
  function startRequest(feature) {
    if (!enabled(feature)) return null;
    const requests = active.get(feature);
    if (!requests) return null;
    const controller = new AbortController();
    requests.add(controller);
    return { signal: controller.signal, finish: () => requests.delete(controller) };
  }
  function apply(next) {
    current = next;
    onChange?.(view());
    for (const [feature, requests] of active) {
      if (enabled(feature)) continue;
      for (const controller of requests) controller.abort();
      requests.clear();
    }
  }
  function read(snapshot) {
    if (!snapshot.exists) return { ...stopped, masterEnabled: true };
    const row = snapshot.data();
    if (row?.schema !== 1 || typeof row.masterEnabled !== 'boolean' || !validOperatorAiFeatures(row.features) ||
        !['manual', 'zapier', 'chat', 'assist'].includes(row.legacyMode) || !Number.isSafeInteger(row.revision) || row.revision < 1) {
      throw new Error('Stored SH Chat AI settings are invalid.');
    }
    return { masterEnabled: row.masterEnabled, features: { ...row.features }, legacyMode: row.legacyMode, revision: row.revision };
  }
  async function ready() {
    if (current || changing || clock() < retryAt) return;
    if (!loading) {
      loading = Promise.resolve().then(async () => {
        const { ref } = getStore();
        apply(read(await ref.get()));
      }).catch(() => {
        retryAt = clock() + 5000;
      }).finally(() => { loading = null; });
    }
    await loading;
  }
  async function update({ masterEnabled, features, legacyMode, expectedEpoch, expectedRevision }) {
    await ready();
    if (!current) return 'unavailable';
    if (changing || expectedEpoch !== epoch || expectedRevision !== current.revision) return 'conflict';
    changing = true;
    try {
      const { db, ref } = getStore();
      const result = await db.runTransaction(async tx => {
        const stored = read(await tx.get(ref));
        if (stored.revision !== expectedRevision) return { status: 'conflict', state: stored };
        const state = { masterEnabled, features: { ...features }, legacyMode, revision: stored.revision + 1 };
        tx.set(ref, { schema: 1, ...state });
        return { status: 'saved', state };
      });
      apply(result.state);
      return result.status;
    } catch {
      // An ambiguous write cannot restore the previous permissions. Reload the
      // authoritative document before admitting new work.
      apply(null);
      retryAt = 0;
      return 'unavailable';
    } finally {
      changing = false;
      if (!current) void ready();
    }
  }

  return { view, enabled, startRequest, ready, update };
}
