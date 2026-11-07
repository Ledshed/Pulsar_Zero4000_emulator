#!/usr/bin/env node
'use strict';
/*
 * Pulsar Zero 4000 emulator — server.
 *   node server.js [--port 8040] [--host 127.0.0.1] [--data <folder>] [--no-open]
 * Runs one or more emulated units, serves the front panel UI at /u/<id>/, and sends DDP / sACN.
 * No external dependencies. Can be packaged as a single executable (see build/).
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { Zero4000, DEFAULT_EMU_OPTS } = require('./emulator');
const { SacnSender, DdpSender, parseAddresses, parseHost } = require('./outputs');
const { probeWled, localIPv4s, isPrivateIPv4, sameSubnet } = require('./netcheck');
const { applyConfig, cleanPanel, cleanMusic, unitName } = require('./validate');
const { WsConnection, acceptKey } = require('./wsproto');

const APP_ID = 'pulsar-zero4000';
const VERSION = '1.4.0';
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const flag = n => args.includes('--' + n);
const BASE_PORT = +arg('port', process.env.PORT || 8040);
// Listens on this computer only. --host (developers) can override it; the page token is still required.
const HOST_ARG = arg('host', null);
const OPEN_BROWSER = !flag('no-open');
const startupWarnings = [];
const MAX_UNITS = 32;
const MAX_WS_CLIENTS = 64;
// Random per-run secret. The page gets it (only same-origin pages can read it) and must present it to connect.
const INSTANCE_TOKEN = crypto.randomBytes(24).toString('hex');
let listenPort = BASE_PORT;
let httpServer = null;
let boundHost = '127.0.0.1';

/* ---------------- where settings live ---------------- */
function defaultDataDir() {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Pulsar Zero 4000');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Pulsar Zero 4000');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_ID);
}
const DATA_DIR = path.resolve(arg('data', defaultDataDir()));
const UNITS_FILE = path.join(DATA_DIR, 'units.json');
// Lets a newer copy of the app ask this one to quit (readable only by this user).
const INSTANCE_FILE = path.join(DATA_DIR, 'instance.json');

/* ---------------- static files (from disk, or embedded in the executable) ---------------- */
let sea = null;
try { sea = require('node:sea'); if (!sea.isSea()) sea = null; } catch (_) { sea = null; }
const PUBLIC = path.join(__dirname, 'public');
function readAsset(rel) {
  if (sea) { try { return Buffer.from(sea.getAsset('public/' + rel)); } catch (_) { return null; } }
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return null;
  try { return fs.readFileSync(file); } catch (_) { return null; }
}

/* ---------------- configuration ---------------- */
const ORIGINAL_FILTERS = [{ hp: 0, lp: 106 }, { hp: 360, lp: 530 }, { hp: 1450, lp: 2100 }, { hp: 3600, lp: 0 }];
const DEFAULT_CONFIG = {
  emulation: { ...DEFAULT_EMU_OPTS },
  colors: ['#ff2a1a', '#ffb000', '#20e040', '#2060ff'], // Bass, Tenor, Alto, Treble lamps
  output: { fps: 40, master: 1, allowPublic: false },
  audio: { trimDb: 0, sens: 0.5, slope: 1, filters: ORIGINAL_FILTERS },
  sacn: {
    enabled: true, mode: 'multicast', host: '', universe: 1, priority: 100, sourceName: 'Pulsar Zero 4000',
    patch: [{ dimmer: '1', rgb: '', order: 'RGB' }, { dimmer: '2', rgb: '', order: 'RGB' }, { dimmer: '3', rgb: '', order: 'RGB' }, { dimmer: '4', rgb: '', order: 'RGB' }],
  },
  ddp: { enabled: false, host: '', port: 4048, pixelsPerChannel: 30, repeat: 1, startPixel: 0, destId: 1, order: 'RGB' },
};

const clone = o => JSON.parse(JSON.stringify(o));

/* ---------------- a unit = one emulated Zero 4000 ---------------- */
const units = new Map(); // id → Unit

