/* R13: short scoped sessions for calling and private Hub integrations. */
(function () {
  "use strict";
  if (window.top !== window || location.origin !== "https://www.smarthandicrafts.com" ||
      location.pathname.replace(/\/+$/, "") !== "/livechat-api-test" || window.SHOperatorAuth) return;
  const backend = "https://ai-agent-debate.onrender.com", originalFetch = window.fetch.bind(window);
  let capability = null, reconnectCapability = null, refreshPromise = null, connection = null, refreshTimer = null;
  let cancelConnection = null, authGeneration = 0;
  const activeStreams = new Set();
  const callPrefix = "/api/whatsapp-calls/";
  const pushPaths = new Set(["/api/push/subscribe", "/api/push/unsubscribe", "/api/push/status", "/api/push/test", "/api/push/test-call"]);
  function protectedPath(path) {
    return path.startsWith(callPrefix) || path.startsWith("/api/operator-call-locks/") ||
      path.startsWith("/api/operator-call-transfer/") || path.startsWith("/api/odoo/call-log/") ||
      path === "/api/operator-devices" || path.startsWith("/api/operator-devices/") || pushPaths.has(path) ||
      ["/api/zoho-mail", "/api/google-contacts", "/api/odoo-documents", "/api/ai-mode"]
        .some(prefix => path === prefix || path.startsWith(prefix + "/"));
  }
  function valid() { return !!capability && capability.expiresAt > Date.now() + 1000; }
  function publish(type) { window.dispatchEvent(new CustomEvent(type, { detail: { connected: valid(), expiresAt: capability?.expiresAt || 0 } })); }
  function required() {
    publish("sh-operator-auth-required");
    const error = new Error("Connect operator services to use calls, mail, contacts, documents and SH AI.");
    error.status = 401; error.code = "OPERATOR_AUTH_REQUIRED"; return error;
  }
  function remember(value) {
    const now = Date.now();
    if (!value || typeof value.token !== "string" || value.token.length < 40 || value.token.length > 12000 ||
        !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + 660000 ||
        typeof value.operatorDeviceId !== "string" || !/^[A-Za-z0-9_:.-]{1,160}$/.test(value.operatorDeviceId))
      throw new Error("The call session response was invalid.");
    capability = { token: value.token, expiresAt: value.expiresAt,
      authExpiresAt: Number.isSafeInteger(value.authExpiresAt) ? value.authExpiresAt : value.expiresAt,
      operatorDeviceId: value.operatorDeviceId,
      baseDeviceId: String(value.baseDeviceId || value.operatorDeviceId.split("::")[0] || ""),
      operatorSessionId: String(value.operatorSessionId || value.operatorDeviceId.split("::")[1] || "") };
    reconnectCapability = capability;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh().catch(() => {}), Math.max(1000, capability.expiresAt - now - 120000));
    publish("sh-operator-auth-connected");
  }
  async function refresh() {
    if (refreshPromise) return refreshPromise;
    if (!valid()) throw required();
    const captured = capability, controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    refreshPromise = (async () => {
      try {
        const response = await originalFetch(backend + "/api/operator-browser-auth/refresh", {
          method: "POST", credentials: "omit", cache: "no-store", signal: controller.signal,
          headers: { Accept: "application/json", Authorization: "Bearer " + captured.token }
        });
        const body = await response.json();
        if (capability !== captured) return;
        if (response.ok && body.ok) remember(body);
        else if (response.status === 401 || response.status === 403) { capability = null; throw required(); }
        else throw new Error("Call session renewal is temporarily unavailable.");
      } catch (error) {
        if (capability === captured && valid()) {
          clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refresh().catch(() => {}), 15000);
        }
        throw error;
      } finally { clearTimeout(timeout); refreshPromise = null; }
    })();
    return refreshPromise;
  }
  function connect() {
    if (valid() && capability.expiresAt > Date.now() + 120000) return Promise.resolve();
    if (connection) return connection;
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const state = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    const generation = authGeneration;
    const popup = window.open(backend + "/operator-auth?origin=" + encodeURIComponent(location.origin) + "&state=" + state,
      "_blank", "popup=yes,width=430,height=640");
    if (!popup) return Promise.reject(new Error("Allow the operator sign-in window, then tap Connect operator services again."));
    connection = new Promise((resolve, reject) => {
      let settled = false;
      const done = error => {
        if (settled) return; settled = true;
        clearTimeout(timeout); clearInterval(closedCheck); window.removeEventListener("message", onMessage);
        try { popup.close(); } catch {}
        connection = null; cancelConnection = null; if (error) reject(error); else resolve();
      };
      const onMessage = event => {
        if (generation !== authGeneration || event.origin !== backend || event.source !== popup || event.data?.state !== state) return;
        if (event.data.type === "sh-operator-auth-ready") {
          const prior = capability || (reconnectCapability?.authExpiresAt > Date.now() ? reconnectCapability : null);
          popup.postMessage({ type: "sh-operator-auth-context", state, previousToken: prior?.token || "" }, backend); return;
        }
        if (event.data.type !== "sh-operator-browser-auth") return;
        try { remember(event.data); done(); } catch (error) { done(error); }
      };
      const timeout = setTimeout(() => done(new Error("Call sign-in timed out. Try again.")), 180000);
      const closedCheck = setInterval(() => { if (popup.closed) done(new Error("Call sign-in was closed.")); }, 500);
      cancelConnection = () => done(new Error("Call sign-in was cancelled."));
      window.addEventListener("message", onMessage);
    });
    return connection;
  }
  async function authenticatedFetch(input, options = {}) {
    let url;
    try { url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href); }
    catch { return originalFetch(input, options); }
    if (url.origin !== backend || !protectedPath(url.pathname)) return originalFetch(input, options);
    const method = String(options.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    // Native history goes through the fixed Java read bridge. Its credential is
    // never exposed here, and native call controls use their separate protocol.
    if (window.SHNativeHistory?.protocol === "sh-call-history-v1" && method === "GET" &&
        url.pathname.startsWith(callPrefix) && !url.pathname.endsWith("/events")) return originalFetch(input, options);
    if (!valid() && url.pathname === callPrefix + "config" && method === "GET") return originalFetch(input, options);
    if (!valid()) throw required();
    if (capability.expiresAt < Date.now() + 120000 && !options.keepalive) {
      const renewing = refresh();
      // A valid lease must not add a renewal round trip to Answer/Decline/End.
      if (capability.expiresAt < Date.now() + 15000) {
        try { await renewing; } catch (error) { if (!valid()) throw error; }
      } else renewing.catch(() => {});
    }
    if (!valid()) throw required();
    const used = capability;
    const headers = new Headers(options.headers || (input instanceof Request ? input.headers : undefined));
    headers.set("Authorization", "Bearer " + used.token);
    const response = await originalFetch(input, { ...options, credentials: "omit", headers });
    if (response.status === 401 && capability === used) {
      capability = null; clearTimeout(refreshTimer); publish("sh-operator-auth-required");
    }
    // A rejected POST is never replayed automatically: it may already have had
    // a provider side effect before the response was lost.
    return response;
  }
  function openCallEvents(value) {
    const url = new URL(value, backend);
    if (url.origin !== backend || url.pathname !== '/api/whatsapp-calls/events' || url.hash) throw new Error('Unsupported call event stream.');
    const events = new EventTarget(), controller = new AbortController();
    let closed = false, reader = null;
    const source = {
      onerror: null,
      addEventListener: (...args) => events.addEventListener(...args),
      close: () => { closed = true; activeStreams.delete(source); controller.abort(); reader?.cancel().catch(() => {}); }
    };
    activeStreams.add(source);
    queueMicrotask(async () => {
      try {
        const response = await authenticatedFetch(url.href, { cache:'no-store', signal:controller.signal, headers:{ Accept:'text/event-stream' } });
        if (!response.ok || !response.headers.get('Content-Type')?.toLowerCase().startsWith('text/event-stream') || !response.body)
          throw new Error('Call event stream is unavailable.');
        reader = response.body.getReader();
        const decoder = new TextDecoder(); let buffer = '', type = '', data = [];
        const line = value => {
          if (!value) {
            if ((type === 'ready' || type === 'call-status') && data.length)
              events.dispatchEvent(new MessageEvent(type, { data:data.join('\n') }));
            type = ''; data = []; return;
          }
          if (value.startsWith('event:')) type = value.slice(6).trim();
          else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
          if (data.join('\n').length > 8192) throw new Error('Call event was too large.');
        };
        while (!closed) {
          const part = await reader.read(); if (part.done) break;
          buffer += decoder.decode(part.value, { stream:true });
          if (buffer.length > 65536) throw new Error('Call event buffer was too large.');
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const value = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1); line(value);
          }
        }
        if (!closed) throw new Error('Call event stream closed.');
      } catch (error) {
        if (!closed && typeof source.onerror === 'function') source.onerror(error);
      } finally { activeStreams.delete(source); reader?.cancel().catch(() => {}); }
    });
    return source;
  }
  window.fetch = authenticatedFetch;
  window.SHOperatorAuth = Object.freeze({ connect, connected: valid, openCallEvents,
    identity: () => valid() ? { operatorDeviceId: capability.operatorDeviceId, baseDeviceId: capability.baseDeviceId,
      operatorSessionId: capability.operatorSessionId } : null,
    clear: () => {
      authGeneration++; capability = null; reconnectCapability = null;
      for (const source of Array.from(activeStreams)) source.close();
      cancelConnection?.(); clearTimeout(refreshTimer); publish("sh-operator-auth-required");
    }
  });
  window.addEventListener("pagehide", () => { clearTimeout(refreshTimer); for (const source of Array.from(activeStreams)) source.close(); });
})();
