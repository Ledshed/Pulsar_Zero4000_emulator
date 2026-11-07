/* Pulsar Zero 4000 front panel, drawn as SVG. window.ZeroPanel.create(el, handlers) */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 1320, H = 420;
  const CH = [
    { name: 'BASS', music: 'Bass', flip: 'Flip-Flop', cx: 281 },
    { name: 'TENOR', music: 'Tenor', flip: 'Flip-Flop', cx: 489 },
    { name: 'ALTO', music: 'Alto', flip: 'Flop-Flip', cx: 695 },
    { name: 'TREBLE', music: 'Treble', flip: 'Flop-Flip', cx: 901 },
  ];
  const BOX = [[178, 384], [388, 590], [594, 796], [800, 1002]];
  const KY = 272, KR = 50, DOT_R = 68;
  const DETENTS = [-64, -42, -19, 4, 27, 50];
  const SPEED = { cx: 1118, cy: 250, min: -135, max: 135 };
  const BTN_X = [470, 552, 636, 718], BTN_Y = 348;
  const GOLD = '#e2a72e', CREAM = '#ece6d6', LBL = '#f1ede4', AMBER = '#f0b43a';
  const FONT = 'Arimo, "Helvetica Neue", Helvetica, Arial, sans-serif';      // Helvetica Bold on the original
  const LOGO_FONT = 'Fredoka, "Arial Rounded MT Bold", sans-serif';           // fat rounded 70s logo face
  const MODEL_FONT = '"Abril Fatface", Clarendon, "Rockwell Extra Bold", Georgia, serif'; // heavy Clarendon-style model name

  const rad = a => (a * Math.PI) / 180;
  const polar = (cx, cy, r, a) => [cx + r * Math.sin(rad(a)), cy - r * Math.cos(rad(a))];
  const f = n => Math.round(n * 10) / 10;

  function gapRect(x, y, w, h, r, side, from, to) {
    if (side === 'top') {
      return `M${from} ${y}H${x + r}A${r} ${r} 0 0 0 ${x} ${y + r}V${y + h - r}A${r} ${r} 0 0 0 ${x + r} ${y + h}` +
        `H${x + w - r}A${r} ${r} 0 0 0 ${x + w} ${y + h - r}V${y + r}A${r} ${r} 0 0 0 ${x + w - r} ${y}H${to}`;
    }
    return `M${from} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}` +
      `H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${to}`;
  }

  const text = (x, y, s, o = {}) =>
    `<text x="${f(x)}" y="${f(y)}" font-family='${o.font || FONT}' font-size="${o.size || 13}" fill="${o.fill || LBL}"` +
    ` text-anchor="${o.anchor || 'middle'}" font-weight="${o.weight || 700}"${o.ls ? ` letter-spacing="${o.ls}"` : ''}` +
    `${o.cls ? ` class="${o.cls}"` : ''}${o.data ? ' ' + o.data : ''}${o.extra || ''}>${s}</text>`;

  const defs = `
  <defs>
    <linearGradient id="pnl" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#26201d"/><stop offset=".45" stop-color="#171311"/><stop offset="1" stop-color="#0e0c0b"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".35" stop-color="#fff" stop-opacity=".035"/>
      <stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset=".8" stop-color="#fff" stop-opacity=".03"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <filter id="grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="7"/>
      <feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .07 0"/>
    </filter>
    <filter id="inline" x="-5%" y="-10%" width="110%" height="120%">
      <feMorphology in="SourceAlpha" operator="erode" radius="1.6" result="e1"/>
      <feMorphology in="SourceAlpha" operator="erode" radius="2.6" result="e2"/>
      <feComposite in="e1" in2="e2" operator="out" result="ring"/>
      <feOffset in="ring" dx="-.6" dy="-.6" result="ringo"/>
      <feFlood flood-color="#3a2a22"/>
      <feComposite in2="ringo" operator="in" result="line"/>
      <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="line"/></feMerge>
    </filter>
    <linearGradient id="skirt" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f4f4f2"/><stop offset=".55" stop-color="#b9b9b6"/>
      <stop offset=".85" stop-color="#7d7d7a"/><stop offset="1" stop-color="#cfcfcb"/>
    </linearGradient>
    <radialGradient id="face" cx=".42" cy=".36" r=".75">
      <stop offset="0" stop-color="#ffffff"/><stop offset=".45" stop-color="#dcdcda"/><stop offset="1" stop-color="#9c9c98"/>
    </radialGradient>
    <radialGradient id="rings" cx=".5" cy=".5" r=".035" spreadMethod="repeat">
      <stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset=".5" stop-color="#000" stop-opacity=".16"/>
      <stop offset="1" stop-color="#000" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="kshadow" cx=".5" cy=".5" r=".5">
      <stop offset=".6" stop-color="#000" stop-opacity=".75"/><stop offset="1" stop-color="#000" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="neonOff" cx=".4" cy=".35" r=".7">
      <stop offset="0" stop-color="#7a2a20"/><stop offset=".6" stop-color="#4a0f0a"/><stop offset="1" stop-color="#240504"/>
    </radialGradient>
    <radialGradient id="neonOn" cx=".42" cy=".38" r=".7">
      <stop offset="0" stop-color="#fff2c8"/><stop offset=".3" stop-color="#ff8a3a"/><stop offset=".75" stop-color="#ff3010"/><stop offset="1" stop-color="#a51406"/>
    </radialGradient>
    <radialGradient id="neonGlow" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="#ff5a20" stop-opacity=".6"/><stop offset="1" stop-color="#ff3000" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rockUp" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ff7a52"/><stop offset=".5" stop-color="#ef3b1e"/><stop offset="1" stop-color="#c82612"/>
    </linearGradient>
    <linearGradient id="rockDown" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7c140a"/><stop offset=".6" stop-color="#a8200f"/><stop offset="1" stop-color="#c3311a"/>
    </linearGradient>
    <linearGradient id="rockFlat" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#c7301a"/><stop offset=".5" stop-color="#ec4a26"/><stop offset="1" stop-color="#c7301a"/>
    </linearGradient>
    <linearGradient id="bezel" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fbf9f2"/><stop offset="1" stop-color="#cdc8bb"/>
    </linearGradient>
    <linearGradient id="btn" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ff7448"/><stop offset=".55" stop-color="#e8401f"/><stop offset="1" stop-color="#b52a12"/>
    </linearGradient>
    <linearGradient id="btnDown" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#9c2410"/><stop offset="1" stop-color="#d23a1c"/>
    </linearGradient>
  </defs>`;

  function knob(id, cx, cy) {
    return `
    <g id="${id}">
      <circle cx="${cx + 3}" cy="${cy + 8}" r="${KR + 6}" fill="url(#kshadow)"/>
      <circle cx="${cx}" cy="${cy}" r="${KR}" fill="url(#skirt)" stroke="#555" stroke-width="1"/>
      <circle cx="${cx}" cy="${cy}" r="${KR - 9}" fill="url(#face)" stroke="#8a8a86" stroke-width=".8"/>
      <circle cx="${cx}" cy="${cy}" r="${KR - 9}" fill="url(#rings)"/>
      <ellipse cx="${cx - 12}" cy="${cy - 16}" rx="18" ry="9" fill="#fff" opacity=".35" transform="rotate(-25 ${cx - 12} ${cy - 16})"/>
      <g class="ptr" transform="rotate(0 ${cx} ${cy})">
        <line x1="${cx}" y1="${cy - 13}" x2="${cx}" y2="${cy - KR + 11}" stroke="#151515" stroke-width="3" stroke-linecap="round"/>
      </g>
      <circle class="knobhit" data-knob="${id}" cx="${cx}" cy="${cy}" r="${KR + 4}" fill="transparent"/>
    </g>`;
  }

  function neon(id, cx, cy) {
    return `
    <g id="${id}">
      <circle class="glow" cx="${cx}" cy="${cy}" r="32" fill="url(#neonGlow)" opacity="0"/>
      <circle cx="${cx}" cy="${cy}" r="14.5" fill="#120807" stroke="#000" stroke-width="1"/>
      <circle cx="${cx}" cy="${cy}" r="11.5" fill="url(#neonOff)"/>
      <circle class="lit" cx="${cx}" cy="${cy}" r="11.5" fill="url(#neonOn)" opacity="0"/>
      <ellipse cx="${cx - 3.5}" cy="${cy - 4.5}" rx="4" ry="2.6" fill="#fff" opacity=".35"/>
    </g>`;
  }

  function rocker(id, cx, y) {
    const w = 50, h = 110, x = cx - w / 2;
    const ix = x + 7, iy = y + 8, iw = w - 14, ih = h - 16;
    return `
    <g id="${id}">
      <rect x="${x + 2}" y="${y + 4}" width="${w}" height="${h}" rx="4" fill="#000" opacity=".5"/>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="url(#bezel)" stroke="#8b867a"/>
      <rect x="${ix - 2}" y="${iy - 2}" width="${iw + 4}" height="${ih + 4}" rx="2" fill="#3a0b05"/>
      <rect class="top" x="${ix}" y="${iy}" width="${iw}" height="${ih / 2}" rx="2" fill="url(#rockFlat)"/>
      <rect class="bot" x="${ix}" y="${iy + ih / 2}" width="${iw}" height="${ih / 2}" rx="2" fill="url(#rockFlat)"/>
      <line class="ridge" x1="${ix + 2}" x2="${ix + iw - 2}" y1="${iy + ih / 2}" y2="${iy + ih / 2}" stroke="#ffd2b8" stroke-opacity=".5" stroke-width="1.2"/>
      <rect class="hit" data-rock="${id}" data-pos="0" x="${x}" y="${y}" width="${w}" height="${h / 3}" fill="transparent"/>
      <rect class="hit" data-rock="${id}" data-pos="1" x="${x}" y="${y + h / 3}" width="${w}" height="${h / 3}" fill="transparent"/>
      <rect class="hit" data-rock="${id}" data-pos="2" x="${x}" y="${y + (2 * h) / 3}" width="${w}" height="${h / 3}" fill="transparent"/>
    </g>`;
  }

  function build() {
    let s = `<svg xmlns="${NS}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Pulsar Zero 4000 front panel">${defs}`;
    s += `<rect x="0" y="0" width="${W}" height="${H}" rx="5" fill="url(#pnl)"/>`;
    s += `<rect x="0" y="0" width="${W}" height="${H}" rx="5" filter="url(#grain)"/>`;
    s += `<rect x="0" y="0" width="${W}" height="${H}" rx="5" fill="url(#sheen)"/>`;
    s += `<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="5" fill="none" stroke="#3b3430"/>`;
    for (const [x, y] of [[16, 62], [16, 362], [1304, 62], [1304, 362]]) {
      s += `<circle cx="${x}" cy="${y}" r="6" fill="#050404" stroke="#4a423c"/>`;
    }

    // Level rocker: Standby 0% / Shimmer Dim 50% / Full 100%
    s += text(132, 120, 'Standby', { size: 13, cls: 'hit', data: 'data-rock="level" data-pos="0"' });
    s += text(132, 136, '0%', { size: 13, cls: 'hit', data: 'data-rock="level" data-pos="0"' });
    s += text(64, 200, 'Shimmer', { size: 13, cls: 'hit', data: 'data-rock="level" data-pos="1"' });
    s += text(64, 216, 'Dim 50%', { size: 13, cls: 'hit', data: 'data-rock="level" data-pos="1"' });
    s += text(132, 284, 'Full', { size: 13, cls: 'hit', data: 'data-rock="level" data-pos="2"' });
    s += text(132, 300, '100%', { size: 13, cls: 'hit', data: 'data-rock="level" data-pos="2"' });
    s += rocker('level', 132, 152);

    // Channel boxes
    CH.forEach((c, i) => {
      const [x0, x1] = BOX[i];
      const tw = c.name.length * 10.5 + 14;
      s += `<path d="${gapRect(x0, 50, x1 - x0, 208, 11, 'top', c.cx - tw / 2, c.cx + tw / 2)}" fill="none" stroke="${GOLD}" stroke-width="2"/>`;
      s += text(c.cx, 56, c.name, { size: 16, fill: GOLD, weight: 700, ls: 1 });
      s += neon('neon' + i, c.cx, 94);
      const labels = ['Off', 'Static', c.flip, 'Chase', c.music, 'Man.'];
      DETENTS.forEach((a, k) => {
        const [dx, dy] = polar(c.cx, KY, DOT_R, a);
        s += `<circle cx="${f(dx)}" cy="${f(dy)}" r="4" fill="${k === 4 ? AMBER : '#f4f2ec'}"/>`;
        let lx, ly, anchor;
        if (k === 0) { lx = dx - 7; ly = dy + 5; anchor = 'end'; }
        else if (k === 1) { lx = dx - 9; ly = dy + 2; anchor = 'end'; }
        else if (k === 2) { lx = dx + 6; ly = dy - 11; anchor = 'end'; }
        else if (k === 3) { lx = dx - 6; ly = dy - 11; anchor = 'start'; }
        else if (k === 4) { lx = dx + 9; ly = dy + 2; anchor = 'start'; }
        else { lx = dx + 6; ly = dy + 5; anchor = 'start'; }
        s += text(lx, ly, labels[k], { size: k === 5 ? 11.5 : 12.5, anchor, fill: k === 4 ? AMBER : LBL, cls: 'hit', data: `data-ch="${i}" data-pos="${k}"` });
        s += `<circle class="hit" data-ch="${i}" data-pos="${k}" cx="${f(dx)}" cy="${f(dy)}" r="9" fill="transparent"/>`;
      });
    });

    // Manual flash wiring lines (drawn under the knobs)
    s += `<g fill="none" stroke="${CREAM}" stroke-width="2" stroke-linejoin="round">
      <path d="M${CH[0].cx} ${KY + 40}V${BTN_Y}H${BTN_X[0] - 27}"/>
      <path d="M${CH[1].cx + 30} ${KY + 38}L${BTN_X[1] - 12} ${BTN_Y - 23}"/>
      <path d="M${CH[2].cx - 30} ${KY + 38}L${BTN_X[2] + 12} ${BTN_Y - 23}"/>
      <path d="M${CH[3].cx} ${KY + 40}V${BTN_Y}H${BTN_X[3] + 27}"/>
    </g>`;
    CH.forEach((c, i) => { s += knob('knob' + i, c.cx, KY); });

    // Manual flash buttons
    BTN_X.forEach((x, i) => {
      s += `<g id="btn${i}">
        <rect x="${x - 27}" y="${BTN_Y - 23}" width="54" height="46" rx="3" fill="#0a0808" stroke="#3a332e"/>
        <g class="cap"><rect x="${x - 21}" y="${BTN_Y - 17}" width="42" height="34" rx="2" fill="url(#btn)" stroke="#5a1408"/>
        <rect x="${x - 17}" y="${BTN_Y - 14}" width="34" height="6" rx="2" fill="#fff" opacity=".18"/></g>
        <rect class="hit" data-btn="${i}" x="${x - 27}" y="${BTN_Y - 23}" width="54" height="46" fill="transparent"/>
      </g>`;
    });
    s += text(594, 393, 'MANUAL  FLASH', { size: 14, ls: 1.5, weight: 500 });

    // PULSAR logo
    s += text(30, 406, 'PULSAR', { size: 58, anchor: 'start', fill: '#f3eedf', weight: 700, ls: 2,
      font: LOGO_FONT, extra: ' filter="url(#inline)"' });

    // Power + chaser section
    s += text(SPEED.cx, 60, 'POWER', { size: 15, weight: 700, ls: 1 });
    s += neon('neonP', SPEED.cx, 94);
    s += `<path d="${gapRect(1016, 262, 288, 88, 11, 'bottom', 1124, 1196)}" fill="none" stroke="${CREAM}" stroke-width="2"/>`;
    s += text(1160, 356, 'CHASER', { size: 14, ls: 1.5, weight: 500 });
    for (let k = 0; k < 10; k++) {
      const [dx, dy] = polar(SPEED.cx, SPEED.cy, 72, SPEED.min + k * 30);
      s += `<circle cx="${f(dx)}" cy="${f(dy)}" r="4" fill="#f4f2ec"/>`;
    }
    s += text(SPEED.cx, 318, 'SPEED', { size: 12, fill: '#bdb7ab', ls: 1 });
    s += knob('speed', SPEED.cx, SPEED.cy);
    s += text(1235, 140, 'Music +', { size: 12.5, cls: 'hit', data: 'data-rock="program" data-pos="0"' });
    s += text(1235, 155, 'Auto Program', { size: 12.5, cls: 'hit', data: 'data-rock="program" data-pos="0"' });
    s += text(1287, 222, 'Program', { size: 11.5, cls: 'hit', data: 'data-rock="program" data-pos="1"' });
    s += text(1287, 236, 'Hold', { size: 11.5, cls: 'hit', data: 'data-rock="program" data-pos="1"' });
    s += text(1235, 300, 'Constant +', { size: 12.5, cls: 'hit', data: 'data-rock="program" data-pos="2"' });
    s += text(1235, 315, 'Auto Program', { size: 12.5, cls: 'hit', data: 'data-rock="program" data-pos="2"' });
    s += rocker('program', 1235, 170);

    s += text(1300, 395, 'ZERO 4000', { size: 46, anchor: 'end', weight: 400, fill: '#f3eedf', ls: 1, font: MODEL_FONT,
      extra: ' stroke="#f3eedf" stroke-width="1.2" stroke-linejoin="round"' });
    s += text(1300, 411, 'Resistive/Inductive Load. Auto -/+. \u25CB\u25CB\u25CB\u25CB/\u25CB\u25CB\u25CB\u25CB/\u25CB\u25CB\u25CB\u25CB',
      { size: 8.5, anchor: 'end', fill: '#e2dccf' });
    s += '</svg>';
    return s;
  }

  let created = false;
  function create(el, h) {
    // The panel adds window-level listeners (keys 1–4); creating it twice would stack them.
    if (created) throw new Error('ZeroPanel.create() called twice');
    created = true;
    el.innerHTML = build();
    const svg = el.querySelector('svg');
    const LEVELS = ['standby', 'shimmer', 'full'];
    const PROGS = ['music', 'hold', 'constant'];
    let panel = { level: 'full', program: 'music', speed: 0.5, ch: [3, 3, 3, 3], power: true };

    const svgPt = e => {
      const p = svg.createSVGPoint();
      p.x = e.clientX; p.y = e.clientY;
      return p.matrixTransform(svg.getScreenCTM().inverse());
    };

    function setKnobAngle(id, cx, cy, a) {
      svg.querySelector(`#${id} .ptr`).setAttribute('transform', `rotate(${f(a)} ${cx} ${cy})`);
    }
    function setRocker(id, pos) {
      const g = svg.querySelector('#' + id);
      g.querySelector('.top').setAttribute('fill', pos === 0 ? 'url(#rockDown)' : pos === 2 ? 'url(#rockUp)' : 'url(#rockFlat)');
      g.querySelector('.bot').setAttribute('fill', pos === 2 ? 'url(#rockDown)' : pos === 0 ? 'url(#rockUp)' : 'url(#rockFlat)');
      g.querySelector('.ridge').setAttribute('stroke-opacity', pos === 1 ? '.6' : '.15');
    }
    function render() {
      panel.ch.forEach((p, i) => setKnobAngle('knob' + i, CH[i].cx, KY, DETENTS[p]));
      setKnobAngle('speed', SPEED.cx, SPEED.cy, SPEED.min + panel.speed * (SPEED.max - SPEED.min));
      setRocker('level', LEVELS.indexOf(panel.level));
      setRocker('program', PROGS.indexOf(panel.program));
    }
    const change = p => { Object.assign(panel, p); render(); h.onChange && h.onChange(p); };
    const setCh = (i, pos) => {
      pos = Math.max(0, Math.min(5, pos));
      if (panel.ch[i] === pos) return;
      const ch = panel.ch.slice(); ch[i] = pos;
      change({ ch });
    };

    // Clicks on labels, dots and rockers
    svg.addEventListener('click', e => {
      const t = e.target.closest('[data-ch],[data-rock]');
      if (!t) return;
      if (t.dataset.ch != null) setCh(+t.dataset.ch, +t.dataset.pos);
      else if (t.dataset.rock === 'level') change({ level: LEVELS[+t.dataset.pos] });
      else change({ program: PROGS[+t.dataset.pos] });
    });

    // Knob dragging
    let drag = null;
    svg.addEventListener('pointerdown', e => {
      const k = e.target.closest('[data-knob]');
      const b = e.target.closest('[data-btn]');
      if (b) {
        const i = +b.dataset.btn;
        b.setPointerCapture(e.pointerId);
        press(i, true);
        const up = () => { press(i, false); b.removeEventListener('pointerup', up); b.removeEventListener('pointercancel', up); };
        b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
        e.preventDefault();
        return;
      }
      if (!k) return;
      drag = { id: k.dataset.knob, el: k };
      k.setPointerCapture(e.pointerId);
      k.style.cursor = 'grabbing';
      onDrag(e);
      e.preventDefault();
    });
    svg.addEventListener('pointermove', e => { if (drag) onDrag(e); });
    const endDrag = () => { if (drag) { drag.el.style.cursor = ''; drag = null; } };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);

    function onDrag(e) {
      const p = svgPt(e);
      if (drag.id === 'speed') {
        const a = Math.atan2(p.x - SPEED.cx, SPEED.cy - p.y) * 180 / Math.PI;
        if (Math.abs(a) > 160) return; // dead zone at the bottom
        const v = (Math.max(SPEED.min, Math.min(SPEED.max, a)) - SPEED.min) / (SPEED.max - SPEED.min);
        change({ speed: Math.round(v * 1000) / 1000 });
      } else {
        const i = +drag.id.slice(4);
        const a = Math.atan2(p.x - CH[i].cx, KY - p.y) * 180 / Math.PI;
        let best = 0;
        DETENTS.forEach((d, k) => { if (Math.abs(d - a) < Math.abs(DETENTS[best] - a)) best = k; });
        setCh(i, best);
      }
    }

    svg.addEventListener('wheel', e => {
      const k = e.target.closest('[data-knob]');
      if (!k) return;
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      if (k.dataset.knob === 'speed') change({ speed: Math.max(0, Math.min(1, Math.round((panel.speed + dir * 0.02) * 100) / 100)) });
      else { const i = +k.dataset.knob.slice(4); setCh(i, panel.ch[i] + dir); }
    }, { passive: false });

    const btnState = [false, false, false, false];
    function press(i, down) {
      if (btnState[i] === down) return;
      btnState[i] = down;
      showButton(i, down);
      h.onButton && h.onButton(i, down);
    }
    function showButton(i, down) {
      const cap = svg.querySelector(`#btn${i} .cap`);
      cap.setAttribute('transform', down ? 'translate(0 1.5)' : '');
      cap.firstElementChild.setAttribute('fill', down ? 'url(#btnDown)' : 'url(#btn)');
    }
    window.addEventListener('keydown', e => {
      if (e.repeat || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      const i = '1234'.indexOf(e.key);
      if (i >= 0) press(i, true);
    });
    window.addEventListener('keyup', e => { const i = '1234'.indexOf(e.key); if (i >= 0) press(i, false); });
    window.addEventListener('blur', () => btnState.forEach((d, i) => d && press(i, false)));

    function setNeon(id, v) {
      const g = svg.querySelector('#' + id);
      g.querySelector('.lit').setAttribute('opacity', f(v));
      g.querySelector('.glow').setAttribute('opacity', f(v * 0.9));
    }

    render();
    return {
      setPanel(p) { panel = { ...panel, ...p, ch: (p.ch || panel.ch).slice() }; render(); },
      setNeons(levels, power) { levels.forEach((v, i) => setNeon('neon' + i, v)); setNeon('neonP', power ? 1 : 0); },
      setButtons(b) { b.forEach((d, i) => { if (!btnState[i]) showButton(i, d); }); },
      get panel() { return panel; },
    };
  }

  window.ZeroPanel = { create };
})();
