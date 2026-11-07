'use strict';
/*
 * Strict validation of everything that arrives from a browser (or from the saved settings file).
 *
 * The config is never merged recursively. Each incoming value is checked against an explicit schema and
 * copied into a fresh object. Only known properties are read (via hasOwnProperty), so unknown keys,
 * including "__proto__", "constructor" and "prototype", are ignored. Values that fail a check are rejected
 * (the current value is kept) and reported back, so the UI can show what wasn't accepted.
 */
const net = require('net');
const { ORDERS, parseHost } = require('./outputs');
const { isPrivateIPv4 } = require('./netcheck');

const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = o => o !== null && typeof o === 'object' && !Array.isArray(o);

/* ---------- field validators: return { ok: true, value } or { ok: false, why } ---------- */
const ok = value => ({ ok: true, value });
const bad = why => ({ ok: false, why });

const bool = () => v => (typeof v === 'boolean' ? ok(v) : bad('must be true or false'));
const int = (min, max) => v => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max ? ok(n) : bad(`must be a whole number from ${min} to ${max}`);
};
const num = (min, max) => v => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max ? ok(n) : bad(`must be a number from ${min} to ${max}`);
};
const oneOf = list => v => {
  const hit = list.find(x => x === v || (typeof x === 'number' && typeof v === 'string' && String(x) === v));
  return hit !== undefined ? ok(hit) : bad(`must be one of: ${list.join(', ')}`);
};
const colour = () => v => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? ok(v.toLowerCase()) : bad('must be a colour like #ff8000'));
// DMX address lists such as "1, 5, 9-12" (digits, commas, dashes, spaces only; bounded length)
const addrList = () => v => {
  if (typeof v !== 'string' || v.length > 400) return bad('must be a short list of addresses like 1, 5, 9-12');
  const t = v.trim();
  if (!/^[0-9,;\s-]*$/.test(t)) return bad('may only contain numbers, commas and dashes, e.g. 1, 5, 9-12');
  for (const part of t.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d{1,3})(?:-(\d{1,3}))?$/.exec(part);
    if (!m || +m[1] < 1 || +m[1] > 512 || (m[2] && (+m[2] < 1 || +m[2] > 512))) return bad(`"${part}" isn't a DMX address from 1 to 512`);
  }
  return ok(t);
};
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;
// Destination host: empty, an IPv4 address or a DNS / mDNS name. Pasted URLs ("http://x/") and "host:port" are tidied.
const host = () => v => {
  if (typeof v !== 'string' || v.length > 300) return bad('must be an IP address or device name');
  if (v.trim() === '') return ok('');
  const p = parseHost(v, 0);
  if (net.isIPv4(p.host) || HOSTNAME.test(p.host)) return ok(p.port && !/^[a-z]+:\/\//i.test(v.trim()) ? `${p.host}:${p.port}` : p.host);
  return bad('must be an IP address (like 192.168.1.60) or a device name (like wled-abc.local)');
};
const text = maxLen => v => {
  if (typeof v !== 'string') return bad('must be text');
  // strip control characters; keep it short
  const t = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return t && t.length <= maxLen ? ok(t) : bad(`must be 1 to ${maxLen} characters`);
};
const arrayOf = (len, item) => v => {
  if (!Array.isArray(v) || v.length !== len) return bad(`must be a list of ${len}`);
  const out = [];
  for (let i = 0; i < len; i++) {
    const r = item(v[i]);
    if (!r.ok) return bad(`item ${i + 1} ${r.why}`);
    out.push(r.value);
  }
  return ok(out);
};
const object = shape => v => {
  if (!isPlainObject(v)) return bad('must be an object');
  const out = {};
  for (const k of Object.keys(shape)) {
    if (!own(v, k)) return bad(`is missing "${k}"`);
    const r = shape[k](v[k]);
    if (!r.ok) return bad(`${k} ${r.why}`);
    out[k] = r.value;
  }
  return ok(out);
};

// A fixed-length list of records (patch rows, filter bands), checked field by field. A field that's missing
// keeps its current value (so settings saved by older versions, which lack newer fields, still load), and an
// invalid field is rejected on its own without throwing away the rest of the list.
const rows = (len, shape) => ({ rows: len, shape });

/* ---------- the config schema ---------- */
const DDP_DEST_IDS = Array.from({ length: 255 }, (_, i) => i + 1).filter(n => ![246, 250, 251].includes(n)); // skip DDP control/config/status ids
const CONFIG_SCHEMA = {
  emulation: {
    mainsHz: oneOf([50, 60]),
    lampSim: bool(),
    lampRiseMs: int(1, 2000),
    lampFallMs: int(1, 2000),
    trebleInhibit: bool(),
    remoteFull: bool(),
  },
  colors: arrayOf(4, colour()),
  output: {
    fps: int(1, 120),
    master: num(0, 1),
    allowPublic: bool(),
  },
  audio: {
    trimDb: num(-24, 24),
    sens: num(0, 1),
    slope: oneOf([1, 2, 4]),
    filters: rows(4, { hp: num(0, 20000), lp: num(0, 20000) }),
  },
  sacn: {
    enabled: bool(),
    mode: oneOf(['multicast', 'unicast']),
    host: host(),
    universe: int(1, 63999),
    priority: int(0, 200),
    patch: rows(4, { dimmer: addrList(), rgb: addrList(), order: oneOf(ORDERS) }),
  },
  ddp: {
    enabled: bool(),
    host: host(),
    port: int(1, 65535),
    pixelsPerChannel: int(1, 1000),
    repeat: int(1, 100),
    startPixel: int(0, 100000),
    destId: oneOf(DDP_DEST_IDS),
    order: oneOf(ORDERS),
  },
};

/*
 * Apply an untrusted partial config on top of `current` (which is already valid).
 * Returns { config, rejected: ["ddp.port must be …", …] }. `current` is not modified.
 */
function applyConfig(current, partial) {
  const config = JSON.parse(JSON.stringify(current));
  const rejected = [];
  if (!isPlainObject(partial)) return { config, rejected: partial === undefined ? [] : ['settings must be an object'] };
  for (const section of Object.keys(CONFIG_SCHEMA)) {
    if (!own(partial, section)) continue;
    const spec = CONFIG_SCHEMA[section], val = partial[section];
    if (typeof spec === 'function') { // whole-value field (e.g. colors)
      const r = spec(val);
      if (r.ok) config[section] = r.value; else rejected.push(`${section} ${r.why}`);
      continue;
    }
    if (!isPlainObject(val)) { rejected.push(`${section} must be an object`); continue; }
    for (const key of Object.keys(spec)) {
      if (!own(val, key)) continue;
      const field = spec[key];
      if (field && field.rows) { // list of records, merged field by field
        const list = val[key];
        if (!Array.isArray(list)) { rejected.push(`${section}.${key} must be a list`); continue; }
        const cur = config[section][key];
        for (let i = 0; i < field.rows && i < list.length; i++) {
          const item = list[i];
          if (!isPlainObject(item)) { rejected.push(`${section}.${key} item ${i + 1} must be an object`); continue; }
          for (const f of Object.keys(field.shape)) {
            if (!own(item, f)) continue; // missing: keep the current / default value
            const r = field.shape[f](item[f]);
            if (r.ok) cur[i][f] = r.value; else rejected.push(`${section}.${key} item ${i + 1} ${f} ${r.why}`);
          }
        }
        continue;
      }
      const r = field(val[key]);
      if (r.ok) config[section][key] = r.value; else rejected.push(`${section}.${key} ${r.why}`);
    }
  }
  // "host:port" typed into the DDP box sets the port too
  const m = /^(.*):(\d{1,5})$/.exec(config.ddp.host || '');
  if (m && net.isIPv4(m[1]) || (m && HOSTNAME.test(m[1]))) { config.ddp.host = m[1]; config.ddp.port = Math.min(65535, +m[2]) || config.ddp.port; }
  if (/:\d+$/.test(config.sacn.host || '')) config.sacn.host = config.sacn.host.replace(/:\d+$/, '');
  return { config, rejected };
}

/* ---------- other messages ---------- */
const PANEL_SCHEMA = {
  power: bool(),
  level: oneOf(['standby', 'shimmer', 'full']),
  program: oneOf(['music', 'hold', 'constant']),
  speed: num(0, 1),
  ch: arrayOf(4, int(0, 5)),
};
function cleanPanel(p) {
  const out = {};
  if (!isPlainObject(p)) return out;
  for (const k of Object.keys(PANEL_SCHEMA)) {
    if (!own(p, k)) continue;
    const r = PANEL_SCHEMA[k](p[k]);
    if (r.ok) out[k] = r.value;
  }
  return out;
}

const finite01 = v => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
// Detector data: four booleans / numbers per band, clamped
function cleanMusic(m) {
  const four = (a, f) => (Array.isArray(a) && a.length === 4 ? a.map(f) : null);
  const on = four(m.on, v => v === true), drive = four(m.drive, finite01);
  if (!on || !drive) return null;
  return { on, drive };
}

const unitName = text(40);

module.exports = { applyConfig, cleanPanel, cleanMusic, unitName, isPrivateIPv4, CONFIG_SCHEMA };
