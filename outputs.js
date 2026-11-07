'use strict';
const dgram = require('dgram');
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const { isPrivateIPv4 } = require('./netcheck');

// Lighting data only goes to the local network unless the user explicitly allows internet addresses.
const publicRefusal = ip => `refusing to send to ${ip}: that's an internet address, not one on your local network. ` +
  `(If you really need this, tick "Allow internet addresses" in Outputs.)`;

/* ---------------- host names ---------------- */
// Accepts what people paste: "http://192.168.1.60/", "192.168.1.60:4048", "wled-abc.local/" …
function parseHost(input, defPort) {
  let h = String(input || '').trim();
  const isUrl = /^[a-z]+:\/\//i.test(h); // a pasted web address: its port is the web page's, not ours
  h = h.replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '');
  let port = defPort;
  const m = /^(.*):(\d{1,5})$/.exec(h);
  if (m && !h.includes('::')) { h = m[1]; if (!isUrl) port = +m[2]; }
  return { host: h.replace(/^\[|\]$/g, ''), port };
}

// Minimal mDNS (multicast DNS) A-record lookup for "*.local", for systems where the OS resolver can't.
function mdnsLookup(name, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const labels = name.replace(/\.$/, '').split('.');
    const q = Buffer.concat([
      Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
      ...labels.map(l => Buffer.concat([Buffer.from([Buffer.byteLength(l)]), Buffer.from(l)])),
      Buffer.from([0, 0, 1, 0x80, 1]), // type A, class IN + "unicast response" bit
    ]);
    const done = (err, ip) => { clearTimeout(timer); try { sock.close(); } catch (_) {} err ? reject(err) : resolve(ip); };
    const timer = setTimeout(() => done(new Error('no reply')), timeoutMs);
    const readName = (buf, off) => { // skip a (possibly compressed) name, return offset after it
      while (off < buf.length) { const len = buf[off]; if (len === 0) return off + 1; if ((len & 0xc0) === 0xc0) return off + 2; off += len + 1; }
      return off;
    };
    sock.on('message', buf => {
      try {
        const qd = buf.readUInt16BE(4), an = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
        let off = 12;
        for (let i = 0; i < qd; i++) off = readName(buf, off) + 4;
        for (let i = 0; i < an && off < buf.length; i++) {
          off = readName(buf, off);
          const type = buf.readUInt16BE(off), rdlen = buf.readUInt16BE(off + 8);
          if (type === 1 && rdlen === 4) return done(null, [...buf.subarray(off + 10, off + 14)].join('.'));
          off += 10 + rdlen;
        }
      } catch (_) {}
    });
    sock.on('error', e => done(e));
    sock.bind(0, () => { try { sock.setMulticastTTL(255); } catch (_) {} sock.send(q, 5353, '224.0.0.251'); });
  });
}

// Resolves names once and caches them (re-checked every 30 s), instead of a DNS lookup per packet.
class HostCache {
  constructor() { this.map = new Map(); }
  get(host) {
    if (!host) return { error: 'no host set' };
    if (net.isIPv4(host)) return { ip: host };
    let e = this.map.get(host);
    const now = Date.now();
    if (!e || (now - e.at > 30000 && !e.busy)) {
      e = e || { ip: null, error: 'looking up ' + host + '…' };
      e.at = now; e.busy = true;
      this.map.set(host, e);
      dns.lookup(host, { family: 4 }, (err, ip) => {
        if (!err) { e.ip = ip; e.error = null; e.busy = false; return; }
        const fail = () => { e.busy = false; if (!e.ip) e.error = `can't find "${host}". Try its IP address instead`; };
        if (/\.local$/i.test(host)) mdnsLookup(host).then(ip2 => { e.ip = ip2; e.error = null; e.busy = false; }, fail);
        else fail();
      });
    }
    return e.ip ? { ip: e.ip } : { error: e.error };
  }
}
const hosts = new HostCache();

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const clamp8 = v => Math.max(0, Math.min(255, Math.round(v)));

const ORDERS = ['RGB', 'RBG', 'GRB', 'GBR', 'BRG', 'BGR', 'RGBW', 'GRBW', 'BGRW', 'WRGB'];
const validOrder = o => (ORDERS.includes(o) ? o : 'RGB');

