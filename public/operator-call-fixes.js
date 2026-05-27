(() => {
  if (window.__SH_OPERATOR_CALL_FLOW_HARDENED_V5__) return;
  window.__SH_OPERATOR_CALL_FLOW_HARDENED_V5__ = true;

  const CACHE_KEY = 'sh_operator_call_history_v4';
  const OLD_CACHE_KEYS = ['sh_operator_call_history_v2', 'sh_operator_call_history_v3'];
  const LIVE_MAX_AGE_MS = 110000;
  let latestRows = [];
  let refreshTimer = null;
  let activeCall = null;

  const terminalRe = /miss|declin|reject|failed|ended|terminate|timeout|no.answer|no_answer|unanswered/i;
  const liveRe = /connect|ring|offer|incoming/i;

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

  function isTerminal(c) {
    const status = String(c?.status || '').toLowerCase();
    return terminalRe.test(eventOf(c)) || ['missed', 'declined', 'ended', 'failed'].includes(status);
  }

  function isStale(c) {
    const t = tsMs(c);
    return !!t && Date.now() - t > LIVE_MAX_AGE_MS;
  }

  function hasTerminalFor(id) {
    return !!id && latestRows.some((r) => callId(r) === id && isTerminal(r));
  }

  function liveOpenable(c) {
    const id = callId(c);
    if (!id || isTerminal(c) || isStale(c) || hasTerminalFor(id)) return false;
    return !!(c?.has_sdp || c?.session?.sdp || c?.raw?.call?.session?.sdp || liveRe.test(eventOf(c)));
  }

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

  function ensureActiveChip() {
    let chip = $('returnActiveCallChip');
    if (!chip) {
      chip = document.createElement('button');
      chip.id = 'returnActiveCallChip';
      chip.textContent = 'Return to Active Call';
      chip.style.cssText = 'display:none;position:fixed;left:50%;top:calc(14px + env(safe-area-inset-top));transform:translateX(-50%);z-index:99;border:0;border-radius:999px;background:#111;color:#fff;font-weight:900;font-size:13px;padding:12px 18px;box-shadow:0 14px 34px rgba(0,0,0,.18);';
      document.body.appendChild(chip);
      chip.addEventListener('click', () => {
        if (!activeCall) return;
        document.body.classList.add('call-mode');
        chip.style.display = 'none';
      });
    }
    return chip;
  }

  function showActiveChip(show) {
    const chip = ensureActiveChip();
    chip.style.display = show && activeCall ? 'block' : 'none';
  }

  function hideFooterControls() {
    const back = $('backBtn');
    const refresh = $('refreshBtn');
    if (back) back.style.display = 'none';
    if (refresh) refresh.style.display = 'none';
    const foot = document.querySelector('.foot');
    if (foot) foot.style.display = 'none';
  }

  function cardHtml(c) {
    const kind = kindOf(c);
    const name = esc(nameOf(c));
    const phone = phoneOf(c);
    const ev = esc(eventOf(c));
    const time = esc(timeText(c));
    const callText = kind === 'outgoing' ? 'Call Again' : 'Call Back';
    const call = phone ? `<button class="client-call" data-fix-call="${phone}" data-name="${name}">${callText}</button>` : '<button class="client-call" disabled>No No.</button>';
    return `<div class="client-card ${kind}"><div class="client-avatar">${esc(initialOf(c))}</div><div class="client-name">${name}</div><div class="client-phone">${phone ? '+' + phone : 'No number'}</div><div class="client-meta">${ev}${time ? ' • ' + time : ''}</div><div class="client-badge ${kind}">${kind}</div><div class="card-actions">${call}</div></div>`;
  }

  function activeFilter() {
    const active = document.querySelector('.tab.active');
    return active?.dataset?.filter || 'all';
  }

  function renderFixedHistory() {
    const filter = activeFilter();
    const rows = filter === 'all' ? latestRows : latestRows.filter((r) => kindOf(r) === filter);
    const empty = `<div class="empty-card"><div class="empty-icon">SH</div><div><b>No ${filter === 'all' ? 'WhatsApp' : filter} calls yet</b><span>Calls will appear after webhook/Odoo sync.</span></div></div>`;
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

  function hideAcceptIfNotReady() {
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

  function closeCallScreen(delay = 450) {
    setTimeout(() => {
      try { window.stopRingtone?.(); } catch {}
      try { window.pc?.close?.(); } catch {}
      try { window.localStream?.getTracks?.().forEach((t) => t.stop()); } catch {}
      activeCall = null;
      showActiveChip(false);
      document.body.classList.remove('call-mode');
      const timer = $('timer');
      if (timer) timer.textContent = '00:00';
      const err = $('errorBox');
      if (err) { err.textContent = ''; err.classList.remove('show'); }
      const accept = $('acceptBtn');
      const reject = $('rejectBtn');
      const end = $('endBtn');
      if (accept) accept.style.display = 'grid';
      if (reject) reject.style.display = 'grid';
      if (end) end.style.display = 'none';
      loadFixedHistory();
    }, delay);
  }

  function markCallActive() {
    const title = $('callTitle')?.textContent || '';
    const state = $('callState')?.textContent || '';
    const phone = $('callerPhone')?.textContent || '';
    if (document.body.classList.contains('call-mode') && !/declined|ended|failed|already/i.test(state)) {
      activeCall = { title, state, phone, at: Date.now() };
    }
  }

  function patchButtons() {
    hideFooterControls();
    const reject = $('rejectBtn');
    if (reject && !reject.dataset.fixBoundV5) {
      reject.dataset.fixBoundV5 = '1';
      reject.addEventListener('click', () => closeCallScreen(700), true);
    }
    const end = $('endBtn');
    if (end && !end.dataset.fixBoundV5) {
      end.dataset.fixBoundV5 = '1';
      end.addEventListener('click', () => closeCallScreen(700), true);
    }
    const accept = $('acceptBtn');
    if (accept && !accept.dataset.fixBoundV5) {
      accept.dataset.fixBoundV5 = '1';
      accept.addEventListener('click', (e) => {
        const text = (($('errorBox')?.textContent || '') + ' ' + ($('callState')?.textContent || '')).toLowerCase();
        if (text.includes('does not include webrtc sdp') || text.includes('already ended') || text.includes('declined')) {
          e.preventDefault();
          e.stopImmediatePropagation();
          hideAcceptIfNotReady();
          return;
        }
        markCallActive();
      }, true);
    }
  }

  function patchTabs() {
    document.querySelectorAll('.tab').forEach((tab) => {
      if (tab.dataset.fixBoundV5) return;
      tab.dataset.fixBoundV5 = '1';
      tab.addEventListener('click', () => setTimeout(renderFixedHistory, 30));
    });
    const refresh = $('refreshHomeBtn');
    if (refresh && !refresh.dataset.fixBoundV5) {
      refresh.dataset.fixBoundV5 = '1';
      refresh.addEventListener('click', () => setTimeout(loadFixedHistory, 30));
    }
    const refresh2 = $('refreshCallsBtn');
    if (refresh2 && !refresh2.dataset.fixBoundV5) {
      refresh2.dataset.fixBoundV5 = '1';
      refresh2.addEventListener('click', () => setTimeout(loadFixedHistory, 30));
    }
  }

  document.addEventListener('click', (e) => {
    const callBtn = e.target.closest('[data-fix-call]');
    if (callBtn) {
      e.preventDefault();
      e.stopPropagation();
      const phone = callBtn.dataset.fixCall;
      const name = callBtn.dataset.name || phone;
      if (window.startOutgoingCall) {
        activeCall = { title: 'Outgoing WhatsApp Call', phone, at: Date.now() };
        window.startOutgoingCall(phone, name);
      }
    }
  }, true);

  const originalBodyClassRemove = DOMTokenList.prototype.remove;
  DOMTokenList.prototype.remove = function (...tokens) {
    if (this === document.body.classList && tokens.includes('call-mode') && activeCall) {
      setTimeout(() => showActiveChip(true), 80);
    }
    return originalBodyClassRemove.apply(this, tokens);
  };

  const observer = new MutationObserver(() => {
    hideAcceptIfNotReady();
    hideFooterControls();
    patchButtons();
    markCallActive();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style'] });

  patchButtons();
  patchTabs();
  hideFooterControls();
  latestRows = mergeRows(readCache(), latestRows);
  renderFixedHistory();
  loadFixedHistory();
  refreshTimer = setInterval(loadFixedHistory, 10000);
  window.addEventListener('beforeunload', () => { if (refreshTimer) clearInterval(refreshTimer); });
})();
