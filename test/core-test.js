// Needs a fresh settings folder (e.g. node server.js --data /tmp/fresh): it assumes the default patch.
// node test/core-test.js beat.wav   (needs Playwright and a running copy on 127.0.0.1:8040)
// End-to-end core test: audio in → emulator → sACN / DDP out. Needs a running copy on 127.0.0.1:8040 and beat.wav.
const { chromium } = require('playwright'); const dgram = require('dgram');
const BEAT = process.argv[2];
let pass = 0, fail = 0;
const check = (n, c, i = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${i ? '  — ' + i : ''}`); };
const frames = []; const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
s.on('message', m => { if (m.readUInt16BE(113) === 1) frames.push({ t: Date.now(), d: [...m.subarray(126, 126 + 24)] }); });
s.bind(5568, () => s.addMembership('239.255.0.1'));
const ddpFrames = []; const d = dgram.createSocket('udp4'); d.on('message', m => ddpFrames.push([...m.subarray(10)])); d.bind(4048);
const wait = ms => new Promise(r => setTimeout(r, ms));
const grab = async ms => { frames.length = 0; await wait(ms); return frames.slice(); };
const distinct = (fr, idx) => [...new Set(fr.map(f => idx.map(i => f.d[i] > 127 ? 1 : 0).join('')))];
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8040/'); await p.waitForTimeout(800);
  check('page connects', await p.textContent('#conn') === 'connected');
  const cfg = c => p.evaluate(c => window.__send ? 0 : 0, c);
  // panel helpers via the real UI
  const setCh = async (i, pos) => p.click(`[data-ch="${i}"][data-pos="${pos}"] >> nth=0`);
  const rock = async (r, pos) => p.click(`#${r} [data-pos="${pos}"]`);
  await rock('level', 2); // Full
  // --- lamp simulation off for crisp levels
  await p.click('[data-drop=dropEmu]'); if (await p.isChecked('[data-k="emulation.lampSim"]')) await p.uncheck('[data-k="emulation.lampSim"]'); await p.waitForTimeout(300);
  // 1. static / off
  for (let i = 0; i < 4; i++) await setCh(i, i % 2 ? 0 : 1);
  let fr = await grab(700);
  check('sACN is being sent (≈40 fps)', fr.length >= 20, fr.length + ' frames in 0.7 s');
  check('Static = full, Off = 0 (dimmers on 1-4)', fr.length && fr[fr.length - 1].d.slice(0, 4).join() === '255,0,255,0', fr.length && fr[fr.length - 1].d.slice(0, 4).join());
  // 2. constant chase
  for (let i = 0; i < 4; i++) await setCh(i, 3);
  await rock('program', 2); // Constant
  fr = await grab(3000);
  const pats = distinct(fr, [0, 1, 2, 3]);
  check('Constant + Chase: pattern moves', pats.length >= 3, pats.join(' '));
  // 3. standby / shimmer
  await rock('level', 0); fr = await grab(600); check('Standby = all off', fr.slice(-5).every(f => f.d.slice(0, 4).every(v => v === 0)));
  await rock('level', 2);
  // 4. manual flash
  await setCh(0, 5); await setCh(1, 0); await setCh(2, 0); await setCh(3, 0); await wait(300);
  const bb = await p.locator('[data-btn="0"]').boundingBox(); await p.mouse.move(bb.x + 20, bb.y + 20); await p.mouse.down();
  fr = await grab(500); await p.mouse.up();
  check('Manual flash lights Bass while held', fr.slice(-3).every(f => f.d[0] === 255));
  fr = await grab(400); check('… and it goes off when released', fr.slice(-3).every(f => f.d[0] === 0));
  // 5. music mode with a beat
  await rock('program', 0); // Music
  for (let i = 0; i < 4; i++) await setCh(i, 4);
  await p.click('[data-drop=dropAudio]'); await p.setInputFiles('#audioFile', BEAT); await p.waitForTimeout(3000);
  fr = await grab(4000);
  const bassVals = fr.map(f => f.d[0] > 127 ? 1 : 0); let toggles = 0; for (let i = 1; i < bassVals.length; i++) if (bassVals[i] !== bassVals[i - 1]) toggles++;
  check('Music mode: Bass flashes with the beat', toggles >= 4, `${toggles} on/off changes in 4 s (2 beats/s)`);
  // 6. music-driven chase (Music + Auto Program, Chase)
  for (let i = 0; i < 4; i++) await setCh(i, 3);
  fr = await grab(3000);
  check('Music + Chase: chase advances with music', distinct(fr, [0, 1, 2, 3]).length >= 2, distinct(fr, [0, 1, 2, 3]).join(' '));
  await p.click('#srcStop');
  // 7. RGB patch
  await p.click('[data-drop=dropOut]'); await p.click('#dropOut .quick summary');
  await p.selectOption('#qpType', 'colour'); await p.selectOption('#qpOrder', 'RGB'); await p.fill('#qpStart', '1'); await p.fill('#qpCount', '4'); await p.click('#qpGo'); await p.waitForTimeout(400);
  for (let i = 0; i < 4; i++) await setCh(i, 1); fr = await grab(600);
  const last = fr[fr.length - 1].d;
  check('RGB patch: fixtures show the channel colours', last.slice(0, 3).join() === '255,42,26' && last.slice(6, 9).join() === '32,224,64', last.slice(0, 12).join());
  check('Treble reset option ON (default): treble dark while B+T+A are on', last.slice(9, 12).join() === '0,0,0');
  await p.click('[data-drop=dropEmu]'); await p.uncheck('[data-k="emulation.trebleInhibit"]'); fr = await grab(600);
  check('Treble reset option OFF: treble fixture shows blue', fr[fr.length - 1].d.slice(9, 12).join() === '32,96,255', fr[fr.length - 1].d.slice(9, 12).join());
  await p.check('[data-k="emulation.trebleInhibit"]'); await p.click('[data-drop=dropOut]');
  // 8. DDP
  await p.fill('[data-k="ddp.host"]', '127.0.0.1'); await p.press('[data-k="ddp.host"]', 'Tab'); await p.check('[data-k="ddp.enabled"]');
  ddpFrames.length = 0; await wait(800);
  check('DDP sends pixels in the channel colours', ddpFrames.length > 15 && ddpFrames[ddpFrames.length - 1].slice(0, 3).join() === '255,42,26', ddpFrames.length + ' packets');
  await p.uncheck('[data-k="ddp.enabled"]');
  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