// Colour (0..255 rgb, already scaled by level) → bytes in the fixture's channel order.
// For RGBW the white part is taken out of R, G and B and sent on W.
function colourBytes(rgb, order) {
  let [r, g, b] = rgb, w = 0;
  if (order.includes('W')) { w = Math.min(r, g, b); r -= w; g -= w; b -= w; }
  const v = { R: r, G: g, B: b, W: w };
  return [...order].map(c => clamp8(v[c]));
}

// "1, 5, 9-12" → [1,5,9,10,11,12] (DMX addresses 1..512)
function parseAddresses(str) {
  const out = [];
  for (const part of String(str || '').split(/[,\s;]+/)) {
    if (!part) continue;
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) continue;
    let a = +m[1], b = m[2] ? +m[2] : a;
    if (b < a) [a, b] = [b, a];
    for (let x = a; x <= b && out.length < 512; x++) if (x >= 1 && x <= 512) out.push(x);
  }
  return out;
}

// Build the 512-slot DMX frame from the patch: per channel, dimmer addresses and RGB fixture start addresses.
function buildDmx(patch, levels, colors) {
  const slots = Buffer.alloc(512);
  (patch || []).forEach((row, i) => {
    if (i > 3 || !row) return;
    const v = clamp8(255 * levels[i]);
    for (const a of parseAddresses(row.dimmer)) slots[a - 1] = Math.max(slots[a - 1], v);
    const bytes = colourBytes(hexToRgb(colors[i]).map(x => x * levels[i]), validOrder(row.order));
    for (const a of parseAddresses(row.rgb)) {
      bytes.forEach((v, k) => {
        const s = a - 1 + k;
        if (s < 512) slots[s] = Math.max(slots[s], v);
      });
    }
  });
  return slots;
}

/* ---------------- sACN / E1.31 ---------------- */
class SacnSender {
  constructor() {
    this.sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock.on('error', e => { this.lastError = e.message; });
    this.sock.bind(0, () => { try { this.sock.setMulticastTTL(8); } catch (_) {} });
    this.cid = crypto.randomBytes(16);
    this.seq = 0;
    this.lastError = null;
  }

  build(cfg, slots, options) {
    const p = Buffer.alloc(638);
    p.writeUInt16BE(0x0010, 0);
    p.writeUInt16BE(0x0000, 2);
    p.write('ASC-E1.17\0\0\0', 4, 'ascii');
    p.writeUInt16BE(0x7000 | (638 - 16), 16);
    p.writeUInt32BE(0x00000004, 18);
    this.cid.copy(p, 22);
    p.writeUInt16BE(0x7000 | (638 - 38), 38);
    p.writeUInt32BE(0x00000002, 40);
    p.write(String(cfg.sourceName || 'Pulsar Zero 4000').slice(0, 63), 44, 'utf8');
    p.writeUInt8(Math.max(0, Math.min(200, cfg.priority | 0)), 108);
    p.writeUInt16BE(0, 109);
    p.writeUInt8(this.seq = (this.seq + 1) & 0xff, 111);
    p.writeUInt8(options, 112);
    p.writeUInt16BE(cfg.universe, 113);
    p.writeUInt16BE(0x7000 | (638 - 115), 115);
    p.writeUInt8(0x02, 117);
    p.writeUInt8(0xa1, 118);
    p.writeUInt16BE(0x0000, 119);
    p.writeUInt16BE(0x0001, 121);
    p.writeUInt16BE(513, 123);
    p.writeUInt8(0, 125);
    slots.copy(p, 126, 0, 512);
    return p;
  }

  target(cfg) {
    const universe = Math.max(1, Math.min(63999, cfg.universe | 0));
    if (cfg.mode === 'unicast') {
      const r = hosts.get(parseHost(cfg.host, 5568).host);
      if (r.ip && !cfg.allowPublic && !isPrivateIPv4(r.ip)) return { universe, error: publicRefusal(r.ip) };
      return { universe, host: r.ip, error: r.error };
    }
    return { universe, host: `239.255.${(universe >> 8) & 255}.${universe & 255}` };
  }

  status() {
    if (this.lastError) return { ok: false, text: this.lastError };
    return this.lastHost ? { ok: true, text: `sending universe ${this.lastUniverse} to ${this.lastHost}` } : { ok: true, text: 'starting…' };
  }

  send(cfg, levels, colors) {
    const { universe, host, error } = this.target(cfg);
    if (error) { this.lastError = error; return; }
    this.lastHost = cfg.mode === 'unicast' ? host : `${host} (multicast)`;
    this.lastUniverse = universe;
    const pkt = this.build({ ...cfg, universe }, buildDmx(cfg.patch, levels, colors), 0);
    this.sock.send(pkt, 5568, host, err => { this.lastError = err ? err.message : null; });
  }

