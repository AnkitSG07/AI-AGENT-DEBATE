(() => {
  if (window.__SH_OPERATOR_CALL_FIXES__) return;
  window.__SH_OPERATOR_CALL_FIXES__ = true;

  const CACHE_KEY = 'sh_operator_call_history_v3';
  const LIVE_MAX_AGE_MS = 110000;
  let fixedTimer = null;

  const terminalRe = /miss|declin|reject|failed|ended|terminate|timeout|no.answer|no_answer|unanswered/i;
  const liveRe = /connect|ring|offer|incoming/i;

  const $id = (id) => document.getElementById(id);
  const safeArr = (v) => Array.isArray(v) ? v : [];
  const clean = (v) => String(v || '').replace(/\D/g, '');

  function tsMs(c) {
    const raw = c?.timestamp || c?.time || c?.date || c?.received_at || c?.created_at || 0;
    if (typeof raw === 'number') return raw < 2000000000 ? raw * 1000 : raw;
    const n = Number(raw);
    if (Number.isFinite(n) && n) return n < 2000000000 ? n * 1000 : n;
    const d = Date.parse(raw);
    return Number.isFinite(d) ? d : 0;
  }

  function eventOf(c) {
    try { return String(window.eventText?.(c) || c?.event || c?.status || ''); }
    catch { return String(c?.event || c?.status || ''); }
  }

  function idOf(c) {
    try { return String(window.callIdOf?.(c) || ''); }
    catch { return String(c?.call_id || c?.callId || c?.id || ''); }
  }

  function phoneOf(c) {
    try { return clean(window.callPhone?.(c)); }
    catch { return clean(c?.customer_phone || c?.phone || c?.from || c?.wa_id || ''); }
  }

  function isTerminal(c) {
    const status = String(c?.status || '').toLowerCase();
    return terminalRe.test(eventOf(c)) || ['missed', 'declined', 'ended', 'failed'].includes(status);
  }

  function isStale(c) {
    const t = tsMs(c);
    return !!t && Date.now() - t > LIVE_MAX_AGE_MS;
  }

  function hasTerminalFor(id) {
    if (!id) return false;
    return safeArr(window.callsCache).some((c) => idOf(c) === id && isTerminal(c));
  }

  function liveOpenable(c) {
    const id = idOf(c);
    if (!id || isTerminal(c) || isStale(c) || hasTerminalFor(id)) return false;
    return !!(c?.has_sdp || c?.session?.sdp || c?.raw?.call?.session?.sdp || liveRe.test(eventOf(c)));
  }

  function mergeCalls(a, b) {
    const map = new Map();
    [...safeArr(a), ...safeArr(b)].forEach((c) => {
      const key = [idOf(c) || phoneOf(c) || Math.random(), eventOf(c), tsMs(c) || ''].join('|');
      map.set(key, c);
    });
    return [...map.values()].sort((x, y) => (tsMs(y) || 0) - (tsMs(x) || 0)).slice(0, 200);
  }

  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '[]'); }
    catch { return []; }
  }

  function writeCache(rows) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(safeArr(rows).slice(0, 200))); }
    catch {}
  }

  function stopFixedTimer(reset = false) {
    if (fixedTimer) clearInterval(fixedTimer);
    fixedTimer = null;
    try { window.startedAt = 0; } catch {}
    if (reset) {
      const t = $id('timer');
      if (t) t.textContent = '00:00';
    }
  }

  function setButtons(mode) {
    const accept = $id('acceptBtn');
    const reject = $id('rejectBtn');
    const end = $id('endBtn');
    const label = $id('acceptLabel');
    if (!accept || !reject || !end) return;
    if (mode === 'ended') {
      accept.style.display = 'none';
      reject.style.display = 'none';
      end.style.display = 'none';
      if (label) label.textContent = 'Ended';
      return;
    }
    if (mode === 'outgoing' || mode === 'connected') {
      accept.style.display = 'none';
      reject.style.display = 'none';
      end.style.display = 'grid';
      if (label) label.textContent = mode === 'connected' ? 'Connected' : 'Calling';
      return;
    }
    accept.style.display = 'grid';
    reject.style.display = 'grid';
    end.style.display = 'none';
    if (label) label.textContent = 'Accept';
  }

  function endCallUi(message = 'Call ended', error = '') {
    try { window.stopRingtone?.(); } catch {}
    stopFixedTimer(false);
    try { window.pc && window.pc.close(); } catch {}
    try { window.localStream && window.localStream.getTracks().forEach((t) => t.stop()); } catch {}
    setButtons('ended');
    try { window.setState?.(message); } catch {}
    try { window.showErr?.(error || ''); } catch {}
    setTimeout(() => { try { window.loadCalls?.(); } catch {} }, 600);
  }

  function patchWhenReady() {
    if (!window.renderCalls || !window.loadCalls || !window.cardHtml) {
      setTimeout(patchWhenReady, 250);
      return;
    }

    const originalStartTimer = window.startTimer;
    window.startTimer = function () {
      if (fixedTimer) return;
      if (!window.startedAt) window.startedAt = Date.now();
      fixedTimer = setInterval(() => {
        const s = Math.floor((Date.now() - window.startedAt) / 1000);
        const t = $id('timer');
        if (t) t.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
      }, 1000);
      try { originalStartTimer?.(); } catch {}
    };

    const oldLoadCalls = window.loadCalls;
    window.loadCalls = async function () {
      let odooRows = [];
      try {
        const r = await fetch('/api/odoo/call-log/recent?limit=120', { cache: 'no-store' });
        const j = await r.json();
        if (j.ok && Array.isArray(j.calls)) odooRows = j.calls;
      } catch {}
      if (odooRows.length) {
        window.callsCache = mergeCalls(readCache(), odooRows);
        writeCache(window.callsCache);
        window.renderCalls();
        return;
      }
      await oldLoadCalls().catch(() => {});
      window.callsCache = mergeCalls(readCache(), window.callsCache);
      writeCache(window.callsCache);
      window.renderCalls();
    };

    window.cardHtml = function (c) {
      const kind = window.callKind(c);
      const cid = window.esc(window.callIdOf(c));
      const name = window.esc(window.callName(c));
      const ph = window.esc(window.callPhone(c));
      const digits = clean(ph);
      const time = window.esc(window.shortTime(c.date || c.received_at || c.created_at || c.timestamp || c.time || ''));
      const ev = window.eventText(c);
      const open = liveOpenable(c) ? '<button class="client-open" data-call-id="' + cid + '" data-name="' + name + '" data-phone="' + ph + '">Open</button>' : '';
      const call = digits ? '<button class="client-call" data-out-phone="' + digits + '" data-out-name="' + name + '">' + (liveOpenable(c) ? 'Call' : 'Call Back') + '</button>' : '<button class="client-call" disabled>No No.</button>';
      return '<div class="client-card ' + kind + '"><div class="client-avatar">' + window.esc(window.callInitial(c)) + '</div><div class="client-name">' + name + '</div><div class="client-phone">' + (digits ? ('+' + digits) : 'No number') + '</div><div class="client-meta">' + window.esc(ev) + (time ? ' • ' + time : '') + '</div><div class="client-badge ' + kind + '">' + kind + '</div><div class="card-actions">' + call + open + '</div></div>';
    };

    window.openExistingCall = function (id, name, ph) {
      const rec = safeArr(window.callsCache).find((c) => idOf(c) === String(id || ''));
      if (!rec || !liveOpenable(rec)) {
        if (ph) return window.startOutgoingCall(ph, name);
        return;
      }
      window.callId = id || '';
      window.callerName = name || '';
      window.phone = clean(ph);
      window.callModeActive = false;
      setButtons('incoming');
      window.activateCallMode?.('Incoming WhatsApp Call');
      window.fetchCall?.().catch((e) => { window.setState?.('Load failed'); window.showErr?.(e.message || String(e)); });
    };

    const oldFetchCall = window.fetchCall;
    window.fetchCall = async function () {
      await oldFetchCall();
      if (window.currentCall && !liveOpenable(window.currentCall)) {
        endCallUi('Call already ended', 'This call is no longer active. Use Call Back to call the customer again.');
      }
    };

    const oldAcceptCall = window.acceptCall;
    window.acceptCall = async function () {
      if (!window.currentCall || !liveOpenable(window.currentCall)) {
        return endCallUi('Call already ended', 'This call is no longer active. Use Call Back to call the customer again.');
      }
      await oldAcceptCall();
    };

    const oldRejectCall = window.rejectCall;
    window.rejectCall = async function () {
      await oldRejectCall().catch(() => {});
      endCallUi('Call declined');
    };

    const oldEndCall = window.endCall;
    window.endCall = async function () {
      await oldEndCall().catch(() => {});
      endCallUi('Call ended');
    };

    const oldStartOutgoingCall = window.startOutgoingCall;
    window.startOutgoingCall = async function (to, name) {
      stopFixedTimer(true);
      setButtons('outgoing');
      await oldStartOutgoingCall(to, name);
    };

    const back = $id('backBtn');
    if (back) {
      back.onclick = () => {
        endCallUi('Call closed');
        window.callModeActive = false;
        window.outgoingMode = false;
        document.body.classList.remove('call-mode');
        setButtons('incoming');
        window.refresh?.();
        window.loadCalls?.();
        window.startIncomingCallWatcher?.();
      };
    }

    window.callsCache = mergeCalls(readCache(), window.callsCache);
    writeCache(window.callsCache);
    window.renderCalls();
    window.loadCalls();
  }

  patchWhenReady();
})();
