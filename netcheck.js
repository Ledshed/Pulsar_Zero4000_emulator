'use strict';
/* Network diagnostics: which local address we send from, same-subnet check, and asking a WLED what it receives. */
const dgram = require('dgram');
const http = require('http');
const os = require('os');

// Lighting gear lives on the local network: loopback, RFC 1918, link-local and CGNAT ranges count as "local".
function isPrivateIPv4(ip) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

const ipToInt = ip => ip.split('.').reduce((a, b) => (a << 8) + (+b), 0) >>> 0;

// IPv4 addresses of this computer (not loopback)
function localIPv4s() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' || a.family === 4) if (!a.internal) out.push({ name, address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

// Which of our interfaces is on the same subnet as ip (null if none)
function sameSubnet(ip) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return null;
  if (ip.startsWith('127.')) return { name: 'loopback', address: '127.0.0.1', netmask: '255.0.0.0' };
  const t = ipToInt(ip);
  return localIPv4s().find(a => ((ipToInt(a.address) & ipToInt(a.netmask)) >>> 0) === ((t & ipToInt(a.netmask)) >>> 0)) || null;
}

// The local address the OS would use to send to ip:port
function sourceAddressFor(ip, port) {
  return new Promise(resolve => {
    const s = dgram.createSocket('udp4');
    s.on('error', () => { try { s.close(); } catch (_) {} resolve(null); });
    s.connect(port, ip, () => {
      let a = null;
      try { a = s.address().address; } catch (_) {}
      try { s.close(); } catch (_) {}
      resolve(a);
    });
  });
}

function getJson(ip, path, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: ip, port: 80, path, timeout, headers: { Accept: 'application/json' } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; if (body.length > 200000) req.destroy(); });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(body)); } catch (_) { reject(new Error('not JSON')); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

/*
 * Ask a WLED device about its realtime (DDP) reception.
 * Returns { level: 'ok'|'warn'|'bad'|'info', text, wled?: {...} }
 */
async function probeWled(ip, ctx) {
  const { sending, startPixel, totalPixels } = ctx;
  const subnet = sameSubnet(ip);
  const me = await sourceAddressFor(ip, 4048);
  let si;
  try {
    si = await getJson(ip, '/json/si');
  } catch (e) {
    if (!subnet) {
      const mine = localIPv4s().map(a => a.address).join(', ') || 'none found';
      return { level: 'bad', text: `${ip} isn't on the same network as this computer (this computer: ${mine}). Check the IP address, and that the computer and WLED are on the same Wi-Fi/LAN.` };
    }
    return { level: 'info', text: `No WLED web page answered at ${ip}. If this is a WLED, check the IP address. (Other DDP devices may not have one, which is fine.)` };
  }
  const info = si.info || {}, state = si.state || {};
  if (!info.ver) return { level: 'info', text: `${ip} answered, but doesn't look like a WLED.` };
  let cfg = null;
  try { cfg = await getJson(ip, '/json/cfg'); } catch (_) {}
  const leds = info.leds && info.leds.count;
  const name = `WLED "${info.name || 'WLED'}" (v${info.ver}${leds ? `, ${leds} LEDs` : ''})`;
  const wled = { name: info.name, ver: info.ver, leds, live: !!info.live, lm: info.lm, lip: info.lip, me };
  const live = cfg && cfg.if && cfg.if.live;

  if (live && live.en === false) {
    return { level: 'bad', wled, text: `${name}: "Receive UDP realtime" is switched OFF, so it ignores DDP. In WLED go to Config → Sync Interfaces → Realtime, tick "Receive UDP realtime", and Save.` };
  }
  if (state.lor) {
    return { level: 'bad', wled, text: `${name}: "Override live data" is on, so WLED ignores DDP. Turn it off in WLED (Info panel → "Override live data", or restart WLED).` };
  }
  if (leds && startPixel >= leds) {
    return { level: 'bad', wled, text: `${name}: your DDP start pixel (${startPixel}) is beyond the end of the strip (${leds} LEDs).` };
  }
  if (live && live.dmx && live.dmx.addr > 1) {
    // WLED adds its DMX start address to DDP too
    const shift = Math.floor(live.dmx.addr / 3);
    if (shift > 0 && info.live && info.lm === 'DDP') {
      return { level: 'warn', wled, text: `${name} is receiving our DDP, but its "DMX start address" (${live.dmx.addr}) shifts DDP by ${shift} LED(s). Set it to 1 in Config → Sync Interfaces if the pattern starts in the wrong place.` };
    }
  }
  if (info.live && info.lm === 'DDP') {
    if (info.lip && me && info.lip !== me) {
      return { level: 'bad', wled, text: `${name} is receiving DDP from ANOTHER device (${info.lip}), not from this computer (${me}). Stop the other sender.` };
    }
    const extra = leds && totalPixels > leds ? ` (note: you're sending ${totalPixels} pixels but the strip has ${leds}; the extra ones are ignored)` : '';
    return { level: 'ok', wled, text: `${name} is receiving our DDP ✔${extra}` };
  }
  if (info.live && info.lm) {
    return { level: 'bad', wled, text: `${name} is busy receiving ${info.lm}${info.lip ? ` from ${info.lip}` : ''} instead of our DDP. Stop the other source, or wait for it to time out.` };
  }
  if (sending) {
    return { level: 'bad', wled, text: `${name} is reachable, but isn't receiving our DDP packets. The most likely cause is a firewall or security program blocking "Pulsar Zero 4000" from sending UDP on the network. Allow it (Windows: Settings → Privacy & security → Windows Security → Firewall → Allow an app). Also check WLED isn't on a separate guest/IoT network.` };
  }
  return { level: 'info', wled, text: `${name} found. Not receiving DDP right now (DDP is off). Press "Send test" to check.` };
}

module.exports = { isPrivateIPv4, localIPv4s, sameSubnet, sourceAddressFor, probeWled, getJson };
