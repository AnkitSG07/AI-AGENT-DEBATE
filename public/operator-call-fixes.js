(() => {
  if (window.__SH_OPERATOR_CALL_STABLE_V6__) return;
  window.__SH_OPERATOR_CALL_STABLE_V6__ = true;

  const CACHE_KEY = 'sh_operator_call_history_v4';
  const OLD_CACHE_KEYS = ['sh_operator_call_history_v2', 'sh_operator_call_history_v3'];
  let latestRows = [];
  let refreshTimer = null;
  let cleanupInProgress = false;

  const terminalRe = /miss|declin|reject|failed|ended|terminate|timeout|no.answer|no_answer|unanswered/i;

  const $ = (id) => document.getElementById(id);
  const clean = (v) => String(v || '').replace(/\D/g, '');
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function safeRows(v) { return Array.isArray(v) ? v : []; }

  function tsMs(c) {
    const raw = c?.timestamp || c?.time || c?.date || c?.received_at || c?.created_at || 0;
    if (typeof raw === 'number') return raw < 2000000000 ? raw * 1000 : raw;
    const n = Number(raw);
    if (Number.isFinite(n) && n) return n < 2000000000 ? n * 1000 : n;
    const d = Date.parse(raw);
    return Number.isFinite(d) ? d : 0;
  }

  function callId(c) { return String(c?.call_id || c?.callId || c?.id || ''); }
  function eventOf(c) { return String(c?.event || c?.status || c?.direction || 'WhatsApp call'); }
  function phoneOf(c) { return clean(c?.customer_phone || c?.customerPhone || c?.phone || c?.from || c?.wa_id || ''); }
  function nameOf(c) { return String(c?.customer_name || c?.customerName || c?.name || c?.from_name || c?.wa_name || phoneOf(c) || 'WhatsApp caller'); }
  function initialOf(c) { return (nameOf(c).trim()[0] || phoneOf(c)[0] || '?').toUpperCase(); }

  function kindOf(c) {
    const ev = eventOf(c).toLowerCase();
    const status = String(c?.status || '').toLowerCase();
    const direction = String(c?.direction || '').toLowerCase();
    if (terminalRe.test(ev) || ['missed', 'declined', 'failed'].includes(status)) return 'missed';
    if (direction === 'outgoing' || ev.includes('out')) return 'outgoing';
    return 'incoming';
  }

  function timeText(c) {
    const t = tsMs(c);
    if (!t) return '';
    try { return new Date(t).toLocaleString(); } catch { return ''; }
  }

  function mergeRows(a, b) {
    const map = new Map();
    [...safeRows(a), ...safeRows(b)].forEach((c) => {
      const key = [callId(c) || phoneOf(c) || Math.random(), eventOf(c), tsMs(c) || ''].join('|');
      map.set(key, c);
    });
    return [...map.values()].sort((x, y) => (tsMs(y) || 0) - (tsMs(x) || 0)).slice(0, 200);
  }

  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '[]'); } catch { return []; }
  }

  function writeCache(rows) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(safeRows(rows).slice(0, 200))); } catch {}
  }

  function clearAllCallCaches() {
    try { localStorage.removeItem(CACHE_KEY); } catch {}
    OLD_CACHE_KEYS.forEach((key) => { try { localStorage.removeItem(key); } catch {} });
  }

  function cardHtml(c) {
    const kind = kindOf(c);
    const name = esc(nameOf(c));
    const phone = phoneOf(c);
    const ev = esc(eventOf(c));
    const time = esc(timeText(c));
    const callText = kind === 'outgoing' ? 'Call Again' : 'Call Back';
    const call = phone ? '<button class="client-call" data-fix-call="' + phone + '" data-name="' + name + '">' + callText + '</button>' : '<button class="client-call" disabled>No No.</button>';
    return '<div class="client-card ' + kind + '"><div class="client-avatar">' + esc(initialOf(c)) + '</div><div class="client-name">' + name + '</div><div class="client-phone">' + (phone ? '+' + phone : 'No number') + '</div><div class="client-meta">' + ev + (time ? ' • ' + time : '') + '</div><div class="client-badge ' + kind + '">' + kind + '</div><div class="card-actions">' + call + '</div></div>';
  }

  function activeFilter() {
    const active = document.querySelector('.tab.active');
    return active?.dataset?.filter || 'all';
  }

  function renderFixedHistory() {
    const filter = activeFilter();
    const rows = filter === 'all' ? latestRows : latestRows.filter((r) => kindOf(r) === filter);
    const empty = '<div class="empty-card"><div class="empty-icon">SH</div><div><b>No ' + (filter === 'all' ? 'WhatsApp' : filter) + ' calls yet</b><span>Calls will appear after webhook/Odoo sync.</span></div></div>';
    const html = rows.length ? rows.map(cardHtml).join('') : empty;
    const home = $('homeCallList');
    const list = $('callList');
    const title = $('sectionTitle');
    if (home) home.innerHTML = html;
    if (list) list.innerHTML = latestRows.length ? latestRows.map(cardHtml).join('') : empty;
    if (title) title.textContent = filter === 'all' ? 'All calls' : filter[0].toUpperCase() + filter.slice(1);
  }

  async function loadFixedHistory() {
    let odooReached = false;
    let rows = [];
    try {
      const r = await fetch('/api/odoo/call-log/recent?limit=120', { cache: 'no-store' });
      const j = await r.json();
      if (j.ok && Array.isArray(j.calls)) {
        odooReached = true;
        rows = j.calls;
      }
    } catch {}

    if (odooReached) {
      latestRows = rows;
      if (rows.length) writeCache(rows);
      else clearAllCallCaches();
      renderFixedHistory();
      return;
    }

    try {
      const r = await fetch('/api/whatsapp-calls/recent?limit=120', { cache: 'no-store' });
      const j = await r.json();
      if (Array.isArray(j.calls)) rows = j.calls;
    } catch {}

    latestRows = mergeRows(readCache(), rows);
    writeCache(latestRows);
    renderFixedHistory();
  }

  function hideFooterControls() {
    const back = $('backBtn');
    const refresh = $('refreshBtn');
    const foot = document.querySelector('.foot');
    if (back) back.style.display = 'none';
    if (refresh) refresh.style.display = 'none';
    if (foot) foot.style.display = 'none';
  }

  function hideAcceptWhenNotAnswerable() {
    const err = $('errorBox');
    const state = $('callState');
    const accept = $('acceptBtn');
    const label = $('acceptLabel');
    const text = ((err?.textContent || '') + ' ' + (state?.textContent || '')).toLowerCase();
    if (accept && (text.includes('does not include webrtc sdp') || text.includes('call declined') || text.includes('already ended'))) {
      accept.style.display = 'none';
      if (label) label.textContent = text.includes('declined') || text.includes('ended') ? 'Ended' : 'Waiting';
    }
  }

  function hardResetCallUi() {
    if (cleanupInProgress) return;
    cleanupInProgress = true;

    try { window.stopRingtone?.(); } catch {}
    try { window.pc?.close?.(); } catch {}
    try { window.localStream?.getTracks?.().forEach((t) => t.stop()); } catch {}

    document.body.classList.remove('call-mode');
    document.body.style.pointerEvents = '';
    document.documentElement.style.pointerEvents = '';

    const timer = $('timer');
    if (timer) timer.textContent = '00:00';

    const err = $('errorBox');
    if (err) { err.textContent = ''; err.classList.remove('show'); }

    const accept = $('acceptBtn');
    const reject = $('rejectBtn');
    const end = $('endBtn');
    const label = $('acceptLabel');
    if (accept) accept.style.display = 'grid';
    if (reject) reject.style.display = 'grid';
    if (end) end.style.display = 'none';
    if (label) label.textContent = 'Accept';

    setTimeout(() => {
      cleanupInProgress = false;
      loadFixedHistory();
    }, 600);
  }

  function patchButtonsOnce() {
    hideFooterControls();
    hideAcceptWhenNotAnswerable();

    const reject = $('rejectBtn');
    if (reject && !reject.dataset.stableV6) {
      reject.dataset.stableV6 = '1';
      reject.addEventListener('click', () => setTimeout(hardResetCallUi, 550), true);
    }

    const end = $('endBtn');
    if (end && !end.dataset.stableV6) {
      end.dataset.stableV6 = '1';
      end.addEventListener('click', () => setTimeout(hardResetCallUi, 550), true);
    }

    const accept = $('acceptBtn');
    if (accept && !accept.dataset.stableV6) {
      accept.dataset.stableV6 = '1';
      accept.addEventListener('click', (e) => {
        const text = (($('errorBox')?.textContent || '') + ' ' + ($('callState')?.textContent || '')).toLowerCase();
        if (text.includes('does not include webrtc sdp') || text.includes('already ended') || text.includes('declined')) {
          e.preventDefault();
          e.stopImmediatePropagation();
          hideAcceptWhenNotAnswerable();
        }
      }, true);
    }
  }

  function bindStaticButtons() {
    document.querySelectorAll('.tab').forEach((tab) => {
      if (tab.dataset.stableV6) return;
      tab.dataset.stableV6 = '1';
      tab.addEventListener('click', () => setTimeout(renderFixedHistory, 50));
    });

    ['refreshHomeBtn', 'refreshCallsBtn'].forEach((id) => {
      const btn = $(id);
      if (btn && !btn.dataset.stableV6) {
        btn.dataset.stableV6 = '1';
        btn.addEventListener('click', () => setTimeout(loadFixedHistory, 50));
      }
    });
  }

  document.addEventListener('click', (e) => {
    const callBtn = e.target.closest('[data-fix-call]');
    if (!callBtn) return;
    e.preventDefault();
    e.stopPropagation();
    const phone = callBtn.dataset.fixCall;
    const name = callBtn.dataset.name || phone;
    if (window.startOutgoingCall) window.startOutgoingCall(phone, name);
  }, true);

  // Lightweight watcher only. No global prototype patch, no whole-page style fighting.
  let lastState = '';
  setInterval(() => {
    hideFooterControls();
    hideAcceptWhenNotAnswerable();
    patchButtonsOnce();
    const state = String($('callState')?.textContent || '').toLowerCase();
    const inCall = document.body.classList.contains('call-mode');
    if (inCall && state !== lastState) {
      lastState = state;
      if (state.includes('declined') || state.includes('ended') || state.includes('failed') || state.includes('already ended')) {
        setTimeout(hardResetCallUi, 700);
      }
    }
  }, 700);

  bindStaticButtons();
  patchButtonsOnce();
  latestRows = mergeRows(readCache(), latestRows);
  renderFixedHistory();
  loadFixedHistory();
  refreshTimer = setInterval(loadFixedHistory, 10000);
  window.addEventListener('beforeunload', () => { if (refreshTimer) clearInterval(refreshTimer); });
})();