class Unit {
  constructor(id, name, savedConfig, savedPanel) {
    this.id = id;
    this.name = name;
    // saved settings go through the same validation as anything from a browser
    const r = applyConfig(DEFAULT_CONFIG, savedConfig || {});
    this.config = r.config;
    if (r.rejected.length) console.log(`${name}: ignored invalid saved settings: ${r.rejected.join('; ')}`);
    const sn = savedConfig && savedConfig.sacn && unitName(savedConfig.sacn.sourceName || '');
    this.config.sacn.sourceName = sn && sn.ok ? sn.value.slice(0, 63) : DEFAULT_CONFIG.sacn.sourceName;
    this.emu = new Zero4000(this.config.emulation);
    if (savedPanel) this.emu.setPanel(savedPanel);
    this.sacn = new SacnSender();
    this.ddp = new DdpSender();
    this.outTap = this.emu.createTap();
    this.uiTap = this.emu.createTap();
    this.levels = [0, 0, 0, 0];
    this.clients = new Set();
    this.lastMusicAt = 0;
    this.ddpTestUntil = 0;
    this.wled = null;      // last WLED check result
    this.wledBusy = false;
    this.startOutput();
  }

  startOutput() {
    clearInterval(this.outTimer);
    const fps = Math.max(1, Math.min(120, +this.config.output.fps || 40));
    this.outTimer = setInterval(() => {
      const { lamp } = this.emu.readTap(this.outTap);
      const m = Math.max(0, Math.min(1, +this.config.output.master));
      this.levels = lamp.map(v => v * m);
      const allowPublic = this.config.output.allowPublic;
      if (this.config.sacn.enabled) this.sacn.send({ ...this.config.sacn, allowPublic }, this.levels, this.config.colors);
      if (Date.now() < this.ddpTestUntil) this.ddp.send({ ...this.config.ddp, allowPublic }, [1, 1, 1, 1], ['#ffffff', '#ffffff', '#ffffff', '#ffffff']);
      else if (this.config.ddp.enabled) this.ddp.send({ ...this.config.ddp, allowPublic }, this.levels, this.config.colors);
    }, 1000 / fps);
  }

  // When an output is switched off or re-targeted, black out / release the old target so lights don't freeze.
  stopChangedOutputs(a, b) {
    const sTarget = c => `${c.mode}|${c.host}|${c.universe}`;
    if (a.sacn.enabled && (!b || !b.sacn.enabled || sTarget(a.sacn) !== sTarget(b.sacn))) this.sacn.stop({ ...a.sacn, allowPublic: a.output.allowPublic });
    const dTarget = c => `${c.host}|${c.port}|${c.destId}|${c.startPixel}`;
    if (a.ddp.enabled && (!b || !b.ddp.enabled || dTarget(a.ddp) !== dTarget(b.ddp))) this.ddp.stop({ ...a.ddp, allowPublic: a.output.allowPublic });
    if (b && !b.ddp.enabled) this.ddp.lastError = null;
    if (b && !b.sacn.enabled) this.sacn.lastError = null;
  }

  // Returns the list of rejected settings (empty if everything was accepted).
  setConfig(partial) {
    const before = clone(this.config);
    const { config, rejected } = applyConfig(this.config, partial);
    config.sacn.sourceName = before.sacn.sourceName;
    this.config = config;
    this.stopChangedOutputs(before, this.config);
    this.emu.setOptions(this.config.emulation);
    if (before.output.fps !== this.config.output.fps) this.startOutput();
    return rejected;
  }

  shutdown() {
    clearInterval(this.outTimer);
    this.stopChangedOutputs(this.config, null);
  }

  broadcast(obj) { const t = JSON.stringify(obj); for (const c of this.clients) c.ws.sendText(t); }

  summary() {
    return { id: this.id, name: this.name, universe: this.config.sacn.universe, sacn: this.config.sacn.enabled, ddp: this.config.ddp.enabled ? this.config.ddp.host : '' };
  }
}

/* ---------------- persistence ---------------- */
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}
const wantHost = () => HOST_ARG || '127.0.0.1';

function saveNow() {
  const data = { app: APP_ID, version: VERSION, units: [...units.values()].map(u => ({ id: u.id, name: u.name, config: u.config, panel: u.emu.panel })) };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(UNITS_FILE + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(UNITS_FILE + '.tmp', UNITS_FILE);
  } catch (e) { console.error('Could not save settings:', e.message); }
}

function nextUnitId() {
  let n = 1;
  while (units.has(String(n))) n++;
  return String(n);
}

