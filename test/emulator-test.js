#!/usr/bin/env node
// Checks the emulation against the Zero 4000 circuit diagrams (page references in each test).
//   node test/emulator-test.js
'use strict';
const { Zero4000 } = require('../emulator');

let pass = 0, fail = 0;
const check = (name, cond, info = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const NAMES = ['Bass', 'Tenor', 'Alto', 'Treble'];
const lit = o => o.map((v, i) => (v ? NAMES[i] : '')).filter(Boolean).join('+') || '-';
const OFF = 0, STATIC = 1, FLIP = 2, CHASE = 3, MUSIC = 4, MAN = 5;

// advance() caps each call at 0.25 s (the server calls it every 4 ms), so run longer spans in small steps
function run(e, seconds) { for (let t = 0; t < seconds - 1e-9; t += 0.01) e.advance(Math.min(0.01, seconds - t)); }
function unit(panel, opts = {}) {
  const e = new Zero4000({ lampSim: false, ...opts });
  e.setPanel({ level: 'full', program: 'constant', speed: 0.5, ch: [OFF, OFF, OFF, OFF], ...panel });
  run(e, 0.5); // past the C11 power-up hold
  return e;
}
const latchedAfter = (e, s = 0.05) => { run(e, s); return e.latched.slice(); };

// ---- Page 7: channel selector (2P6W) ----
let e = unit({ ch: [STATIC, OFF, STATIC, OFF] }, { trebleInhibit: false });
check('p7  Static contact = +V rail → lamp on; Off contact = −7 V → lamp off', latchedAfter(e).join('') === '1010');
e = unit({ ch: [MAN, MAN, MAN, MAN] });
check('p7  Man. without the button: contact floats, R49 1M pulls it low → off', latchedAfter(e).join('') === '0000');
e.setButton(1, true);
check('p7  Man. with the flash button held: +V through the button → on', latchedAfter(e).join('') === '0100');
e.setButton(1, false);
check('p7  … off again when released', latchedAfter(e).join('') === '0000');
e = unit({ ch: [STATIC, OFF, OFF, OFF] }); e.setButton(0, true); e.setButton(1, true);
check('p7  Flash button only works in Man. (it\'s wired to the Man. contact only)', latchedAfter(e).join('') === '1000');

// ---- Page 6B: flip-flop / flop-flip (N = /Q2 to Bass+Tenor, L = Q2 to Alto+Treble) ----
e = unit({ ch: [FLIP, FLIP, FLIP, FLIP] }, { trebleInhibit: false });
e.q = [0, 1, 0];
let o = latchedAfter(e, 0.025);
check('p6B Flip-Flop (Bass, Tenor) = /Q2; Flop-Flip (Alto, Treble) = Q2', o.join('') === (e.q[1] ? '0011' : '1100'), lit(o));

// ---- Page 6B: chase patterns (R23, D8/D9 OR, D11/D12 AND) and direction (4016 reverse switches) ----
function steps(pattern, reverse) {
  const x = new Zero4000({ lampSim: false });
  x.counter = (pattern === 'dark' ? 32 : pattern === 'light' ? 64 : 0) + (reverse ? 16 : 0);
  x.q = [0, 0, 0];
  for (let i = 0; i < 6; i++) x.q = [x.d1(), x.q[0], x.q[1]];
  const seen = [];
  for (let i = 0; i < 4; i++) { seen.push(lit(x.chaseOutputs())); x.q = [x.d1(), x.q[0], x.q[1]]; }
  return seen;
}
const rot = (arr, first) => { const i = arr.indexOf(first); return i < 0 ? arr : arr.slice(i).concat(arr.slice(0, i)); };
check('p6B Light chase (D11/D12 AND → D1 = NOR Q1..Q3): one lamp, forward Bass→Treble→Alto→Tenor',
  rot(steps('light', false), 'Bass').join(' ') === 'Bass Treble Alto Tenor', steps('light', false).join(' → '));
check('p6B Light chase reverse (4016 switches on): Bass→Tenor→Alto→Treble',
  rot(steps('light', true), 'Bass').join(' ') === 'Bass Tenor Alto Treble', steps('light', true).join(' → '));
check('p6B Dark chase (D8/D9 OR → D1 = NAND Q1..Q3): one lamp off, three on', steps('dark', false).every(s => s.split('+').length === 3));
check('p6B Pairs chase (R23 only → D1 = /Q2): two adjacent lamps', steps('pairs', false).every(s => s.split('+').length === 2));

// ---- Page 6B: auto-program counter (4024: O4 = ÷2^5 reverse, O5/O6 = ÷2^6/÷2^7 pattern, O5·O6 → MR) ----
e = unit({ ch: [CHASE, CHASE, CHASE, CHASE], speed: 1 });
const seq = [];
for (let i = 0; i < 200000 && seq.length < 7; i++) {
  run(e, 0.001);
  const k = e.pattern + (e.reverse ? ' rev' : ' fwd');
  if (seq[seq.length - 1] !== k) seq.push(k);
}
check('p6B Program sequence: Pairs → Dark → Light, each forward then reverse, then repeats',
  seq.join(', ') === 'pairs fwd, pairs rev, dark fwd, dark rev, light fwd, light rev, pairs fwd', seq.join(', '));
e = unit({ ch: [CHASE, CHASE, CHASE, CHASE], speed: 1, program: 'constant' });
e.setPanel({ program: 'hold' }); // centre position: the 4001 latch remembers "constant"
const c0 = e.counter, st0 = e.steps; run(e, 5);
check('p5  Program Hold: remembers Constant, chase runs, program doesn\'t change', e.counter === c0 && e.steps - st0 > 50, `${e.steps - st0} steps, counter ${c0}→${e.counter}`);
e = unit({ ch: [CHASE, CHASE, CHASE, CHASE], speed: 1, program: 'music' });
e.setPanel({ program: 'hold' }); const st1 = e.steps; run(e, 2);
check('p5  Program Hold after Music: remembers Music (no music → no steps)', e.steps === st1);

// ---- Page 4/5: run pulse generator ----
e = unit({ ch: [CHASE, CHASE, CHASE, CHASE], program: 'music' });
const s0 = e.steps; run(e, 3);
check('p4  Music mode with no music: R22 pulls G low, oscillator stops', e.steps === s0);
e.setMusic([true, true, false, false], [1, 1, 0, 0]); run(e, 2);
check('p4  Music mode with music: P4.. collectors lift G, chase runs', e.steps > s0);
const rate = sp => { const x = unit({ program: 'constant', speed: sp }); return x.stepRate(); };
check('p4  Speed pot range ≈ 0.28 – 42 steps/s (C9 1µ, R13 6k8 + R14 1M log)', Math.abs(rate(0) - 0.284) < 0.02 && Math.abs(rate(1) - 42) < 1, `${rate(0).toFixed(3)} – ${rate(1).toFixed(1)}`);

// ---- Page 7: music detection drives the channel in Music position ----
e = unit({ ch: [MUSIC, MUSIC, OFF, OFF] }); e.setMusic([true, false, false, false], [1, 0, 0, 0]);
check('p7  Music position follows that band\'s detector', latchedAfter(e).join('') === '1000');

// ---- Page 8B: output latches, shimmer, standby, treble reset ----
e = unit({ ch: [STATIC, STATIC, STATIC, STATIC] });
check('p8B Treble latch reset (R83 + D15/D16 AND of B·T·A, via R82) when the other three are on', latchedAfter(e).join('') === '1110');
e = unit({ ch: [STATIC, STATIC, STATIC, STATIC] }, { trebleInhibit: false });
check('    (option off: all four on)', latchedAfter(e).join('') === '1111');
e = unit({ ch: [STATIC, OFF, OFF, OFF], level: 'standby' });
check('p8B Standby: latches held reset → all off', latchedAfter(e, 0.2).join('') === '0000');
e = unit({ ch: [STATIC, OFF, OFF, OFF], level: 'shimmer' });
const tap = e.createTap(); run(e, 1); const sh = e.readTap(tap).neon[0];
check('p8B Shimmer Dim: IC5/1 gates alternate mains cycles → ~50 %', sh > 0.45 && sh < 0.55, (sh * 100).toFixed(0) + ' %');
e = unit({ ch: [STATIC, OFF, OFF, OFF] }); let changes = 0, prev = e.latched[0];
e.setPanel({ ch: [OFF, OFF, OFF, OFF] }); for (let i = 0; i < 40; i++) { run(e, 0.0005); if (e.latched[0] !== prev) { changes++; prev = e.latched[0]; } }
check('p8B Outputs only change on a mains-cycle edge (zero-voltage switching, ≤ 20 ms delay at 50 Hz)', changes === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
