/* SH Chat native room entry points for the verified R8/R9 DOM.
 * No private Hub state, credentials, synthetic media, RPC, or inferred phone numbers.
 */
(() => {
  "use strict";
  if (window.top !== window || location.origin !== "https://www.smarthandicrafts.com" ||
      location.pathname !== "/livechat-api-test" || window.__shNativeRoomEntryR10) return;
  window.__shNativeRoomEntryR10 = true;
  function enabled() {
    return window.SHNativeCapabilities?.nativeRoomCalls === true &&
      window.SHNativeCapabilities.protocol === "sh-room-audio-v1" && typeof window.SHNative?.postMessage === "function";
  }
  function phone(value) {
    const text = String(value || "").trim();
    if (!/^\+?[1-9][\d ()-]*$/.test(text)) return "";
    const digits = text.replace(/\D/g, "");
    return /^[1-9]\d{6,14}$/.test(digits) ? digits : "";
  }
  function text(selector) { return document.querySelector(selector)?.textContent?.trim() || ""; }
  function selectedChannel() {
    const raw = document.querySelector("#shOperatorApp .sh-op-channel-item.is-selected[data-channel-id]")?.getAttribute("data-channel-id") || "";
    return /^\d+$/.test(raw) && Number(raw) <= 2147483647 ? Number(raw) : 0;
  }
  function validCall(value) { return typeof value === "string" && /^[A-Za-z0-9_:.@+=/-]{1,240}$/.test(value); }
  // Hub list keys are rendering identities (session:<provider ID>), not API IDs.
  // An event:<row ID> never identifies an answerable provider call.
  function renderedCallId(value) {
    if (typeof value !== "string" || value.startsWith("event:")) return "";
    const id = value.startsWith("session:") ? value.slice(8) : value;
    return validCall(id) ? id : "";
  }
  function controlCallId(control, attribute = "data-call-key") {
    const explicit = control?.getAttribute("data-provider-call-id");
    if (explicit !== null && explicit !== undefined) return validCall(explicit) ? explicit : "";
    return renderedCallId(control?.getAttribute(attribute));
  }
  function controlScope(control) {
    const clientAttemptId = control.getAttribute("data-native-attempt-id") || "";
    const ownerLegId = control.getAttribute("data-owner-leg-id") || "";
    if (!clientAttemptId) return {};
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientAttemptId) ||
        (ownerLegId && !validCall(ownerLegId))) return null;
    return { clientAttemptId, ...(ownerLegId ? { ownerLegId } : {}) };
  }
  function activeCall() { const id = window.SHNativeCapabilities?.activeCallId; return validCall(id) ? id : ""; }
  function currentCallAction() {
    const callId = activeCall();
    return callId ? { action: "open", callId } : window.SHNativeCapabilities?.activeCall === true ? { action: "current" } : null;
  }
  function send(event, detail) {
    event.preventDefault(); event.stopImmediatePropagation();
    window.SHNative.postMessage(JSON.stringify({ type: "native-call", ...detail }));
  }
  window.addEventListener("click", event => {
    if (!enabled() || !event.isTrusted) return;
    const element = event.target?.closest ? event.target : event.target?.parentElement;
    const control = element?.closest?.("button,[data-call-id]");
    if (!control || !control.closest("#shOperatorApp") || control.disabled) return;
    const id = control.id, action = control.getAttribute("data-whatsapp-call-action") ||
      ({ shWhatsappCallAcceptBtn: "accept", shWhatsappCallRejectBtn: "reject" })[id] || "";
    const keyed = controlCallId(control);
    const hasKey = control.hasAttribute("data-call-key") || control.hasAttribute("data-provider-call-id");
    const current = activeCall();
    const openCurrent = currentCallAction();
    if (id === "shWhatsappCallBtn" || control.getAttribute("data-drawer-action") === "call") {
      if (openCurrent) { send(event, openCurrent); return; }
      const drawer = control.closest("#shCustomerDrawer");
      const destination = drawer ? phone(drawer.querySelector(".sh-contact-profile > p")?.textContent) : phone(text("#shSelectedSubline"));
      const name = drawer ? drawer.querySelector(".sh-contact-profile > h2")?.textContent?.trim() : text("#shSelectedName");
      const channelId = destination && destination === phone(text("#shSelectedSubline")) ? selectedChannel() : 0;
      send(event, { action: destination ? "start" : "dial", phone: destination, channelId, displayName: String(name || "Customer").slice(0, 160) });
    } else if (action === "native-current") {
      send(event, openCurrent || { action: "unavailable" });
    } else if (id === "shWhatsappNewCallBtn" || action === "dial") {
      send(event, openCurrent || { action: "dial" });
    } else if (id === "shWhatsappCallStartBtn") {
      const destination = phone(document.getElementById("shWhatsappCallPhoneInput")?.value) || phone(text('#shWhatsappCallCurrent [data-render-key="phone"]'));
      send(event, openCurrent || { action: destination ? "start" : "dial", phone: destination, displayName: text('#shWhatsappCallCurrent [data-render-key="name"]').slice(0, 160) });
    } else if (control.hasAttribute("data-call-history-dial")) {
      if (openCurrent) { send(event, openCurrent); return; }
      const row = control.closest("[data-call-history-key]");
      const destination = phone(row?.getAttribute("data-call-history-phone"));
      if (destination) {
        send(event, { action: "start", phone: destination, displayName: String(row.getAttribute("data-call-history-name") || "Customer").slice(0, 160) });
        return;
      }
      const callId = controlCallId(row, "data-call-history-key");
      send(event, validCall(callId) ? { action: "callback", callId } : { action: "dial" });
    } else if ((action === "accept" || action === "reject" || action === "open") && validCall(keyed)) {
      send(event, { action, callId: keyed });
    } else if ((action === "accept" || action === "reject") && hasKey) {
      send(event, { action: "unavailable" });
    } else if (id === "shWhatsappCallAcceptBtn" || id === "shWhatsappCallRejectBtn") {
      // The old panel has no call ID. The native app must choose/verify an invitation.
      send(event, { action: "incoming" });
    } else if ((id === "shWhatsappCallTransferBtn" || action === "transfer") && current) {
      const panelKey = hasKey ? keyed : document.getElementById("shWhatsappCallCurrent")?.getAttribute("data-call-id") || "";
      const providerId = window.SHNativeCapabilities?.activeProviderCallId;
      const scope = controlScope(control);
      if (window.SHNativeCapabilities?.canTransfer === true &&
          scope?.clientAttemptId && scope.clientAttemptId === window.SHNativeCapabilities.activeAttemptId &&
          (panelKey === current || (validCall(providerId) && panelKey === providerId))) {
        send(event, { action: "transfer", callId: current, ...scope });
      }
    } else if (id === "shWhatsappCallEndBtn" || action === "end") {
      // A stale keyed End must never target a newer native call.
      const target = hasKey ? keyed : current;
      const scope = controlScope(control);
      send(event, validCall(target) && scope ? { action: "end", callId: target, ...scope } : { action: "unavailable" });
    }
  }, true);
  window.addEventListener("sh-native-call-closed", event => {
    const detail = event.detail;
    if (detail?.localReleased !== true) return;
    const ids = [detail.callId, detail.providerCallId].filter(validCall);
    if (!ids.length) return;
    const capability = window.SHNativeCapabilities;
    if (capability?.activeCall === true && [capability.activeCallId, capability.activeProviderCallId].some(id => ids.includes(id)) &&
        (!detail.clientAttemptId || detail.clientAttemptId !== capability.activeAttemptId ||
          (detail.ownerLegId && capability.activeOwnerLegId && detail.ownerLegId !== capability.activeOwnerLegId))) return;
    const app = document.getElementById("shOperatorApp"), panel = document.getElementById("shWhatsappCallPanel");
    const current = document.getElementById("shWhatsappCallCurrent");
    const key = current?.getAttribute("data-call-id") || panel?.getAttribute("data-call-id") ||
      controlCallId(document.getElementById("shWhatsappCallAcceptBtn")) || "";
    // Unkeyed old panels cannot safely be attributed to the ended call.
    if (ids.includes(key) && !panel?.classList.contains("is-hidden")) document.getElementById("shWhatsappCallClose")?.click();
    const banner = document.getElementById("shWhatsappIncomingBanner");
    const keys = Array.from(banner?.querySelectorAll("[data-call-key]") || []).map(node => controlCallId(node));
    if (keys.length && keys.every(value => ids.includes(value))) banner.classList.add("is-hidden");
  });
})();