function addUnit() {
  if (units.size >= MAX_UNITS) return null;
  const id = nextUnitId();
  // Start the new unit on its own sACN universe so it doesn't fight the others.
  const maxUni = Math.max(0, ...[...units.values()].map(u => u.config.sacn.universe | 0));
  const first = units.values().next().value;
  const cfg = clone(DEFAULT_CONFIG);
  if (first) cfg.colors = first.config.colors.slice();
  cfg.sacn.universe = maxUni + 1;
  const u = new Unit(id, `Unit ${id}`, cfg, null);
  units.set(id, u);
  persist();
  broadcastUnits();
  return u;
}

function loadUnits() {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(UNITS_FILE, 'utf8')); } catch (_) {}
  if (saved && Array.isArray(saved.units) && saved.units.length) {
    for (const s of saved.units) units.set(String(s.id), new Unit(String(s.id), s.name || `Unit ${s.id}`, s.config, s.panel));
  } else {
    // First run (or v1 single-unit state.json given with --state)
    let legacy = null;
    const legacyFile = arg('state') || (!sea && fs.existsSync(path.join(__dirname, 'state.json')) ? path.join(__dirname, 'state.json') : null);
    if (legacyFile) { try { legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8')); } catch (_) {} }
    units.set('1', new Unit('1', 'Unit 1', legacy && legacy.config, legacy && legacy.panel));
    persist();
  }
}

/* ---------------- clashes between units ---------------- */
function usedAddresses(cfg) {
  const s = new Set();
  for (const r of cfg.sacn.patch || []) {
    for (const a of parseAddresses(r.dimmer)) s.add(a);
    const fp = (r.order || 'RGB').length;
    for (const a of parseAddresses(r.rgb)) for (let k = 0; k < fp; k++) if (a + k <= 512) s.add(a + k);
  }
  return s;
}
function ddpRange(cfg) {
  const d = cfg.ddp;
  const start = d.startPixel | 0;
  return [start, start + (d.pixelsPerChannel | 0) * 4 * Math.max(1, d.repeat | 0)];
}
function clashesFor(u) {
  const out = [];
  for (const o of units.values()) {
    if (o === u) continue;
    const a = u.config, b = o.config;
    if (a.sacn.enabled && b.sacn.enabled && (a.sacn.universe | 0) === (b.sacn.universe | 0)) {
      const sa = usedAddresses(a), sb = usedAddresses(b);
      const shared = [...sa].filter(x => sb.has(x));
      if (shared.length) out.push(`${o.name}: sACN universe ${a.sacn.universe}, ${shared.length} shared address${shared.length > 1 ? 'es' : ''}`);
    }
    if (a.ddp.enabled && b.ddp.enabled && a.ddp.host && a.ddp.host === b.ddp.host && (a.ddp.port | 0) === (b.ddp.port | 0)) {
      const [s1, e1] = ddpRange(a), [s2, e2] = ddpRange(b);
      if (s1 < e2 && s2 < e1) out.push(`${o.name}: DDP ${a.ddp.host}, overlapping pixels`);
    }
  }
  return out;
}

function broadcastUnits() {
  const list = [...units.values()].map(u => u.summary());
  for (const u of units.values()) u.broadcast({ t: 'units', units: list, self: u.id, name: u.name, clashes: clashesFor(u) });
}

/* ---------------- simulation clock ---------------- */
let last = process.hrtime.bigint();
setInterval(() => {
  const now = process.hrtime.bigint();
  const dt = Number(now - last) / 1e9;
  last = now;
  const t = Date.now();
  for (const u of units.values()) {
    if (t - u.lastMusicAt > 300) u.emu.clearMusic();
    u.emu.advance(dt);
  }
}, 4);

/* ---------------- ask WLED what it's receiving ---------------- */
setInterval(() => {
  for (const u of units.values()) {
    const testing = Date.now() < u.ddpTestUntil;
    if ((!u.config.ddp.enabled && !testing) || u.wledBusy) { if (!u.config.ddp.enabled && !testing) u.wled = null; continue; }
    if (!u.clients.size) continue; // only while someone is looking at this unit
    const t = u.ddp.target({ ...u.config.ddp, allowPublic: u.config.output.allowPublic });
    if (t.error) { u.wled = null; continue; }
    // Only ask devices on this computer's own local network; never probe anything further away.
    if (!isPrivateIPv4(t.ip) || !sameSubnet(t.ip)) {
      u.wled = { level: 'info', text: `${t.ip} isn't on this computer's local network, so it wasn't checked. Lighting devices are normally on the same network.` };
      continue;
    }
    u.wledBusy = true;
    const d = u.config.ddp;
    probeWled(t.ip, {
      sending: Date.now() - u.ddp.lastSentAt < 1500,
      startPixel: d.startPixel | 0,
      totalPixels: (d.startPixel | 0) + (d.pixelsPerChannel | 0) * 4 * Math.max(1, d.repeat | 0),
    }).then(r => { u.wled = r; }, e => { u.wled = { level: 'info', text: 'WLED check failed: ' + e.message }; })
      .finally(() => { u.wledBusy = false; });
  }
}, 2000);

/* ---------------- UI state stream ---------------- */
setInterval(() => {
  for (const u of units.values()) {
    const { neon } = u.emu.readTap(u.uiTap);
    if (!u.clients.size) continue;
    u.broadcast({
      t: 'state',
      neon,
      out: u.levels,
      diag: u.emu.diag(),
      net: {
        sacn: u.config.sacn.enabled ? u.sacn.status() : null,
        ddp: u.config.ddp.enabled || Date.now() < u.ddpTestUntil ? u.ddp.status() : null,
        wled: u.wled,
        testing: Math.max(0, u.ddpTestUntil - Date.now()),
      },
    });
  }
}, 1000 / 30);

/* ---------------- request checks: Host (DNS rebinding), Origin, token ---------------- */
// Only names that really mean this computer are accepted in the Host header. A web page on another
// site can't use DNS tricks ("rebinding") to talk to us, because its Host header would be its own name.
function hostAllowed(hostHeader) {
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(String(hostHeader || ''));
  if (!m) return false;
  const name = m[1].toLowerCase(), port = m[2] ? +m[2] : 80;
  if (port !== listenPort) return false;
  if (name === 'localhost' || name === '127.0.0.1' || name === '[::1]') return true;
  return boundHost !== '127.0.0.1' && localIPv4s().some(a => a.address === name); // only with --host
}
// Browsers always send Origin on WebSocket connections. It must be this app's own page.
function originAllowed(req) {
  const origin = String(req.headers.origin || '').toLowerCase();
  return origin !== '' && origin === `http://${String(req.headers.host || '').toLowerCase()}`;
}
function tokenOk(t) {
  const a = Buffer.from(String(t || '')), b = Buffer.from(INSTANCE_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------- WebSocket connections ---------------- */
let wsCount = 0;
function wsSend(ws, obj) { ws.sendText(JSON.stringify(obj)); }
const reject = (sock, status) => { try { sock.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch (_) {} };

function handleUpgrade(req, sock) {
  sock.on('error', () => {});
  let url;
  try { url = new URL(req.url, 'http://x'); } catch (_) { return reject(sock, '400 Bad Request'); }
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || !key || !/^[A-Za-z0-9+/]{22}==$/.test(key) || req.headers['sec-websocket-version'] !== '13' ||
    !/websocket/i.test(req.headers.upgrade || '')) return reject(sock, '400 Bad Request');
  if (!hostAllowed(req.headers.host)) return reject(sock, '421 Misdirected Request');
  if (!originAllowed(req)) return reject(sock, '403 Forbidden');
  if (!tokenOk(url.searchParams.get('t'))) return reject(sock, '403 Forbidden');
  if (wsCount >= MAX_WS_CLIENTS) return reject(sock, '503 Service Unavailable');
  const unit = units.get(url.searchParams.get('unit') || '');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
  sock.setNoDelay(true);
  sock.setTimeout(0);
  wsCount++;
  const client = { unit, buttons: new Set() };
  client.ws = new WsConnection(sock, text => onMessage(client, text), () => {
    wsCount--;
    if (!client.unit || !client.unit.clients.delete(client)) return;
    for (const i of client.buttons) client.unit.emu.setButton(i, false);
  });
  if (!unit) { // unit was deleted (or never existed)
    wsSend(client.ws, { t: 'gone', units: [...units.values()].map(u => u.summary()) });
    client.ws.close(1000);
    return;
  }
  unit.clients.add(client);
  wsSend(client.ws, { t: 'hello', panel: unit.emu.panel, config: unit.config, version: VERSION, warnings: startupWarnings });
  broadcastUnits();
}

function onMessage(client, text) {
  let m;
  try { m = JSON.parse(text); } catch (_) { return; }
  if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return;
  const u = client.unit;
  if (!u || !units.has(u.id)) return;
  switch (m.t) {
    case 'panel':
      u.emu.setPanel(cleanPanel(m.panel));
      u.broadcast({ t: 'panel', panel: u.emu.panel });
      persist();
      break;
    case 'button': {
      if (!Number.isInteger(m.i) || m.i < 0 || m.i > 3) break;
      const down = m.down === true;
      u.emu.setButton(m.i, down);
      if (down) client.buttons.add(m.i); else client.buttons.delete(m.i);
      u.broadcast({ t: 'buttons', buttons: u.emu.buttons });
      break;
    }
    case 'music': {
      const mu = cleanMusic(m);
      if (!mu) break;
      u.emu.setMusic(mu.on, mu.drive); u.lastMusicAt = Date.now();
      break;
    }
    case 'config': {
      const rejected = u.setConfig(m.config);
      if (rejected.length) wsSend(client.ws, { t: 'rejected', items: rejected.slice(0, 10) });
      u.broadcast({ t: 'config', config: u.config });
      persist();
      broadcastUnits();
      break;
    }
    case 'rename': {
      const r = unitName(m.name);
      if (r.ok) { u.name = r.value; u.config.sacn.sourceName = `Pulsar Zero 4000 – ${r.value}`.slice(0, 63); persist(); broadcastUnits(); }
      else wsSend(client.ws, { t: 'rejected', items: ['name ' + r.why] });
      break;
    }
    case 'deleteUnit':
      if (units.size > 1) {
        u.shutdown();
        units.delete(u.id);
        u.broadcast({ t: 'gone', units: [...units.values()].map(x => x.summary()) });
        for (const c of u.clients) c.ws.close(1000);
        persist();
        broadcastUnits();
      }
      break;
    case 'ddpTest':
      u.ddp.lastError = null;
      u.ddpTestUntil = Date.now() + 5000;
      u.wled = null;
      break;
    case 'report':
      wsSend(client.ws, { t: 'report', text: report() });
      break;
    case 'quit':
      quit();
      break;
  }
}

function report() {
  const L = [];
  L.push(`Pulsar Zero 4000 ${VERSION} · ${sea ? 'packaged app' : 'source (node ' + process.version + ')'} · ${process.platform} ${os.release()} ${process.arch}`);
  L.push(`Port ${listenPort} · settings ${DATA_DIR}`);
  L.push('This computer: ' + (localIPv4s().map(a => `${a.address}/${a.netmask} (${a.name})`).join(', ') || 'no network addresses'));
  if (startupWarnings.length) L.push('Warnings: ' + startupWarnings.join(' | '));
  for (const u of units.values()) {
    const c = u.config, d = c.ddp, sa = c.sacn;
    L.push('');
    L.push(`[${u.name}] panel ${JSON.stringify(u.emu.panel)}`);
    L.push(`  sACN ${sa.enabled ? 'on' : 'off'}: ${sa.mode} ${sa.mode === 'unicast' ? JSON.stringify(sa.host) : ''} universe ${sa.universe} prio ${sa.priority} patch ${JSON.stringify(sa.patch)}`);
    L.push(`  sACN status: ${JSON.stringify(u.sacn.status())}`);
    L.push(`  DDP ${d.enabled ? 'on' : 'off'}: host ${JSON.stringify(d.host)} → ${JSON.stringify(parseHost(d.host, d.port || 4048))} ppc ${d.pixelsPerChannel} ×${d.repeat} start ${d.startPixel} id ${d.destId} order ${d.order}`);
    L.push(`  DDP status: ${JSON.stringify(u.ddp.status())} last sent ${u.ddp.lastSentAt ? Math.round((Date.now() - u.ddp.lastSentAt) / 100) / 10 + ' s ago' : 'never'}`);
    L.push(`  WLED check: ${u.wled ? `[${u.wled.level}] ${u.wled.text}` : 'not run'}${u.wled && u.wled.wled ? ' ' + JSON.stringify(u.wled.wled) : ''}`);
    L.push(`  levels ${u.levels.map(v => v.toFixed(2)).join(' ')} · audio ${Date.now() - u.lastMusicAt < 1000 ? 'receiving' : 'none'}`);
  }
  return L.join('\n');
}

function quit() {
  console.log('Stopping…');
  for (const u of units.values()) { u.broadcast({ t: 'quit' }); u.shutdown(); }
  saveNow();
  try { if (JSON.parse(fs.readFileSync(INSTANCE_FILE, 'utf8')).token === INSTANCE_TOKEN) fs.unlinkSync(INSTANCE_FILE); } catch (_) {}
  setTimeout(() => process.exit(0), 400);
}
process.on('SIGINT', quit);
process.on('SIGTERM', quit);

/* ---------------- HTTP ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain' };
// Sent with every response: no framing by other sites (clickjacking), no MIME sniffing, no referrer leaks
// and a content policy that only allows this app's own files.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "media-src 'self' blob:; font-src 'self'; connect-src 'self' ws: wss:; worker-src 'self' blob:; frame-ancestors 'none'; " +
    "base-uri 'none'; form-action 'none'; object-src 'none'",
};
function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function handleHttp(req, res) {
  let url;
  try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch (_) { send(res, 400, {}, ''); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, { Allow: 'GET, HEAD' }, ''); return; }
  // DNS-rebinding protection: the request must be addressed to this computer by a name we know.
  if (!hostAllowed(req.headers.host)) { send(res, 421, { 'Content-Type': 'text/plain' }, 'Misdirected request'); return; }
  if (url === '/api/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ app: APP_ID, version: VERSION }));
    return;
  }
  if (url === '/') {
    const first = units.keys().next().value;
    send(res, 302, { Location: `/u/${encodeURIComponent(first)}/` }, '');
    return;
  }
  if (url === '/new') {
    // Creating a unit needs the page's token, so another website can't do it with a hidden link.
    if (!tokenOk(new URL(req.url, 'http://x').searchParams.get('t'))) { send(res, 403, { 'Content-Type': 'text/plain' }, 'Forbidden'); return; }
    const u = addUnit();
    if (!u) { send(res, 429, { 'Content-Type': 'text/plain' }, `You already have the maximum of ${MAX_UNITS} units.`); return; }
    send(res, 302, { Location: `/u/${u.id}/`, 'Cache-Control': 'no-store' }, '');
    return;
  }
  let rel = null;
  const m = /^\/u\/([^/]+)(\/.*)?$/.exec(url);
  if (m) {
    if (!/^[0-9]{1,4}$/.test(m[1])) { send(res, 404, {}, 'not found'); return; }
    if (!m[2]) { send(res, 302, { Location: `/u/${m[1]}/` }, ''); return; }
    rel = m[2] === '/' ? 'index.html' : m[2].slice(1);
  } else rel = url.slice(1);
  if (rel.includes('..') || rel.includes('\\') || rel.includes('\0')) { send(res, 403, {}, ''); return; }
  let data = readAsset(rel);
  if (!data) { send(res, 404, {}, 'not found'); return; }
  if (rel === 'index.html') {
    // hand the per-run token to our own page; other sites can't read it (same-origin policy)
    data = Buffer.from(data.toString('utf8').replace('{{TOKEN}}', INSTANCE_TOKEN));
    send(res, 200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' }, data);
    return;
  }
  send(res, 200, { 'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }, data);
}

/* ---------------- start-up: single instance, free port, open browser ---------------- */
function openBrowser(url) {
  if (!OPEN_BROWSER) return;
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  execFile(cmd[0], cmd[1], { windowsHide: true }, () => {});
}

function pingOurs(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 800 }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body).app === APP_ID); } catch (_) { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function listenOn(server, port, host = wantHost()) {
  return new Promise((resolve, reject) => {
    const onErr = e => { server.removeListener('listening', onOk); reject(e); };
    const onOk = () => { server.removeListener('error', onErr); resolve(); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, host);
  });
}

// Ask an older running copy of this app to quit (over its WebSocket), so it stops driving the lights.
// Ask an older running copy of this app to quit, so it stops driving the lights. Copies from 1.2.2 on need the
// token they wrote to instance.json in the settings folder (only this user can read it).
function askToQuit(port) {
  let token = '';
  try { const inst = JSON.parse(fs.readFileSync(INSTANCE_FILE, 'utf8')); if (inst.port === port) token = String(inst.token || ''); } catch (_) {}
  return new Promise(resolve => {
    const hostHdr = `127.0.0.1:${port}`;
    http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000, headers: { Host: hostHdr } }, res => {
      res.resume();
      const m = /\/u\/([^/]+)\//.exec(res.headers.location || '');
      const unit = m ? m[1] : '1';
      const sock = require('net').connect(port, '127.0.0.1', () => {
        sock.write(`GET /ws?unit=${encodeURIComponent(unit)}&t=${encodeURIComponent(token)} HTTP/1.1\r\nHost: ${hostHdr}\r\n` +
          `Origin: http://${hostHdr}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let sent = false;
      sock.on('data', () => {
        if (sent) return;
        sent = true;
        const p = Buffer.from(JSON.stringify({ t: 'quit' })), mask = crypto.randomBytes(4);
        for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
        sock.write(Buffer.concat([Buffer.from([0x81, 0x80 | p.length]), mask, p]));
        setTimeout(() => { sock.destroy(); resolve(); }, 300);
      });
      sock.on('error', () => resolve());
      setTimeout(resolve, 2500);
    }).on('error', () => resolve());
  });
}

function pingInfo(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 800 }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => { try { const j = JSON.parse(body); resolve(j.app === APP_ID ? j : null); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Is an old (v1, started from source) Pulsar Zero 4000 on this port? It has no /api/ping.
function isOldV1(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/panel.js', timeout: 800 }, res => {
      let body = '';
      res.on('data', d => { if (body.length < 4000) body += d; });
      res.on('end', () => resolve(res.statusCode === 200 && body.includes('ZeroPanel')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function main() {
  console.log(`Pulsar Zero 4000 emulator ${VERSION}`);
  for (let port = BASE_PORT; port < BASE_PORT + 30; port++) {
    const running = await pingInfo(port);
    if (running && running.version === VERSION) {
      // Already running: just open another browser tab on it.
      console.log(`Already running on port ${port}; opening it in your browser.`);
      openBrowser(`http://localhost:${port}/`);
      setTimeout(() => process.exit(0), 500);
      return;
    }
    if (running) {
      console.log(`An older version (${running.version}) is running on port ${port}; stopping it so it can't fight over the lights.`);
      await askToQuit(port);
      for (let i = 0; i < 20 && await pingInfo(port); i++) await new Promise(r => setTimeout(r, 250));
      if (await pingInfo(port)) {
        startupWarnings.push(`An older Pulsar Zero 4000 (version ${running.version}) is still running on port ${port} and may also be sending to your lights. Close it.`);
        continue;
      }
    } else if (await isOldV1(port)) {
      startupWarnings.push(`An older Pulsar Zero 4000 (started with "node server.js") is still running on port ${port}, and is probably still sending to your lights, so they get two streams. Close that window (or press Ctrl+C in it), then restart this program.`);
      console.log('WARNING: ' + startupWarnings[startupWarnings.length - 1]);
    }
    const server = http.createServer({ maxHeaderSize: 8192 }, handleHttp);
    server.headersTimeout = 10000;   // slow-header protection
    server.requestTimeout = 15000;   // (Node 18+; ignored on the Windows 7 build's older Node)
    server.keepAliveTimeout = 5000;
    server.maxConnections = 200;
    server.on('upgrade', handleUpgrade);
    try {
      await listenOn(server, port);
    } catch (e) {
      if (e.code === 'EADDRINUSE') continue;
      throw e;
    }
    httpServer = server;
    boundHost = wantHost();
    listenPort = port;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(INSTANCE_FILE, JSON.stringify({ app: APP_ID, version: VERSION, port, pid: process.pid, token: INSTANCE_TOKEN }), { mode: 0o600 });
    } catch (_) {}
    if (port !== BASE_PORT && !startupWarnings.length) startupWarnings.push(`Port ${BASE_PORT} is used by another program, so this copy is on port ${port}.`);
    loadUnits();
    const url = `http://localhost:${port}/`;
    console.log('');
    console.log(`  Front panel:  ${url}`);
    console.log(`  Settings:     ${DATA_DIR}`);
    console.log('');
    console.log('  Leave this window open while you use it. Close it (or use Unit ▸ Quit) to stop.');
    openBrowser(url);
    return;
  }
  console.error(`No free port found between ${BASE_PORT} and ${BASE_PORT + 29}.`);
  process.exit(1);
}

main();