  // Blackout, then E1.31 "Stream_Terminated" ×3 so receivers release the universe immediately.
  stop(cfg) {
    const { universe, host, error } = this.target(cfg);
    if (error) return;
    const zero = Buffer.alloc(512);
    this.sock.send(this.build({ ...cfg, universe }, zero, 0), 5568, host, () => {});
    for (let i = 0; i < 3; i++) this.sock.send(this.build({ ...cfg, universe }, zero, 0x40), 5568, host, () => {});
  }
}

/* ---------------- DDP (Distributed Display Protocol) ---------------- */
class DdpSender {
  constructor() {
    this.sock = dgram.createSocket('udp4');
    this.sock.on('error', e => { this.lastError = e.message; });
    this.seq = 0;
    this.lastError = null;
    this.sent = 0;
    this.lastSentAt = 0;
  }

  frame(cfg, levels, colors) {
    const ppc = Math.max(1, Math.min(1000, cfg.pixelsPerChannel | 0));
    const rep = Math.max(1, Math.min(100, cfg.repeat | 0 || 1));
    const order = validOrder(cfg.order);
    const bpp = order.length;
    const data = Buffer.alloc(Math.min(ppc * 4 * rep, 20000) * bpp);
    let o = 0;
    for (let r = 0; r < rep; r++) {
      for (let i = 0; i < 4; i++) {
        const px = colourBytes(hexToRgb(colors[i]).map(x => x * levels[i]), order);
        for (let p = 0; p < ppc && o < data.length; p++) for (const v of px) data[o++] = v;
      }
    }
    return data;
  }

  sendData(cfg, data, t) {
    t = t || this.target(cfg);
    if (t.error) return;
    const rgbw = validOrder(cfg.order).length === 4;
    const MAX = 1440; // divisible by both 3 (RGB) and 4 (RGBW)
    this.seq = (this.seq % 15) + 1;
    const base = Math.max(0, cfg.startPixel | 0) * 3;
    for (let off = 0; off < data.length; off += MAX) {
      const chunk = data.subarray(off, Math.min(data.length, off + MAX));
      const last = off + MAX >= data.length;
      const h = Buffer.alloc(10);
      h[0] = 0x40 | (last ? 0x01 : 0x00);
      h[1] = this.seq & 0x0f;
      h[2] = rgbw ? 0x1b : 0x0b; // RGBW or RGB, 8 bits per element
      h[3] = Math.max(1, Math.min(255, cfg.destId | 0 || 1));
      h.writeUInt32BE(base * (rgbw ? 4 / 3 : 1) + off, 4);
      h.writeUInt16BE(chunk.length, 8);
      this.sock.send(Buffer.concat([h, chunk]), t.port, t.ip, err => {
        this.lastError = err ? `network error: ${err.message}` : null;
        if (!err) { this.sent++; this.lastSentAt = Date.now(); }
      });
    }
  }

  target(cfg) {
    const { host, port } = parseHost(cfg.host, cfg.port || 4048);
    const r = hosts.get(host);
    if (r.ip && !cfg.allowPublic && !isPrivateIPv4(r.ip)) return { error: publicRefusal(r.ip) };
    return r.ip ? { ip: r.ip, port, host } : { error: r.error };
  }

  send(cfg, levels, colors) {
    const t = this.target(cfg);
    if (t.error) { this.lastError = t.error; return; }
    this.resolved = t;
    this.sendData(cfg, this.frame(cfg, levels, colors), t);
  }

  status() {
    if (this.lastError) return { ok: false, text: this.lastError };
    const t = this.resolved;
    return t ? { ok: true, text: `sending to ${t.ip}:${t.port}${t.host !== t.ip ? ` (${t.host})` : ''}, ${this.sent} packets sent` } : { ok: true, text: 'starting…' };
  }

  // Send black a few times so the receiver doesn't freeze on the last frame.
  stop(cfg) {
    if (this.target(cfg).error) return;
    const black = Buffer.alloc(this.frame(cfg, [0, 0, 0, 0], ['#000000', '#000000', '#000000', '#000000']).length);
    for (let i = 0; i < 3; i++) this.sendData(cfg, black);
  }
}

module.exports = { parseHost, mdnsLookup, SacnSender, DdpSender, hexToRgb, parseAddresses, buildDmx, colourBytes, ORDERS };
