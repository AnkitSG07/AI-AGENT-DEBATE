/* No account bearer or TURN secret enters this page. The fragment carries a
 * short-lived, single-role invitation; it is never placed in an HTTP URL. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id), parts = location.hash.slice(1).split('.');
  const [id, role, token] = parts;
  const valid = /^[A-Za-z0-9_-]{32}$/.test(id || '') && ['operator', 'customer'].includes(role) && /^[A-Za-z0-9_-]{32}$/.test(token || '');
  const clientId = crypto.randomUUID();
  const endpoint = `/api/sh-video/${encodeURIComponent(id || '')}`;
  let stream, pc, closed = false, joining = false, sending = Promise.resolve(), cursor = 0, readerAbort, disconnectTimer, facing = 'user', offering = false, offered = false;
  let pendingCandidates = [], processing = Promise.resolve(), expiresTimer, recoveryTimer, focusAllowed = true, joined = false;
  const native = value => window.SHVideoNative?.postMessage(JSON.stringify(value));
  const status = text => { $('status').textContent = text; $('liveStatus').textContent = text; };
  async function request(path, body) {
    const response = await fetch(endpoint + path, { method: 'POST', headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
      cache: 'no-store', keepalive: body.type === 'end', signal: AbortSignal.timeout(10000), body: JSON.stringify({clientId, ...body}) });
    const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || 'The connection is unavailable.'); return data;
  }
  function signal(type, fields = {}) {
    const body = {type, messageId: crypto.randomUUID(), ...fields};
    const work = sending.catch(() => {}).then(async () => {
      try { return await request('/signal', body); } catch (error) {
        if (closed && type !== 'end') throw error;
        return request('/signal', body); // Same identity; no duplicate negotiation.
      }
    });
    sending = work; return work;
  }
  function stop(message = 'Call ended', notify = true) {
    if (closed) return;
    closed = true; clearTimeout(disconnectTimer); clearTimeout(expiresTimer); clearTimeout(recoveryTimer); readerAbort?.abort();
    stream?.getTracks().forEach(track => track.stop()); pc?.close();
    if (notify && valid && joined) void request('/signal', {type: 'end', messageId: crypto.randomUUID()}).catch(() => {});
    $('controls').hidden = true; $('intro').hidden = false; $('join').hidden = true; $('play').hidden = true;
    $('local').srcObject = null; $('remote').srcObject = null; document.body.classList.remove('joined'); status(message); native({type: 'ended'});
  }
  window.SHVideoEnd = () => stop();
  window.SHVideoBackground = () => { if (stream) { stream.getVideoTracks().forEach(t => { t.enabled = false; }); $('camera').setAttribute('aria-pressed', 'true'); } };
  window.SHVideoFocus = allowed => { focusAllowed = allowed; stream?.getAudioTracks().forEach(t => { t.enabled = allowed && $('mic').getAttribute('aria-pressed') !== 'true'; }); if (!allowed) { window.SHVideoBackground(); status('Audio paused for another phone activity.'); } };
  async function offer(restart = false) {
    if (closed || !pc || role !== 'operator' || offering || !restart && offered) return;
    if (pc.signalingState !== 'stable') return;
    offering = true;
    try { await pc.setLocalDescription(await pc.createOffer({iceRestart: restart})); await signal('offer', {sdp: pc.localDescription.sdp}); offered = true; }
    finally { offering = false; }
  }
  async function receive(event) {
    if (closed) return;
    if (event.type === 'end') { stop('The other participant ended the call.', false); return; }
    if (event.type === 'ready' && role === 'operator') { await offer(); return; }
    if (event.type === 'restart' && role === 'operator') { await offer(true); return; }
    if (event.type === 'offer' && role === 'customer' || event.type === 'answer' && role === 'operator') {
      await pc.setRemoteDescription({type: event.type, sdp: event.sdp});
      for (const candidate of pendingCandidates) await pc.addIceCandidate(candidate); pendingCandidates = [];
      if (event.type === 'offer') { await pc.setLocalDescription(await pc.createAnswer()); await signal('answer', {sdp: pc.localDescription.sdp}); }
    } else if (event.type === 'candidate') {
      if (pc.remoteDescription) await pc.addIceCandidate(event.candidate);
      else if (pendingCandidates.length < 100) pendingCandidates.push(event.candidate);
    }
  }
  async function events() {
    let failures = 0;
    while (!closed) {
      readerAbort = new AbortController();
      try {
        const response = await fetch(`${endpoint}/events?clientId=${encodeURIComponent(clientId)}&after=${cursor}`, {headers: {Authorization: 'Bearer ' + token}, cache: 'no-store', signal: readerAbort.signal});
        if ([403, 409, 410].includes(response.status)) { stop('This link expired or is already in use. Ask for a new link.', false); return; }
        if (!response.ok || !response.body) throw new Error('Video signaling is unavailable.');
        failures = 0; const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
        while (!closed) {
          const {done, value} = await reader.read(); if (done) break;
          buffer += decoder.decode(value, {stream: true}); if (buffer.length > 128000) throw new Error('Invalid signaling response.');
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = block.match(/^data: (.+)$/m), sequence = Number(block.match(/^id: (\d+)$/m)?.[1]);
            if (data && sequence > cursor) {
              cursor = sequence;
              processing = processing.then(() => receive(JSON.parse(data[1]))).catch(() => { if (!closed) status('Reconnecting video…'); });
            }
          }
        }
      } catch (_) { if (closed) return; }
      if (!closed) { if (++failures > 8 && pc?.connectionState !== 'connected') { stop('Connection lost. Please ask for a new video link.', false); return; } await new Promise(r => setTimeout(r, Math.min(3000, 300 * failures))); }
    }
  }
  async function join() {
    if (!valid || joining || closed) return;
    joining = true; $('join').disabled = true; status('Opening camera and microphone…');
    try {
      // Permission prompt and relay authorization run together, never serially.
      const results = await Promise.allSettled([navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true}, video: {width: {ideal: 640}, height: {ideal: 480}, frameRate: {ideal: 24, max: 30}, facingMode: facing}}), request('/join', {})]);
      if (results[0].status === 'fulfilled') stream = results[0].value;
      if (closed) { stream?.getTracks().forEach(t => t.stop()); return; }
      if (results[0].status !== 'fulfilled' || results[1].status !== 'fulfilled') throw results.find(r => r.status === 'rejected').reason;
      const config = results[1].value; pc = new RTCPeerConnection({iceServers: config.iceServers, bundlePolicy: 'max-bundle'});
      joined = true;
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      for (const sender of pc.getSenders()) if (sender.track?.kind === 'video') {
        const params = sender.getParameters(); if (!params.encodings?.length) params.encodings = [{}]; params.encodings[0].maxBitrate = 800000; await sender.setParameters(params).catch(() => {});
      }
      $('local').srcObject = stream;
      pc.onicecandidate = event => { if (event.candidate && !closed) void signal('candidate', {candidate: event.candidate.toJSON()}).catch(() => status('Reconnecting video…')); };
      pc.ontrack = event => { $('remote').srcObject = event.streams[0]; $('remote').play().catch(() => { $('play').hidden = false; }); };
      pc.onconnectionstatechange = () => {
        if (closed) return;
        if (pc.connectionState === 'connected') { clearTimeout(disconnectTimer); clearTimeout(recoveryTimer); recoveryTimer = null; status('Connected'); native({type: 'connected'}); }
        else if (['disconnected', 'failed'].includes(pc.connectionState)) {
          status('Reconnecting…'); clearTimeout(disconnectTimer);
          disconnectTimer = setTimeout(() => { if (role === 'operator') void offer(true).catch(() => {}); else void signal('restart').catch(() => {}); }, 500);
          if (!recoveryTimer) recoveryTimer = setTimeout(() => stop('Connection lost. Please ask for a new video link.'), 20000);
        }
      };
      $('controls').hidden = false; $('intro').hidden = true; document.body.classList.add('joined'); status('Waiting for the other participant…');
      if (window.SHVideoNative) { $('speaker').hidden = false; native({type: 'joining'}); }
      expiresTimer = setTimeout(() => stop('This video session reached its 30-minute limit.'), Math.max(0, config.expiresAt - Date.now()));
      void events(); await signal('ready');
    } catch (error) {
      stream?.getTracks().forEach(t => t.stop()); pc?.close();
      if (joined) { stop('Could not connect. Please ask for a new video link.'); return; }
      status(error.name === 'NotAllowedError' ? 'Allow camera and microphone access to join.' : error.message || 'Could not join. Please try again.');
      $('join').disabled = false; joining = false;
    }
  }
  $('join').onclick = join; $('end').onclick = () => stop();
  $('mic').onclick = () => { const muted = $('mic').getAttribute('aria-pressed') !== 'true'; stream?.getAudioTracks().forEach(t => { t.enabled = !muted && focusAllowed; }); $('mic').setAttribute('aria-pressed', String(muted)); $('mic').setAttribute('aria-label', muted ? 'Unmute microphone' : 'Mute microphone'); };
  $('camera').onclick = () => { const off = $('camera').getAttribute('aria-pressed') !== 'true'; stream?.getVideoTracks().forEach(t => { t.enabled = !off; }); $('camera').setAttribute('aria-pressed', String(off)); $('camera').setAttribute('aria-label', off ? 'Turn camera on' : 'Turn camera off'); };
  $('flip').onclick = async () => {
    if (!pc || closed) return; $('flip').disabled = true;
    try {
      const nextFacing = facing === 'user' ? 'environment' : 'user';
      const replacement = await navigator.mediaDevices.getUserMedia({video: {facingMode: {exact: nextFacing}, width: {ideal: 640}, height: {ideal: 480}}});
      if (closed) { replacement.getTracks().forEach(t => t.stop()); return; }
      const track = replacement.getVideoTracks()[0]; track.enabled = $('camera').getAttribute('aria-pressed') !== 'true';
      try { await pc.getSenders().find(s => s.track?.kind === 'video').replaceTrack(track); }
      catch (error) { track.stop(); throw error; }
      stream.getVideoTracks().forEach(old => { stream.removeTrack(old); old.stop(); }); stream.addTrack(track); $('local').srcObject = stream; facing = nextFacing;
    } catch (_) { status('Could not switch cameras. Your call is still connected.'); } finally { $('flip').disabled = false; }
  };
  $('speaker').onclick = () => { const on = $('speaker').getAttribute('aria-pressed') !== 'true'; native({type: 'speaker', enabled: on}); };
  window.SHVideoSpeaker = enabled => { $('speaker').setAttribute('aria-pressed', String(enabled)); $('speaker').setAttribute('aria-label', enabled ? 'Use earpiece' : 'Use speaker'); };
  $('play').onclick = () => { $('remote').play().then(() => { $('play').hidden = true; }).catch(() => {}); };
  window.addEventListener('pagehide', () => stop());
  if (!valid) { $('join').disabled = true; status('This private link is incomplete. Please ask for a new link.'); }
})();
