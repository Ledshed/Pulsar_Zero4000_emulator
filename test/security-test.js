// Run against a running copy:  node test/security-test.js   (expects it on 127.0.0.1:8040)
// Attack tests against a running Pulsar Zero 4000 on 127.0.0.1:8040
const net = require('net'), http = require('http'), crypto = require('crypto');
const PORT = 8040;
let pass = 0, fail = 0;
const check = (name, cond, info = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
function httpGet(path, headers = {}) {
  return new Promise(r => { const q = http.get({ host: '127.0.0.1', port: PORT, path, headers }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => r({ status: res.statusCode, headers: res.headers, body: b })); }); q.on('error', e => r({ status: 'ERR ' + e.code })); });
}
async function token() { const r = await httpGet('/u/1/'); const m = /name="z4k-token" content="([0-9a-f]+)"/.exec(r.body); return m && m[1]; }
// raw WebSocket client: returns {status, sendRaw, sendText, events}
function ws({ path, host = `127.0.0.1:${PORT}`, origin = `http://127.0.0.1:${PORT}` }) {
  return new Promise(resolve => {
    const s = net.connect(PORT, '127.0.0.1');
    const ev = { msgs: [], closeCode: null, ended: false };
    let hs = '', upgraded = false, buf = Buffer.alloc(0);
    s.on('connect', () => s.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${origin ? 'Origin: ' + origin + '\r\n' : ''}Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    s.on('data', d => {
      if (!upgraded) {
        hs += d.toString('latin1'); const i = hs.indexOf('\r\n\r\n'); if (i < 0) return;
        const status = +hs.split(' ')[1]; upgraded = true;
        resolve({ status, s, ev, sendRaw: b => s.write(b), sendText: t => s.write(frame(1, Buffer.from(t))) });
        buf = Buffer.from(hs.slice(i + 4), 'latin1'); if (!buf.length) return; d = Buffer.alloc(0);
      }
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f, off = 2; if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + len) return;
        const op = buf[0] & 0x0f, p = buf.subarray(off, off + len); buf = buf.subarray(off + len);
        if (op === 1) ev.msgs.push(JSON.parse(p.toString())); if (op === 8) ev.closeCode = p.length >= 2 ? p.readUInt16BE(0) : 1005;
      }
    });
    s.on('close', () => { ev.ended = true; if (!upgraded) resolve({ status: 'closed', ev }); });
    s.on('error', () => {});
  });
}
function frame(op, payload, { mask = true, fin = true, rsv = 0, lenOverride } = {}) {
  const len = lenOverride != null ? lenOverride : payload.length;
  let h; if (len < 126) h = Buffer.from([(fin ? 0x80 : 0) | rsv | op, (mask ? 0x80 : 0) | len]);
  else if (len < 65536) { h = Buffer.alloc(4); h[0] = (fin ? 0x80 : 0) | op; h[1] = (mask ? 0x80 : 0) | 126; h.writeUInt16BE(len, 2); }
  else { h = Buffer.alloc(10); h[0] = (fin ? 0x80 : 0) | op; h[1] = (mask ? 0x80 : 0) | 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(len, 6); }
  if (!mask) return Buffer.concat([h, payload]);
  const m = crypto.randomBytes(4), p = Buffer.from(payload); for (let i = 0; i < p.length; i++) p[i] ^= m[i & 3];
  return Buffer.concat([h, m, p]);
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function closedWith(c, ms = 800) { await wait(ms); return c.ev.closeCode || (c.ev.ended ? 'ended' : null); }

(async () => {
  const T = await token();
  check('page carries a per-run token', !!T && T.length === 48);
  console.log('\n— 1. WebSocket access control');
  check('no token → refused', (await ws({ path: '/ws?unit=1' })).status === 403);
  check('wrong token → refused', (await ws({ path: '/ws?unit=1&t=' + 'a'.repeat(48) })).status === 403);
  check('evil website origin → refused', (await ws({ path: `/ws?unit=1&t=${T}`, origin: 'http://evil.example' })).status === 403);
  check('no Origin header → refused', (await ws({ path: `/ws?unit=1&t=${T}`, origin: null })).status === 403);
  check('DNS rebinding (Host+Origin = evil name) → refused', (await ws({ path: `/ws?unit=1&t=${T}`, host: `evil.example:${PORT}`, origin: `http://evil.example:${PORT}` })).status === 421);
  check('HTTP with rebinding Host → refused', (await httpGet('/u/1/', { Host: `evil.example:${PORT}` })).status === 421);
  check('rebinding page can\'t read the token', !(await httpGet('/u/1/', { Host: `evil.example:${PORT}` })).body.includes('z4k-token'));
  check('/new without token → refused', (await httpGet('/new')).status === 403);
  check('POST → refused', await new Promise(r => { const q = http.request({ host: '127.0.0.1', port: PORT, path: '/new', method: 'POST' }, res => r(res.statusCode === 405)); q.end(); }));
  const r1 = await httpGet('/u/1/');
  check('anti-framing / CSP headers present', r1.headers['x-frame-options'] === 'DENY' && /frame-ancestors 'none'/.test(r1.headers['content-security-policy'] || ''));
  const good = await ws({ path: `/ws?unit=1&t=${T}` });
  check('correct token + origin → connects', good.status === 101);
  await wait(300); check('… and receives hello', good.ev.msgs.some(m => m.t === 'hello'));

  console.log('\n— 2. WebSocket input limits');
  let c = await ws({ path: `/ws?unit=1&t=${T}` }); c.sendRaw(frame(1, Buffer.alloc(100 * 1024, 0x20)));
  check('100 KB message → closed 1009', await closedWith(c) === 1009);
  c = await ws({ path: `/ws?unit=1&t=${T}` }); c.sendRaw(frame(1, Buffer.alloc(0), { lenOverride: 2 ** 31 }).subarray(0, 14));
  check('frame claiming 2 GB → closed 1009 (nothing allocated)', await closedWith(c) === 1009);
  c = await ws({ path: `/ws?unit=1&t=${T}` }); { const big = frame(1, Buffer.alloc(60 * 1024, 0x20)); c.sendRaw(big.subarray(0, big.length - 10)); c.sendRaw(Buffer.alloc(20 * 1024)); }
  { const code = await closedWith(c); check('garbage after a frame → closed', [1002, 1007, 1009, 'ended'].includes(code), 'close code ' + code); }
  c = await ws({ path: `/ws?unit=1&t=${T}` }); { const big = frame(1, Buffer.alloc(30 * 1024, 0x20)); c.sendRaw(big.subarray(0, 1000)); }
  const t0 = Date.now(); while (!c.ev.closeCode && Date.now() - t0 < 12000) await wait(250);
  check('half-sent frame left hanging → closed after ~10 s (1008)', c.ev.closeCode === 1008, ((Date.now() - t0) / 1000).toFixed(1) + ' s');
  c = await ws({ path: `/ws?unit=1&t=${T}` }); c.sendRaw(frame(1, Buffer.from('{"t":"x"}'), { mask: false }));
  check('unmasked client frame → closed 1002', await closedWith(c) === 1002);
  c = await ws({ path: `/ws?unit=1&t=${T}` }); c.sendRaw(frame(1, Buffer.from('a'), { rsv: 0x40 }));
  check('reserved bits set → closed 1002', await closedWith(c) === 1002);
  c = await ws({ path: `/ws?unit=1&t=${T}` }); c.sendRaw(frame(9, Buffer.alloc(126)));
  check('oversized ping → closed 1002', await closedWith(c) === 1002);
  c = await ws({ path: `/ws?unit=1&t=${T}` }); c.sendRaw(frame(1, Buffer.from('{'), { fin: false })); for (let i = 0; i < 20; i++) c.sendRaw(frame(0, Buffer.from('a'), { fin: false }));
  check('20 fragments → closed 1009', await closedWith(c) === 1009);
  c = await ws({ path: `/ws?unit=1&t=${T}` }); c.sendRaw(frame(1, Buffer.from('{'), { fin: false })); for (let i = 0; i < 10; i++) c.sendRaw(frame(0, Buffer.alloc(8000, 0x20), { fin: false }));
  check('fragments adding up to 80 KB → closed 1009', await closedWith(c) === 1009);
  c = await ws({ path: `/ws?unit=1&t=${T}` }); c.sendRaw(frame(0, Buffer.from('a')));
  check('continuation without start → closed 1002', await closedWith(c) === 1002);
  c = await ws({ path: `/ws?unit=1&t=${T}` }); c.sendRaw(frame(2, Buffer.from([1, 2, 3])));
  check('binary frame → closed 1003', await closedWith(c) === 1003);
  c = await ws({ path: `/ws?unit=1&t=${T}` }); c.sendRaw(frame(1, Buffer.from([0xc3, 0x28])));
  check('invalid UTF-8 → closed 1007', await closedWith(c) === 1007);
  c = await ws({ path: `/ws?unit=1&t=${T}` }); { const one = frame(1, Buffer.from('{"t":"noop"}')); c.sendRaw(Buffer.concat(Array(3000).fill(one))); }
  check('3000-message flood → closed 1008', await closedWith(c, 1200) === 1008);
  const conns = []; for (let i = 0; i < 70; i++) conns.push(await ws({ path: `/ws?unit=1&t=${T}` }));
  check('connection cap (64) enforced', conns.filter(x => x.status === 503).length > 0, conns.filter(x => x.status === 101).length + ' accepted');
  conns.forEach(x => x.s && x.s.destroy()); await wait(400);

  console.log('\n— 3. Config validation');
  c = await ws({ path: `/ws?unit=1&t=${T}` }); await wait(300);
  const before = c.ev.msgs.find(m => m.t === 'hello').config;
  const sendCfg = async cfg => { c.ev.msgs.length = 0; c.sendText(JSON.stringify({ t: 'config', config: cfg })); await wait(250); return { rej: (c.ev.msgs.find(m => m.t === 'rejected') || {}).items || [], cfg: (c.ev.msgs.find(m => m.t === 'config') || {}).config }; };
  let r = await sendCfg(JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"ddp":{"__proto__":{"polluted":"yes"}}}'));
  check('__proto__ / constructor keys ignored', r.cfg && !('polluted' in r.cfg) && !('polluted' in r.cfg.ddp) && JSON.stringify(r.cfg) === JSON.stringify(before));
  r = await sendCfg({ evil: { x: 1 }, ddp: { evilKey: 'x', port: 4049 } });
  check('unknown sections / keys dropped, valid ones kept', r.cfg && !('evil' in r.cfg) && !('evilKey' in r.cfg.ddp) && r.cfg.ddp.port === 4049);
  r = await sendCfg({ ddp: { port: 99999, pixelsPerChannel: 1e9, destId: 251, host: 'evil host; rm -rf /' }, sacn: { universe: -5, priority: 999 } });
  check('out-of-range numbers / bad host rejected', r.rej.length === 6 && r.cfg.ddp.port === 4049 && r.cfg.sacn.universe === before.sacn.universe, r.rej.length + ' rejected');
  r = await sendCfg({ colors: ['<img src=x onerror=alert(1)>', '#fff', '#00ff00', '#0000ff'] });
  check('HTML in colours rejected', r.rej.length === 1 && r.cfg.colors[0] === before.colors[0]);
  r = await sendCfg({ sacn: { patch: [{ dimmer: '"><script>', rgb: '', order: 'RGB' }, { dimmer: '2', rgb: '', order: 'RGB' }, { dimmer: '3', rgb: '', order: 'RGB' }, { dimmer: '4', rgb: '', order: 'RGB' }] } });
  check('script in patch rejected', r.rej.length === 1);
  r = await sendCfg({ sacn: { patch: [{ dimmer: '1-512', rgb: '600', order: 'RGB' }, { dimmer: '2', rgb: '', order: 'RGB' }, { dimmer: '3', rgb: '', order: 'RGB' }, { dimmer: '4', rgb: '', order: 'RGB' }] } });
  check('DMX address 600 rejected', r.rej.length === 1 && /600/.test(r.rej[0]));
  r = await sendCfg({ ddp: { host: 'http://192.168.1.60:80/json' } });
  check('pasted URL tidied to plain host', r.cfg.ddp.host === '192.168.1.60', r.cfg.ddp.host);
  r = await sendCfg({ output: { fps: 'lots', master: NaN }, emulation: { mainsHz: 55 } });
  check('wrong types rejected', r.rej.length === 3);
  c.sendText(JSON.stringify({ t: 'rename', name: 'x'.repeat(500) })); c.sendText(JSON.stringify({ t: 'button', i: '__proto__', down: true }));
  c.sendText(JSON.stringify({ t: 'panel', panel: { speed: 1e99, ch: ['a', 2, 3, 4], level: 'boom' } })); await wait(300);
  check('bad rename / button / panel ignored, server alive', (await httpGet('/api/ping')).status === 200);

  console.log('\n— 4. Network destinations & probing');
  r = await sendCfg({ ddp: { enabled: true, host: '8.8.8.8' } }); await wait(2600);
  let st = c.ev.msgs.filter(m => m.t === 'state').pop();
  check('internet DDP destination refused by default', st && st.net.ddp && !st.net.ddp.ok && /internet address/.test(st.net.ddp.text), st && st.net.ddp && st.net.ddp.text.slice(0, 60));
  r = await sendCfg({ output: { allowPublic: true } }); await wait(2600);
  st = c.ev.msgs.filter(m => m.t === 'state').pop();
  check('… with "allow internet" on it sends, but WLED check is NOT run', st.net.ddp.ok && st.net.wled && /wasn't checked/.test(st.net.wled.text), st.net.wled && st.net.wled.text.slice(0, 50));
  await sendCfg({ output: { allowPublic: false }, ddp: { enabled: false, host: '', port: 4048 } });
  c.s.destroy();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
