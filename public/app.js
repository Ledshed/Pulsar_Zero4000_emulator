(function () {
  // Set up once per page. A second run (e.g. the script included twice) would stack event listeners.
  if (window.__pulsarZ4kApp) { console.warn('Pulsar Zero 4000: app.js already initialised'); return; }
  window.__pulsarZ4kApp = true;

  const $ = id => document.getElementById(id);
  // Attach a listener by element id. If the element is missing (e.g. after editing index.html), report it
  // clearly and carry on, rather than throwing and stopping the whole interface from starting.
  const missing = new Set();
  function on(id, type, fn, opts) {
    const el = $(id);
    if (!el) {
      if (!missing.has(id)) { missing.add(id); console.error(`Pulsar Zero 4000: element #${id} not found; its "${type}" control is disabled.`); }
      return null;
    }
    el.addEventListener(type, fn, opts);
    return el;
  }
  // Run fn(element) only if the element exists (same reporting as on()).
  function withEl(id, fn) {
    const el = $(id);
    if (!el) { if (!missing.has(id)) { missing.add(id); console.error(`Pulsar Zero 4000: element #${id} not found.`); } return; }
    fn(el);
  }
  const NAMES = ['Bass', 'Tenor', 'Alto', 'Treble'];
  const ORDERS = ['RGB', 'RBG', 'GRB', 'GBR', 'BRG', 'BGR', 'RGBW', 'GRBW', 'BGRW', 'WRGB'];
  const PRESETS = [['Red', '#ff0000'], ['Orange', '#ff6000'], ['Amber', '#ffb000'], ['Yellow', '#ffff00'], ['Green', '#00ff00'],
    ['Cyan', '#00ffff'], ['Blue', '#0000ff'], ['Purple / UV', '#8000ff'], ['Magenta', '#ff00ff'], ['Pink', '#ff4080'],
    ['Warm white', '#ffd8a0'], ['White', '#ffffff']];
  const ORIGINAL_FILTERS = [{ hp: 0, lp: 106 }, { hp: 360, lp: 530 }, { hp: 1450, lp: 2100 }, { hp: 3600, lp: 0 }];
  const UI_VERSION = '1.4.0';
  // per-run access token, put into the page by the server; needed to connect and to add units
  const TOKEN = (document.querySelector('meta[name="z4k-token"]') || {}).content || '';
  let ws = null, config = null, panelState = null, stopped = false;
  const UNIT = (/^\/u\/([^/]+)\//.exec(location.pathname) || [])[1] || '1';

  const send = obj => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  const sendConfig = c => send({ t: 'config', config: c });
  const store = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  const load = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };

  const panel = ZeroPanel.create($('panelWrap'), {
    onChange: p => send({ t: 'panel', panel: p }),
    onButton: (i, down) => send({ t: 'button', i, down }),
  });

  /* ================= menus & panel-only mode ================= */
  const drops = [...document.querySelectorAll('.drop')];
  const menus = [...document.querySelectorAll('.menu')];
  function openDrop(id) {
    drops.forEach(d => { d.hidden = d.id !== id || !d.hidden; });
    menus.forEach(m => m.classList.toggle('open', !$(m.dataset.drop).hidden));
    const open = drops.find(d => !d.hidden);
    document.body.classList.toggle('drop-open', !!open);
    if (open) setTimeout(() => {
      // bring the menu bar up under the (pinned) panel so the opened sheet is visible
      const top = $('bar').getBoundingClientRect().top + window.scrollY - $('stage').offsetHeight - 6;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }, 220);
  }
  menus.forEach(m => m.addEventListener('click', () => openDrop(m.dataset.drop)));
  drops.forEach(d => { const x = d.querySelector('.close'); if (x) x.addEventListener('click', () => openDrop(null)); });
  const isOpen = id => !$(id).hidden;

  function setPanelOnly(only) {
    document.body.classList.toggle('panel-only', only);
    withEl('showUi', el => { el.hidden = !only; });
    store('z4k.panelOnly', only ? '1' : '0');
  }
  on('panelOnly', 'click', () => setPanelOnly(true));
  on('showUi', 'click', () => setPanelOnly(false));
  setPanelOnly(load('z4k.panelOnly') === '1');
  let mouseTimer = null;
  window.addEventListener('mousemove', () => {
    document.body.classList.add('mouse-active');
    clearTimeout(mouseTimer);
    mouseTimer = setTimeout(() => document.body.classList.remove('mouse-active'), 2000);
  });
  window.addEventListener('keydown', e => {
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === 'h' || e.key === 'H') setPanelOnly(!document.body.classList.contains('panel-only'));
    if (e.key === 'Escape') { if (drops.some(d => !d.hidden)) openDrop(null); else setPanelOnly(false); }
  });

  /* ================= websocket ================= */
  function connect() {
    if (stopped) return;
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?unit=${encodeURIComponent(UNIT)}&t=${encodeURIComponent(TOKEN)}`);
    ws.onopen = () => { $('conn').textContent = 'connected'; $('conn').className = 'pill ok'; };
    ws.onclose = () => { $('conn').textContent = 'offline'; $('conn').className = 'pill bad'; setTimeout(connect, 1000); };
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.t === 'hello') {
        panelState = m.panel; panel.setPanel(m.panel); setConfig(m.config);
        const warn = (m.warnings || []).slice();
        if (m.version !== UI_VERSION) warn.unshift(`This page (version ${UI_VERSION}) doesn't match the program that's running (${m.version || 'an older version'}). ` +
          'An old copy is probably still running. Close every Pulsar Zero 4000 window, including any terminal running "node server.js", then start the new version again.');
        $('banner').hidden = !warn.length;
        $('banner').innerHTML = warn.map(w => '⚠ ' + esc(w)).join('<br>');
      }
      else if (m.t === 'report') {
        $('diagText').hidden = false; $('diagText').value = m.text;
        const ok = () => { $('diagMsg').textContent = 'Copied. Paste it into your message.'; };
        if (navigator.clipboard) navigator.clipboard.writeText(m.text).then(ok, () => { $('diagText').select(); $('diagMsg').textContent = 'Select all and copy the text below.'; });
        else { $('diagText').select(); $('diagMsg').textContent = 'Select all and copy the text below.'; }
      }
      else if (m.t === 'panel') { panelState = m.panel; panel.setPanel(m.panel); syncForm(); }
      else if (m.t === 'config') setConfig(m.config);
      else if (m.t === 'buttons') panel.setButtons(m.buttons);
      else if (m.t === 'state') onState(m);
      else if (m.t === 'units') onUnits(m);
      else if (m.t === 'rejected') {
        $('toast').textContent = '⚠ Not accepted: ' + m.items.join('; ');
        $('toast').hidden = false;
        clearTimeout(window.__toastT); window.__toastT = setTimeout(() => { $('toast').hidden = true; }, 7000);
      }
      else if (m.t === 'gone') {
        stopped = true;
        const links = m.units.map(u => `<a href="/u/${u.id}/">${esc(u.name)}</a>`).join(' · ');
        showOverlay(`<h3>This unit has been deleted</h3><p>Open another one: ${links}</p>`);
      } else if (m.t === 'quit') {
        stopped = true;
        showOverlay('<h3>Pulsar Zero 4000 has stopped</h3><p>You can close this tab. To start it again, open the Pulsar Zero 4000 program.</p>');
      }
    };
  }
  connect();

  /* ================= units ================= */
  function esc(t) { return String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function showOverlay(html) { $('overlayMsg').innerHTML = html; $('overlay').hidden = false; }
  function onUnits(m) {
    $('unitName').textContent = m.units.length > 1 ? '· ' + m.name : '';
    document.title = (m.units.length > 1 ? m.name + ' · ' : '') + 'Pulsar Zero 4000';
    if (document.activeElement !== $('unitRename')) $('unitRename').value = m.name;
    $('unitList').innerHTML = m.units.map(u => `<li class="${u.id === m.self ? 'me' : ''}">
      <span><b>${esc(u.name)}</b><br><span class="meta">${u.sacn ? 'sACN universe ' + esc(u.universe) : 'sACN off'}${u.ddp ? ' · DDP ' + esc(u.ddp) : ''}</span></span>
      ${u.id === m.self ? '' : `<a class="btn" href="/u/${encodeURIComponent(u.id)}/" target="_blank" rel="noopener">Open</a>`}</li>`).join('');
    $('delUnit').disabled = m.units.length < 2;
    $('delUnit').title = m.units.length < 2 ? 'You need at least one unit' : '';
    const c = m.clashes || [];
    $('clash').hidden = !c.length;
    $('clash').title = c.join('\n');
    $('clashList').hidden = !c.length;
    $('clashList').innerHTML = c.length ? '<b>⚠ This unit overlaps another unit:</b><br>' + c.map(esc).join('<br>') +
      '<br>Change the universe or addresses in Outputs.' : '';
  }
  withEl('addUnit', el => { el.href = '/new?t=' + encodeURIComponent(TOKEN); });
  on('clash', 'click', () => openDrop('dropUnit'));
  withEl('clash', el => { el.style.cursor = 'pointer'; });
  on('unitRename', 'change', e => { e.stopPropagation(); send({ t: 'rename', name: e.target.value }); });
  on('delUnit', 'click', () => {
    if (confirm('Delete this unit and its settings? Its lights will be blacked out.')) send({ t: 'deleteUnit' });
  });
  on('quitApp', 'click', () => {
    if (confirm('Stop Pulsar Zero 4000? All units stop sending and the lights go dark.')) send({ t: 'quit' });
  });

  /* ================= generic settings binding ================= */
  const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  function setConfig(c) {
    config = c;
    syncForm();
    buildColours();
    buildPatchRows();
    buildFilterRows();
    pushAudioParams();
  }
  function fmtOut(el, v) {
    if (el.hasAttribute('data-pct')) return Math.round(v * 100) + '%';
    return (v > 0 && el.dataset.unit === ' dB' ? '+' : '') + v + (el.dataset.unit || '');
  }
  function syncForm() {
    if (!config) return;
    for (const el of document.querySelectorAll('[data-k]')) {
      if (el === document.activeElement && el.type !== 'checkbox') continue;
      const k = el.dataset.k;
      const v = k.startsWith('panel.') ? getPath({ panel: panelState }, k) : getPath(config, k);
      if (el.type === 'checkbox') el.checked = !!v;
      else if (v != null) el.value = v;
    }
    for (const el of document.querySelectorAll('[data-out]')) el.textContent = fmtOut(el, +getPath(config, el.dataset.out));
    $('sacnHostRow').style.display = config.sacn.mode === 'unicast' ? '' : 'none';
    updateSummaries();
  }
  function onField(e) {
    const el = e.target, k = el.dataset.k;
    if (!k) return;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'number' || el.type === 'range' || el.hasAttribute('data-num')) v = Number(v);
    const parts = k.split('.');
    if (parts[0] === 'panel') { send({ t: 'panel', panel: { [parts[1]]: v } }); return; }
    const out = document.querySelector(`[data-out="${k}"]`);
    if (out) out.textContent = fmtOut(out, v);
    config[parts[0]][parts[1]] = v; // optimistic, so audio params apply instantly
    if (parts[0] === 'audio') pushAudioParams();
    sendConfig({ [parts[0]]: { [parts[1]]: v } });
  }
  document.addEventListener('change', onField);
  document.addEventListener('input', e => { if (e.target.type === 'range') onField(e); });

  /* ================= sACN patch ================= */
  function parseAddresses(str) {
    const out = [];
    for (const part of String(str || '').split(/[,\s;]+/)) {
      const m = /^(\d+)(?:-(\d+))?$/.exec(part);
      if (!m) continue;
      let a = +m[1], b = m[2] ? +m[2] : a;
      if (b < a) [a, b] = [b, a];
      for (let x = a; x <= b && out.length < 512; x++) if (x >= 1 && x <= 512) out.push(x);
    }
    return out;
  }
  function compress(list) {
    const s = [...new Set(list)].sort((a, b) => a - b), out = [];
    for (let i = 0; i < s.length; i++) {
      let j = i;
      while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
      out.push(j > i ? `${s[i]}-${s[j]}` : `${s[i]}`);
      i = j;
    }
    return out.join(', ');
  }
  function buildPatchRows() {
    const tb = $('patchRows');
    if (tb.contains(document.activeElement)) return;
    tb.innerHTML = NAMES.map((n, i) => {
      const r = config.sacn.patch[i];
      return `<tr>
      <td><span class="dot" style="background:${esc(config.colors[i])};color:${esc(config.colors[i])}"></span>${n}</td>
      <td><input data-patch="${i}" data-f="dimmer" value="${esc(r.dimmer || '')}" placeholder="e.g. 1, 5"></td>
      <td><input data-patch="${i}" data-f="rgb" value="${esc(r.rgb || '')}" placeholder="e.g. 10, 20"></td>
      <td><select data-patch="${i}" data-f="order">${orderOptions(r.order || 'RGB')}</select></td>
    </tr>`;
    }).join('');
  }
  on('patchRows', 'change', e => {
    const el = e.target;
    if (el.dataset.patch != null) {
      const patch = config.sacn.patch.map(r => ({ ...r }));
      patch[+el.dataset.patch][el.dataset.f] = el.value.trim();
      if (el.dataset.f === 'order') {
        // apply the same order to every channel that has colour fixtures, if they all matched before
        const old = config.sacn.patch[+el.dataset.patch].order || 'RGB';
        if (config.sacn.patch.every(r => (r.order || 'RGB') === old)) patch.forEach(r => { r.order = el.value; });
      }
      config.sacn.patch = patch;
      sendConfig({ sacn: { patch } });
      buildPatchRows();
      updateSummaries();
    }
    e.stopPropagation();
  });
  function orderOptions(sel) {
    return ORDERS.map(o => `<option value="${o}"${o === sel ? ' selected' : ''}>${o}${o.includes('W') ? ' (4 ch)' : ' (3 ch)'}</option>`).join('');
  }
  withEl('qpOrder', el => { el.innerHTML = orderOptions('RGB'); });
  document.querySelectorAll('.orderSel').forEach(s => { s.innerHTML = orderOptions('RGB'); });
  const qpSync = () => {
    const type = $('qpType'), row = $('qpOrderRow'), foot = $('qpFoot'), order = $('qpOrder');
    if (!type || !row || !foot || !order) return;
    const colour = type.value === 'colour';
    row.style.display = colour ? '' : 'none';
    foot.value = colour ? order.value.length : 1;
  };
  on('qpType', 'change', qpSync);
  on('qpOrder', 'change', qpSync);
  qpSync();
  on('qpGo', 'click', () => {
    const colour = $('qpType').value === 'colour', order = $('qpOrder').value, start = +$('qpStart').value || 1;
    const need = colour ? order.length : 1;
    const count = Math.max(1, +$('qpCount').value || 1), foot = Math.max(need, +$('qpFoot').value || 1);
    const lists = [[], [], [], []];
    for (let f = 0; f < count; f++) {
      const a = start + f * foot;
      if (a + need - 1 > 512) break;
      lists[f % 4].push(a);
    }
    const patch = lists.map(l => colour ? { dimmer: '', rgb: l.join(', '), order } : { dimmer: compress(l), rgb: '', order: 'RGB' });
    config.sacn.patch = patch;
    sendConfig({ sacn: { patch } });
    buildPatchRows();
    updateSummaries();
  });
  function updateSummaries() {
    if (!config) return;
    const used = [];
    let fixtures = 0;
    config.sacn.patch.forEach(r => {
      used.push(...parseAddresses(r.dimmer));
      const fp = (r.order || 'RGB').length;
      for (const a of parseAddresses(r.rgb)) { for (let k = 0; k < fp; k++) used.push(a + k); fixtures++; }
    });
    const u = [...new Set(used.filter(a => a <= 512))];
    $('patchSummary').textContent = u.length
      ? `Universe ${config.sacn.universe}: ${u.length} address${u.length > 1 ? 'es' : ''} used (${compress(u)})${fixtures ? `, ${fixtures} colour fixture${fixtures > 1 ? 's' : ''}` : ''}.`
      : 'Nothing patched yet.';
    const d = config.ddp, total = d.pixelsPerChannel * 4 * (d.repeat || 1);
    $('ddpSummary').textContent = `${total} ${d.order && d.order.includes('W') ? 'RGBW ' : ''}pixels: ${d.startPixel} to ${d.startPixel + total - 1}, ` +
      `${d.repeat > 1 ? `Bass/Tenor/Alto/Treble repeated ${d.repeat}×, ` : ''}${d.pixelsPerChannel} pixels each.`;
  }

  on('ddpTest', 'click', () => {
    if (!config.ddp.host) { $('ddpStatus').textContent = '⚠ Type the WLED IP address in the box above first.'; $('ddpStatus').className = 'netstatus bad'; return; }
    send({ t: 'ddpTest' });
  });
  on('diagBtn', 'click', () => { $('diagMsg').textContent = ''; send({ t: 'report' }); });

  /* ================= channel colours ================= */
  function buildColours() {
    const box = $('colours');
    if (box.contains(document.activeElement) && document.activeElement.type !== 'button') return;
    box.innerHTML = NAMES.map((n, i) => {
      const c = esc(config.colors[i].toLowerCase());
      return `<div class="colour">
        <div class="nm">${n}</div>
        <input type="color" class="big" data-col="${i}" value="${c}" title="Pick any colour">
        <div>
          <div class="presets">${PRESETS.map(([pn, pc]) => `<button type="button" data-col="${i}" data-hexv="${pc}" title="${pn}"
            style="background:${pc}"${pc === c ? ' class="sel"' : ''}></button>`).join('')}</div>
          <input class="hex" data-col="${i}" value="${c}" maxlength="7" title="Hex colour, e.g. #ff8000" style="margin-top:6px">
        </div>
      </div>`;
    }).join('');
  }
  function setColour(i, hex) {
    if (!/^#?[0-9a-f]{6}$/i.test(hex)) return;
    hex = (hex[0] === '#' ? hex : '#' + hex).toLowerCase();
    const colors = config.colors.slice(); colors[i] = hex;
    config.colors = colors;
    sendConfig({ colors });
    buildColours(); buildPatchRows();
  }
  on('colours', 'click', e => {
    const b = e.target.closest('button[data-hexv]');
    if (b) setColour(+b.dataset.col, b.dataset.hexv);
  });
  on('colours', 'input', e => {
    // live preview while dragging in the native picker
    if (e.target.type === 'color') {
      const i = +e.target.dataset.col;
      config.colors[i] = e.target.value;
      sendConfig({ colors: config.colors.slice() });
    }
  });
  on('colours', 'change', e => {
    e.stopPropagation();
    if (e.target.dataset.col != null) setColour(+e.target.dataset.col, e.target.value.trim());
  });

  /* ================= filters ================= */
  function buildFilterRows() {
    const tb = $('filterRows');
    if (tb.contains(document.activeElement)) return;
    tb.innerHTML = NAMES.map((n, i) => {
      const f = config.audio.filters[i], o = ORIGINAL_FILTERS[i];
      return `<tr><td>${n}</td>
        <td><input type="number" min="0" max="20000" step="10" data-filt="${i}" data-f="hp" value="${esc(f.hp)}" title="Original: ${o.hp || 'none'}"></td>
        <td><input type="number" min="0" max="20000" step="10" data-filt="${i}" data-f="lp" value="${esc(f.lp)}" title="Original: ${o.lp || 'none'}"></td></tr>`;
    }).join('');
  }
  on('filterRows', 'change', e => {
    const el = e.target;
    if (el.dataset.filt == null) return;
    e.stopPropagation();
    const filters = config.audio.filters.map(f => ({ ...f }));
    filters[+el.dataset.filt][el.dataset.f] = Math.max(0, +el.value || 0);
    config.audio.filters = filters;
    pushAudioParams();
    sendConfig({ audio: { filters } });
  });
  on('filtersReset', 'click', () => {
    config.audio.filters = ORIGINAL_FILTERS; config.audio.slope = 1;
    pushAudioParams();
    sendConfig({ audio: { filters: ORIGINAL_FILTERS, slope: 1 } });
    buildFilterRows(); syncForm();
  });

  /* ================= audio sources ================= */
  let ctx = null, node = null, src = null, stream = null, mediaEl = null;
  function pushAudioParams() {
    if (!node || !config) return;
    const a = config.audio;
    node.port.postMessage({ trimDb: +a.trimDb, sens: +a.sens, filters: a.filters, slope: +a.slope });
  }
  async function listDevices() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const sel = $('audioDev'), cur = sel.value;
      sel.innerHTML = '<option value="">Default input</option>' + devs.filter(d => d.kind === 'audioinput')
        .map(d => `<option value="${esc(d.deviceId)}">${esc(d.label || 'Input ' + d.deviceId.slice(0, 6))}</option>`).join('');
      sel.value = cur;
    } catch (_) {}
  }
  if (navigator.mediaDevices) { listDevices(); navigator.mediaDevices.ondevicechange = listDevices; } // property, so it can never stack up

  // Audio engine. Built in one go: if any step fails, nothing half-built is kept, so the next attempt starts clean.
  async function ensureCtx() {
    if (!ctx) {
      const c = new AudioContext({ latencyHint: 'interactive' });
      try {
        await c.audioWorklet.addModule('detector.js');
        const n = new AudioWorkletNode(c, 'zero-detector', { numberOfInputs: 1, numberOfOutputs: 0 });
        n.port.onmessage = e => onDetector(e.data);
        ctx = c; node = n;
        pushAudioParams();
      } catch (err) {
        try { await c.close(); } catch (_) {}
        throw err;
      }
    }
    if (ctx.state !== 'running') await ctx.resume();
  }

  // Every start/stop bumps the generation. A request that finishes after a newer one was made (for example
  // a permission prompt answered after the user already picked another source) releases what it got and stops.
  let gen = 0;
  const stopTracks = s => { if (s) s.getTracks().forEach(t => { try { t.stop(); } catch (_) {} }); };
  function detach() {
    if (src) { try { src.disconnect(); } catch (_) {} src = null; }
    stopTracks(stream); stream = null;
    if (mediaEl) {
      mediaEl.pause();
      if (mediaEl.src && mediaEl.src.startsWith('blob:')) URL.revokeObjectURL(mediaEl.src); // free the file's memory
      mediaEl.removeAttribute('src');
      try { mediaEl.load(); } catch (_) {}
    }
  }
  const audioState = (s, ok) => { $('audioState').textContent = s; $('audioState').className = 'pill' + (ok ? ' ok' : ''); };
  const help = msg => { const h = $('audioHelp'); h.hidden = !msg; h.innerHTML = msg || ''; };
  const markActive = id => ['srcMic', 'srcPc', 'srcFile', 'srcStop'].forEach(k => { const el = $(k); if (el) el.classList.toggle('active', k === id); });
  function stopAll() {
    detach();
    markActive('srcStop');
    audioState('audio off', false);
  }
  markActive('srcStop');

  // Connect a live stream to the detector. On failure the stream is stopped, never left running.
  function attachStream(s, tracks) {
    try {
      src = ctx.createMediaStreamSource(tracks ? new MediaStream(tracks) : s);
      src.connect(node);
      stream = s;
    } catch (err) {
      stopTracks(s);
      if (src) { try { src.disconnect(); } catch (_) {} src = null; }
      throw err;
    }
  }

  async function startMic() {
    const my = ++gen;
    let got = null;
    try {
      await ensureCtx();
      if (my !== gen) return;
      stopAll(); help('');
      const id = $('audioDev').value;
      got = await navigator.mediaDevices.getUserMedia({ audio: {
        deviceId: id ? { exact: id } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      if (my !== gen) { stopTracks(got); return; } // superseded while the permission prompt was open
      attachStream(got);
      markActive('srcMic');
      audioState('🎤 mic / line-in', true);
      listDevices();
    } catch (err) {
      if (got && stream !== got) stopTracks(got);
      if (my !== gen) return;
      detach();
      markActive('srcStop');
      audioState('mic error', false);
      help('Could not open the microphone. Allow microphone access when the browser asks ' +
        '(click the 🔒 icon in the address bar to change it), and make sure you opened the page as <b>localhost:8040</b>.');
      console.error(err);
    }
  }

  async function startPc() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      help('This browser cannot capture PC audio. Use <b>Chrome</b> or <b>Edge</b>.');
      return;
    }
    const my = ++gen;
    let got = null;
    try {
      await ensureCtx();
      if (my !== gen) return;
      stopAll();
      help('In the pop-up, choose <b>Entire screen</b> (or a browser tab that is playing music), switch <b>Share system audio</b> ' +
        '(or <b>Share tab audio</b>) <b>on</b>, then click <b>Share</b>.');
      got = await navigator.mediaDevices.getDisplayMedia({
        video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
      });
      if (my !== gen) { stopTracks(got); return; }
      if (!got.getAudioTracks().length) {
        stopTracks(got);
        audioState('no PC audio', false);
        help('No sound was shared. Click <b>🖥 PC audio</b> again and switch on <b>Share system audio</b> (or <b>Share tab audio</b>) before you click Share. ' +
          'On a Mac, whole-system audio needs macOS 14.2 or later and a recent Chrome. Otherwise, share a <b>Chrome tab</b> that is playing music.');
        return;
      }
      attachStream(got, got.getAudioTracks());
      const s = got;
      s.getAudioTracks()[0].addEventListener('ended', () => { if (stream === s) { gen++; stopAll(); } });
      markActive('srcPc');
      audioState('🖥 PC audio', true);
      help('');
    } catch (err) {
      if (got && stream !== got) stopTracks(got);
      if (my !== gen) return;
      stopAll();
      help(err && err.name === 'NotAllowedError' ? 'PC audio sharing was cancelled.' : 'Could not capture PC audio: ' + esc(err && err.message || err));
      console.error(err);
    }
  }

  async function startFile(file) {
    const my = ++gen;
    try {
      await ensureCtx();
      if (my !== gen) return;
      stopAll(); help('');
      if (!mediaEl) {
        mediaEl = new Audio(); mediaEl.loop = true;
        mediaEl._src = ctx.createMediaElementSource(mediaEl);
      }
      mediaEl.src = URL.createObjectURL(file);
      mediaEl._src.connect(ctx.destination);
      mediaEl._src.connect(node);
      src = mediaEl._src;
      await mediaEl.play();
      if (my !== gen) return; // stopAll() from the newer request already cleaned up
      markActive('srcFile');
      audioState('🎵 ' + file.name.slice(0, 22), true);
    } catch (err) {
      if (my !== gen) return;
      stopAll();
      help(`Could not play "${esc(file.name)}". It may be a format this browser can't play; try an MP3 or WAV file.`);
      console.error(err);
    }
  }

  on('srcMic', 'click', startMic);
  on('srcPc', 'click', startPc);
  on('srcStop', 'click', () => { gen++; stopAll(); help(''); });
  on('audioDev', 'change', e => { e.stopPropagation(); if ($('srcMic').classList.contains('active')) startMic(); });
  on('audioFile', 'change', e => {
    e.stopPropagation();
    const file = e.target.files[0];
    e.target.value = '';
    if (file) startFile(file);
  });

  /* ================= LED ladder meters ================= */
  const N_LED = 24; // 16 green, 4 yellow, 4 red
  const ledClass = k => (k < 16 ? 'g' : k < 20 ? 'y' : 'r');
  const ladderDefs = [{ name: 'IN', input: true }, ...NAMES.map(n => ({ name: n.toUpperCase() }))];
  withEl('ladders', el => { el.innerHTML = ladderDefs.map((d, i) => `${i === 1 ? '<div class="ladder-sep"></div>' : ''}
    <div class="ladder${d.input ? ' input' : ''}" id="lad${i}">
      <div class="leds">${Array.from({ length: N_LED }, (_, k) => `<i class="led ${ledClass(k)}"></i>`).join('')}</div>
      ${d.input ? '<div class="trig" style="visibility:hidden"></div>' : '<div class="trig"></div>'}
      <div class="name">${d.name}</div>
    </div>`).join(''); });
  const ladders = ladderDefs.map((_, i) => {
    const el = $('lad' + i);
    if (!el) return null;
    return { leds: [...el.querySelectorAll('.led')], trig: el.querySelector('.trig'), shown: -1, avg: -1, hold: 0 };
  });
  // Input: -48…0 dBFS in 2 dB steps. Bands: detector level -30…+3 dB in 1.375 dB steps.
  const inLeds = v => (v <= 0 ? 0 : Math.max(0, Math.min(N_LED, Math.ceil((20 * Math.log10(v) + 48) / 2))));
  const bandLeds = v => (v <= 0 ? 0 : Math.max(0, Math.min(N_LED, Math.ceil((20 * Math.log10(v) + 30) / 1.375))));
  function drawLadder(L, n, avgN, trig) {
    if (!L) return;
    L.hold = Math.max(n, L.hold - 1.1); // fast-attack, slow-fall display ballistics
    const lit = Math.round(L.hold);
    if (lit !== L.shown) { L.leds.forEach((e, k) => e.classList.toggle('on', k < lit)); L.shown = lit; }
    if (avgN !== L.avg) {
      L.leds.forEach((e, k) => e.classList.toggle('avg', k === avgN - 1));
      L.avg = avgN;
    }
    if (trig != null) L.trig.classList.toggle('on', trig);
  }

  let detFrame = 0;
  function onDetector(d) {
    send({ t: 'music', on: d.on, drive: d.drive });
    if (++detFrame % 2 || !isOpen('dropAudio')) return;
    drawLadder(ladders[0], inLeds(d.peak), -1, null);
    for (let b = 0; b < 4; b++) drawLadder(ladders[b + 1], bandLeds(d.env[b]), bandLeds(d.avg[b]), d.on[b]);
  }

  /* ================= state from the emulator ================= */
  withEl('lamps', el => { el.innerHTML = NAMES.map((n, i) => `<div class="lamp"><i id="lamp${i}"></i>${n}</div>`).join(''); });
  const hexToRgb = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  function onState(m) {
    panel.setNeons(m.neon, panelState && panelState.power);
    for (const [k, el, label, line] of [['sacn', 'netSacn', 'sACN', 'sacnStatus'], ['ddp', 'netDdp', 'DDP', 'ddpStatus']]) {
      let st = m.net[k]; // null = off, else {ok, text}
      if (typeof st === 'string') st = st === 'off' ? null : { ok: st === 'ok', text: st }; // older server
      $(el).textContent = label + (!st ? ' off' : st.ok ? ' ●' : ' ⚠');
      $(el).title = !st ? 'off' : st.text;
      $(el).className = 'pill' + (!st ? '' : st.ok ? ' ok' : ' bad');
      $(line).textContent = !st ? `${label} is off.` : (st.ok ? '● ' : '⚠ ') + st.text.charAt(0).toUpperCase() + st.text.slice(1);
      $(line).className = 'netstatus' + (!st ? '' : st.ok ? ' ok' : ' bad');
    }
    const w = m.net.wled;
    $('wledStatus').textContent = w ? { ok: '✔ ', warn: '⚠ ', bad: '✖ ', info: 'ℹ ' }[w.level] + w.text : (m.net.ddp ? 'Checking the receiver…' : '');
    $('wledStatus').className = 'netstatus ' + (w ? w.level : 'info');
    const testing = m.net.testing || 0;
    $('ddpTest').disabled = testing > 0;
    $('ddpTest').textContent = testing > 0 ? `Sending white… ${Math.ceil(testing / 1000)} s` : 'Send test (all white, 5 s)';
    if (!isOpen('dropMon')) return;
    m.out.forEach((v, i) => {
      const [r, g, b] = hexToRgb((config && config.colors[i]) || '#ffffff');
      const el = $('lamp' + i);
      el.style.background = `rgb(${r * v | 0},${g * v | 0},${b * v | 0})`;
      el.style.boxShadow = v > 0.02 ? `0 0 ${8 + 22 * v}px rgba(${r},${g},${b},${0.75 * v})` : 'none';
    });
    const d = m.diag;
    const tag = { pairs: 'Pairs chase', dark: 'Dark chase', light: 'Light chase' }[d.pattern];
    $('diag').textContent =
      `program   ${tag} · ${d.reverse ? 'reverse' : 'forward'}${d.hold ? ' · HOLD' : ''}\n` +
      `mode      ${d.mode}\n` +
      `counter   ${d.counter} / 96\n` +
      `rate      ${d.stepRate.toFixed(2)} steps/s`;
  }
})();
