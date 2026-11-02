// Shared server-side unread projections. This is never an authentication cache:
// every HTTP request still validates its enrolled credential before reading here.
export function createAppMessageSubscriptions({ collection, project, clock, makeError,
  maxEntries = 1000, idleMs = 15 * 60000, initialTimeoutMs = 8000, retryMs = 30000,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  for (const [value, maximum] of [[maxEntries, 1000], [idleMs, 15 * 60000], [initialTimeoutMs, 30000], [retryMs, 300000]])
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw TypeError('Invalid unread subscription bounds.');
  const supported = typeof collection.doc('1').onSnapshot === 'function';
  const entries = new Map(), failures = new Map();
  let closed = false, sweepTimer = null, sweepAt = 0;
  const unavailable = () => makeError(503, 'APP_MESSAGE_STATE_UNAVAILABLE');
  const current = entry => !closed && entries.get(entry.id) === entry;
  const cancel = handle => { if (handle) clearTimeoutImpl(handle); };
  const timer = (callback, delay) => { const handle = setTimeoutImpl(callback, delay); handle.unref?.(); return handle; };
  const detach = entry => {
    cancel(entry.initialTimer); entry.initialTimer = null;
    try { entry.off?.(); } catch { /* Detaching a failed SDK listener is best effort. */ }
    entry.off = null;
    if (!entry.settled) { entry.settled = true; entry.reject(unavailable()); }
  };
  function scheduleSweep() {
    if (closed || !entries.size) { cancel(sweepTimer); sweepTimer = null; sweepAt = 0; return; }
    const earliest = Math.min(...[...entries.values()].map(entry => entry.usedAt + idleMs));
    if (sweepTimer && sweepAt <= earliest) return;
    cancel(sweepTimer); sweepAt = earliest;
    sweepTimer = timer(() => {
      sweepTimer = null; sweepAt = 0;
      const now = clock();
      for (const entry of entries.values()) if (now < entry.usedAt || now - entry.usedAt >= idleMs) {
        entries.delete(entry.id); detach(entry);
      }
      for (const [id, until] of failures) if (until <= now) failures.delete(id);
      scheduleSweep();
    }, Math.max(1, earliest - clock()));
  }
  function fail(entry) {
    if (!current(entry)) return;
    entries.delete(entry.id); failures.delete(entry.id); failures.set(entry.id, clock() + retryMs);
    while (failures.size > maxEntries) failures.delete(failures.keys().next().value);
    detach(entry); scheduleSweep();
  }
  function apply(entry, value) {
    if (!current(entry)) return;
    if (entry.value && value.stateVersion < entry.value.stateVersion) return;
    if (entry.value && value.stateVersion === entry.value.stateVersion &&
        Object.keys(value).some(key => entry.value[key] !== value[key])) { fail(entry); return; }
    entry.value = { ...value };
  }
  async function get(id) {
    if (closed) throw unavailable();
    const now = clock(), until = failures.get(id);
    if (until && until > now) throw unavailable();
    failures.delete(id);
    let entry = entries.get(id);
    if (entry && (now < entry.usedAt || now - entry.usedAt >= idleMs)) { entries.delete(id); detach(entry); entry = null; }
    if (!entry) {
      while (entries.size >= maxEntries) {
        let oldest;
        for (const candidate of entries.values()) if (!oldest || candidate.usedAt < oldest.usedAt) oldest = candidate;
        entries.delete(oldest.id); detach(oldest);
      }
      entry = { id, usedAt: now, value: null, settled: false, off: null, initialTimer: null };
      entry.ready = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
      // A synchronous SDK failure or eviction can reject before get awaits it.
      entry.ready.catch(() => {});
      entries.set(id, entry);
      entry.initialTimer = timer(() => fail(entry), initialTimeoutMs);
      try {
        const off = collection.doc(String(id)).onSnapshot(snapshot => {
          if (!current(entry)) return;
          // A confirmed deletion is not an older message-state version. Drop
          // the watch rather than indefinitely serving the deleted ledger.
          // An initial snapshot may predate a just-committed local write.
          if (!snapshot.exists && entry.settled && entry.value?.stateVersion > 0) { fail(entry); return; }
          try { apply(entry, project(snapshot, id)); }
          catch { fail(entry); return; }
          if (current(entry) && !entry.settled) {
            entry.settled = true; cancel(entry.initialTimer); entry.initialTimer = null; entry.resolve();
          }
        }, () => fail(entry));
        if (current(entry)) entry.off = off;
        else { try { off?.(); } catch { /* Listener may fail synchronously during registration. */ } }
      } catch { fail(entry); }
    }
    entry.usedAt = now; scheduleSweep();
    await entry.ready;
    if (!current(entry) || !entry.value) throw unavailable();
    return { ...entry.value };
  }
  // Publish only after a successful transaction commit. This closes the gap
  // before the SDK's ordered watch callback, without creating unwatched caches.
  function committed(value) {
    const entry = entries.get(value.channelId);
    if (entry) apply(entry, value);
  }
  function close() {
    if (closed) return;
    closed = true; cancel(sweepTimer); sweepTimer = null; sweepAt = 0;
    for (const entry of entries.values()) detach(entry);
    entries.clear(); failures.clear();
  }
  return { supported, get, committed, close };
}
