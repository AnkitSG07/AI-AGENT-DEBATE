(() => {
  if (window.__SH_OPERATOR_CALL_STABLE_V7__) return;
  window.__SH_OPERATOR_CALL_STABLE_V7__ = true;

  const CACHE_KEY = 'sh_operator_call_history_v4';
  const OLD_CACHE_KEYS = ['sh_operator_call_history_v2', 'sh_operator_call_history_v3'];
  const ACTIVE_OUTGOING_KEY = 'sh_active_outgoing_call';
  let latestRows = [];
  let cleanupInProgress = false;

  const terminalRe = /miss|declin|reject|failed|ended|terminate|timeout|no.answer|no_answer|unanswered/i;
  const $ = (id) => document.getElementById(id);
  const clean = (v) => String(v || '').replace(/\D/g, '');
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const safeRows = (v) => Array.isArray(v) ? v : [];

  const readActiveOutgoing = () => { try { return JSON.parse(sessionStorage.getItem(ACTIVE_OUTGOING_KEY) || 'null'); } catch { return null; } };
  const writeActiveOutgoing = (v) => { try { v ? sessionStorage.setItem(ACTIVE_OUTGOING_KEY, JSON.stringify(v)) : sessionStorage.removeItem(ACTIVE_OUTGOING_KEY); } catch {} };

  if (!window.__SH_FETCH_OUTGOING_PATCHED__) {
    window.__SH_FETCH_OUTGOING_PATCHED__ = true;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async function(input, init) {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      const res = await nativeFetch(input, init);
      if (url.includes('/api/whatsapp-calls/outgoing')) {
        try {
          const j = await res.clone().json();
          if (j?.ok && (j.call_id || j.id)) writeActiveOutgoing({ call_id: j.call_id || j.id, phone_number_id: j.phone_number_id || '', customer_phone: j.customer_phone || '', at: Date.now() });
        } catch {}
      }
      if (url.includes('/api/whatsapp-calls/terminate')) writeActiveOutgoing(null);
      return res;
    };
  }

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
  function timeText(c) { const t = tsMs(c); if (!t) return ''; try { return new Date(t).toLocaleString(); } catch { return ''; } }

  function mergeRows(a, b) {
    const map = new Map();
    [...safeRows(a), ...safeRows(b)].forEach((c) => {
      const key = [callId(c) || phoneOf(c) || Math.random(), eventOf(c), tsMs(c) || ''].join('|');
      map.set(key, c);
    });
    return [...map.values()].sort((x, y) => (tsMs(y) || 0) - (tsMs(x) || 0)).slice(0, 200);
  }
  const readCache = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '[]'); } catch { return []; } };
  const writeCache = (rows) => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(safeRows(rows).slice(0, 200))); } catch {} };
  function clearAllCallCaches() { try { localStorage.removeItem(CACHE_KEY); } catch {}; OLD_CACHE_KEYS.forEach((k) => { try { localStorage.removeItem(k); } catch {} }); }

  function cardHtml(c) {
    const kind = kindOf(c), name = esc(nameOf(c)), phone = phoneOf(c), ev = esc(eventOf(c)), time = esc(timeText(c));
    const callText = kind === 'outgoing' ? 'Call Again' : 'Call Back';
    const call = phone ? '<button class="client-call" data-fix-call="' + phone + '" data-name="' + name + '">' + callText + '</button>' : '<button class="client-call" disabled>No No.</button>';
    return '<div class="client-card ' + kind + '"><div class="client-avatar">' + esc(initialOf(c)) + '</div><div class="client-name">' + name + '</div><div class="client-phone">' + (phone ? '+' + phone : 'No number') + '</div><div class="client-meta">' + ev + (time ? ' • ' + time : '') + '</div><div class="client-badge ' + kind + '">' + kind + '</div><div class="card-actions">' + call + '</div></div>';
  }
  function activeFilter() { return document.querySelector('.tab.active')?.dataset?.filter || 'all'; }
  function renderFixedHistory() {
    const filter = activeFilter();
    const rows = filter === 'all' ? latestRows : latestRows.filter((r) => kindOf(r) === filter);
    const empty = '<div class="empty-card"><div class="empty-icon">SH</div><div><b>No ' + (filter === 'all' ? 'WhatsApp' : filter) + ' calls yet</b><span>Calls will appear after webhook/Odoo sync.</span></div></div>';
    const html = rows.length ? rows.map(cardHtml).join('') : empty;
    if ($('homeCallList')) $('homeCallList').innerHTML = html;
    if ($('callList')) $('callList').innerHTML = latestRows.length ? latestRows.map(cardHtml).join('') : empty;
    if ($('sectionTitle')) $('sectionTitle').textContent = filter === 'all' ? 'All calls' : filter[0].toUpperCase() + filter.slice(1);
  }
  async function loadFixedHistory() {
    let odooReached = false, rows = [];
    try { const j = await (await fetch('/api/odoo/call-log/recent?limit=120', { cache: 'no-store' })).json(); if (j.ok && Array.isArray(j.calls)) { odooReached = true; rows = j.calls; } } catch {}
    if (odooReached) { latestRows = rows; rows.length ? writeCache(rows) : clearAllCallCaches(); renderFixedHistory(); return; }
    try { const j = await (await fetch('/api/whatsapp-calls/recent?limit=120', { cache: 'no-store' })).json(); if (Array.isArray(j.calls)) rows = j.calls; } catch {}
    latestRows = mergeRows(readCache(), rows); writeCache(latestRows); renderFixedHistory();
  }
  function hideFooterControls() { ['backBtn', 'refreshBtn'].forEach((id) => { if ($(id)) $(id).style.display = 'none'; }); const foot = document.querySelector('.foot'); if (foot) foot.style.display = 'none'; }
  function hideAcceptWhenNotAnswerable() {
    const text = ((($('errorBox') || {}).textContent || '') + ' ' + ((($('callState') || {}).textContent) || '')).toLowerCase();
    if ($('acceptBtn') && (text.includes('does not include webrtc sdp') || text.includes('call declined') || text.includes('already ended'))) { $('acceptBtn').style.display = 'none'; if ($('acceptLabel')) $('acceptLabel').textContent = text.includes('declined') || text.includes('ended') ? 'Ended' : 'Waiting'; }
  }
  async function terminateActiveOutgoing() {
    const active = readActiveOutgoing();
    if (!active?.call_id) return;
    try { await fetch('/api/whatsapp-calls/terminate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ call_id: active.call_id, phone_number_id: active.phone_number_id || '', reason: 'operator_end' }) }); } catch {}
    writeActiveOutgoing(null);
  }
  async function hardResetCallUi() {
    if (cleanupInProgress) return;
    cleanupInProgress = true;
    await terminateActiveOutgoing();
    try { window.stopRingtone?.(); } catch {}
    try { window.pc?.close?.(); } catch {}
    try { window.localStream?.getTracks?.().forEach((t) => t.stop()); } catch {}
    document.body.classList.remove('call-mode'); document.body.style.pointerEvents = ''; document.documentElement.style.pointerEvents = '';
    if ($('timer')) $('timer').textContent = '00:00';
    if ($('errorBox')) { $('errorBox').textContent = ''; $('errorBox').classList.remove('show'); }
    if ($('acceptBtn')) $('acceptBtn').style.display = 'grid'; if ($('rejectBtn')) $('rejectBtn').style.display = 'grid'; if ($('endBtn')) $('endBtn').style.display = 'none'; if ($('acceptLabel')) $('acceptLabel').textContent = 'Accept';
    setTimeout(() => { cleanupInProgress = false; loadFixedHistory(); }, 600);
  }
  function patchButtonsOnce() {
    hideFooterControls(); hideAcceptWhenNotAnswerable();
    if ($('rejectBtn') && !$('rejectBtn').dataset.stableV7) { $('rejectBtn').dataset.stableV7 = '1'; $('rejectBtn').addEventListener('click', () => setTimeout(hardResetCallUi, 550), true); }
    if ($('endBtn') && !$('endBtn').dataset.stableV7) { $('endBtn').dataset.stableV7 = '1'; $('endBtn').addEventListener('click', () => setTimeout(hardResetCallUi, 550), true); }
    if ($('acceptBtn') && !$('acceptBtn').dataset.stableV7) { $('acceptBtn').dataset.stableV7 = '1'; $('acceptBtn').addEventListener('click', (e) => { const text = ((($('errorBox') || {}).textContent || '') + ' ' + ((($('callState') || {}).textContent) || '')).toLowerCase(); if (text.includes('does not include webrtc sdp') || text.includes('already ended') || text.includes('declined')) { e.preventDefault(); e.stopImmediatePropagation(); hideAcceptWhenNotAnswerable(); } }, true); }
  }
  function showOutgoingFallback(phone, name) {
    if ($('callTitle')) $('callTitle').textContent = 'Outgoing WhatsApp Call';
    if ($('callerName')) $('callerName').textContent = name || phone;
    if ($('callerPhone')) $('callerPhone').textContent = '+' + phone;
    if ($('callState')) $('callState').textContent = 'Preparing outgoing call…';
    if ($('acceptBtn')) $('acceptBtn').style.display = 'none'; if ($('rejectBtn')) $('rejectBtn').style.display = 'none'; if ($('endBtn')) $('endBtn').style.display = 'grid'; if ($('acceptLabel')) $('acceptLabel').textContent = 'Calling';
    document.body.classList.add('call-mode');
  }
  document.addEventListener('click', (e) => {
    const callBtn = e.target.closest('[data-fix-call]');
    if (!callBtn) return;
    e.preventDefault(); e.stopPropagation();
    const phone = callBtn.dataset.fixCall, name = callBtn.dataset.name || phone;
    showOutgoingFallback(phone, name);
    if (typeof window.startOutgoingCall === 'function') window.startOutgoingCall(phone, name);
    else if ($('callState')) $('callState').textContent = 'Call function not ready. Reopen the app and try again.';
  }, true);
  document.querySelectorAll('.tab').forEach((tab) => { if (!tab.dataset.stableV7) { tab.dataset.stableV7 = '1'; tab.addEventListener('click', () => setTimeout(renderFixedHistory, 50)); } });
  ['refreshHomeBtn', 'refreshCallsBtn'].forEach((id) => { const btn = $(id); if (btn && !btn.dataset.stableV7) { btn.dataset.stableV7 = '1'; btn.addEventListener('click', () => setTimeout(loadFixedHistory, 50)); } });
  let lastState = '';
  setInterval(() => { hideFooterControls(); hideAcceptWhenNotAnswerable(); patchButtonsOnce(); const state = String($('callState')?.textContent || '').toLowerCase(); if (document.body.classList.contains('call-mode') && state !== lastState) { lastState = state; if (state.includes('declined') || state.includes('ended') || state.includes('failed') || state.includes('already ended')) setTimeout(hardResetCallUi, 700); } }, 700);
  patchButtonsOnce(); latestRows = mergeRows(readCache(), latestRows); renderFixedHistory(); loadFixedHistory();
})();
