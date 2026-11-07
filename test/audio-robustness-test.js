// Browser test of audio-source start/stop/failure handling. Needs Playwright, a running copy on :8040,
// a copy with #panelOnly removed from its page on :8050, and two files: node test/audio-robustness-test.js beat.wav broken.mp3
const { chromium } = require('playwright');
const BEAT = process.argv[2], BROKEN = process.argv[3];
let pass = 0, fail = 0;
const check = (n, c, i = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${i ? '  — ' + i : ''}`); };
// Delay getUserMedia to simulate the user taking time over the permission prompt; keep every stream it hands out.
const SLOW_PROMPT = () => {
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.__streams = [];
  navigator.mediaDevices.getUserMedia = async c => { await new Promise(r => setTimeout(r, 1500)); const s = await real(c); window.__streams.push(s); return s; };
  const rv = URL.revokeObjectURL.bind(URL); window.__revoked = 0; URL.revokeObjectURL = u => { window.__revoked++; rv(u); };
};
const liveTracks = p => p.evaluate(() => window.__streams.flatMap(s => s.getTracks()).filter(t => t.readyState === 'live').length);
(async () => {
  const b = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const page = async (opts = {}) => {
    const ctx = await b.newContext(); if (opts.init) await ctx.addInitScript(opts.init);
    const p = await ctx.newPage(); p.errors = []; p.consoleErr = [];
    p.on('pageerror', e => p.errors.push(e.message)); p.on('console', m => { if (m.type() === 'error') p.consoleErr.push(m.text()); });
    if (opts.route) await opts.route(p);
    await p.goto(opts.url || 'http://127.0.0.1:8040/'); await p.waitForTimeout(700); await p.click('[data-drop=dropAudio]'); return p;
  };
  let p = await page({ init: SLOW_PROMPT });
  await p.click('#srcMic'); await p.waitForTimeout(300); await p.click('#srcStop'); await p.waitForTimeout(2000);
  check('1. Mic then Stop during the prompt → mic released', (await liveTracks(p)) === 0 && (await p.evaluate(() => window.__streams.length)) === 1 && await p.textContent('#audioState') === 'audio off');
  await p.click('#srcMic'); await p.waitForTimeout(300); await p.setInputFiles('#audioFile', BEAT); await p.waitForTimeout(2200);
  check('2. Mic then file during the prompt → mic released, file plays alone', (await liveTracks(p)) === 0 && (await p.textContent('#audioState')).includes('beat.wav'), await p.textContent('#audioState'));
  await p.setInputFiles('#audioFile', BEAT); await p.waitForTimeout(800);
  check('5. previous file\'s memory freed when a new one starts', (await p.evaluate(() => window.__revoked)) >= 1, 'revoked ' + await p.evaluate(() => window.__revoked));
  await p.setInputFiles('#audioFile', BROKEN); await p.waitForTimeout(1200);
  check('4. broken file → clear message, cleanly off', /Could not play/.test(await p.textContent('#audioHelp')) && await p.textContent('#audioState') === 'audio off' && p.errors.length === 0, (await p.textContent('#audioHelp')).slice(0, 50));
  await p.click('#srcMic'); await p.waitForTimeout(2000);
  check('   … and the mic still works afterwards', await p.textContent('#audioState') === '🎤 mic / line-in' && (await liveTracks(p)) === 1);
  check('   no uncaught errors in that sequence', p.errors.length === 0, p.errors.join(' | '));

  p = await page({ init: () => { // the audio processor fails to load the first time only
    const real = AudioWorklet.prototype.addModule; let first = true;
    AudioWorklet.prototype.addModule = function (u) { if (first) { first = false; return Promise.reject(new Error('simulated load failure')); } return real.call(this, u); };
  } });
  await p.click('#srcMic'); await p.waitForTimeout(1000);
  const firstState = await p.textContent('#audioState');
  await p.click('#srcMic'); await p.waitForTimeout(1200);
  check('3. audio processor fails once → error, then works on retry', firstState === 'mic error' && await p.textContent('#audioState') === '🎤 mic / line-in', `${firstState} → ${await p.textContent('#audioState')}`);

  p = await page({ url: 'http://127.0.0.1:8050/' }); // a real copy of the app with #panelOnly removed from its page
  check('6. element missing from page → interface still starts', p.errors.length === 0 && await p.textContent('#conn') === 'connected' && await p.locator('#panelWrap svg').count() === 1, 'errors=' + JSON.stringify(p.errors) + ' conn=' + await p.textContent('#conn') + ' svg=' + await p.locator('#panelWrap svg').count());
  check('   … and the problem is reported clearly', p.consoleErr.some(e => /#panelOnly not found/.test(e)), p.consoleErr.find(e => /not found/.test(e)));
  await p.click('[data-ch="0"][data-pos="1"] >> nth=0'); await p.waitForTimeout(300);
  check('   … other controls still work', /rotate\(-42/.test(await p.getAttribute('#knob0 .ptr', 'transform')));

  p = await page();
  await p.addScriptTag({ url: 'app.js' }); await p.waitForTimeout(500);
  check('7. app.js loaded twice → second load refuses, no errors', p.errors.length === 0 && (await p.evaluate(() => document.querySelectorAll('#ladders .ladder').length)) === 5);
  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
