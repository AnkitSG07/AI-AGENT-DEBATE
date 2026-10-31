/* R12: sign in before changing a browser's push subscription. */
(function () {
  "use strict";
  if (window.top !== window || location.origin !== "https://ai-agent-debate.onrender.com" ||
      !/^\/operator-notifications(?:\.html)?\/?$/.test(location.pathname) || window.SHNotificationsAuth) return;
  const pushPaths = new Set(["/api/push/subscribe", "/api/push/unsubscribe", "/api/push/status", "/api/push/test", "/api/push/test-call"]);
  let expiresAt = 0, profile = "", sessionRequest = null;
  const form = document.createElement("form");
  form.id = "notificationOperatorLogin";
  form.className = "notification-operator-login";
  form.setAttribute("aria-labelledby", "notificationOperatorLoginTitle");
  form.innerHTML = '<h2 id="notificationOperatorLoginTitle">Connect notifications</h2>' +
    '<p>Sign in with your Render operator profile to save or test browser alerts. Open SH Chat for conversations and calls.</p>' +
    '<label for="notificationProfile">Operator profile</label><select id="notificationProfile" name="username" autocomplete="username"><option>Smart handicrafts</option><option>SUDO</option></select>' +
    '<label for="notificationPassword">Password</label><input id="notificationPassword" name="password" type="password" autocomplete="current-password" required>' +
    '<button type="submit">Sign in</button><p id="notificationLoginStatus" role="status" aria-live="polite"></p>';
  function render(message = "") {
    form.hidden = expiresAt > Date.now();
    form.querySelector("#notificationLoginStatus").textContent = message;
  }
  function denied() {
    expiresAt = 0; profile = ""; render("Sign in above, then try your notification action again.");
    const error = new Error("Sign in with your Render operator profile to continue.");
    error.status = 401; return error;
  }
  async function requireSession() {
    if (expiresAt > Date.now() + 1000) return { profile, expiresAt };
    if (sessionRequest) return sessionRequest;
    sessionRequest = (async () => {
      const response = await fetch("/api/profile-session", { credentials: "same-origin", cache: "no-store" });
      const body = await response.json().catch(() => ({})), expiry = Date.parse(body.expiresAt || "");
      if (!response.ok || body.ok !== true || !["Smart handicrafts", "SUDO"].includes(body.profile) || !Number.isFinite(expiry) || expiry <= Date.now()) throw denied();
      profile = body.profile; expiresAt = expiry; render(); return { profile, expiresAt };
    })();
    try { return await sessionRequest; } finally { sessionRequest = null; }
  }
  async function authorizedFetch(path, options = {}) {
    const url = new URL(path, location.origin), method = String(options.method || "GET").toUpperCase();
    if (url.origin !== location.origin || !pushPaths.has(url.pathname) || url.search || url.hash ||
        (url.pathname === "/api/push/status" ? method !== "GET" : method !== "POST"))
      throw new Error("Open SH Chat for call controls and device management.");
    await requireSession();
    const headers = new Headers(options.headers);
    if (method === "POST") headers.set("X-SH-Operator-Auth", "1");
    const response = await fetch(url.href, { ...options, method, headers, credentials: "same-origin", cache: "no-store", redirect: "error" });
    if (response.status === 401 || response.status === 403) throw denied();
    return response;
  }
  form.addEventListener("submit", async event => {
    event.preventDefault(); const button = form.querySelector("button"), password = form.querySelector("#notificationPassword");
    if (button.disabled) return;
    button.disabled = true; render("Signing in…");
    try {
      const response = await fetch("/api/profile-login", { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", "X-SH-Operator-Auth": "1" },
        body: JSON.stringify({ profile: form.querySelector("#notificationProfile").value, password: password.value }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok !== true) throw new Error(body.error || "Could not sign in. Try again.");
      expiresAt = 0; await requireSession();
      document.getElementById("enableBtn")?.focus();
      document.dispatchEvent(new CustomEvent("sh-notification-profile-connected"));
    } catch (error) { expiresAt = 0; render(error.message || "Could not sign in."); }
    finally { password.value = ""; button.disabled = false; }
  });
  Object.defineProperty(window, "SHNotificationsAuth", { value: Object.freeze({ requireSession, fetch: authorizedFetch }), configurable: false });
  const mount = () => {
    document.querySelector(".hub-setup-header")?.insertAdjacentElement("afterend", form);
    render(); requireSession().catch(error => render(error.status === 401 ? "" : "Sign-in is temporarily unavailable. Try again."));
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true }); else mount();
})();
