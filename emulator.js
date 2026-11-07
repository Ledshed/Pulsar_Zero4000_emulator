'use strict';
/*
 * Pulsar Zero 4000 — logic-level emulation of the circuit (drawings RJM 14/10/80 – 5/11/80).
 *
 * Signal path modelled (page refs are to the schematic set):
 *   Pg4  Run pulse generator   : C9 1µF ramp (-1.2 → -3.3 V, 2.1 V swing) charged by N3 current source,
 *                                I = (Vg - Vbe)/(R13 6k8 + R14 1M log "SPEED"). Vg held 0.6–1.2 V by D6/D7.
 *                                Constant mode → G pulled high (full rate set by pot).
 *                                Music mode   → G pulled low via R22; only the P4..P7 "music" collectors
 *                                               lift it, so the chase only runs while music is detected.
 *   Pg5  Music/Hold/Constant   : 3-position rocker into a cross-coupled 4001 latch. Centre (Program Hold)
 *                                remembers music/constant and gates off the auto-program clock (I).
 *                                Zero 4000 clocks the program counter from L (alto chase) = ÷4 of steps.
 *   Pg6B Chaser                : 3 × 4013 D-types (IC2a, IC2b, IC7a) as a shift register with D1 feedback.
 *                                Outputs: Bass = D1, Tenor = Q1, Alto = Q2, Treble = Q3.
 *                                Feedback via 4016 + D8/D9/D11/D12 selected by 4024 ÷2^6 / ÷2^7:
 *                                  00 Pairs chase, 01 Dark chase, 10 Light chase, 11 → MR reset (D13/R80/C74).
 *                                ÷2^5 drives the 4016 "Reverse" switches (Tenor ↔ Treble swap; forward = Tenor←Q3,
 *                                Treble←Q1 via R25/R26, i.e. the chase runs Bass → Treble → Alto → Tenor).
 *                                Flip-Flop (N, Bass+Tenor) = /Q2,  Flop-Flip (L, Alto+Treble) = Q2.
 *   Pg7  Selector 2P6W         : Off / Static / Flip-Flop|Flop-Flip / Chase / Music / Man (via flash button).
 *   Pg8B Output latches        : 4013 data latches clocked by the line-Hz square wave → outputs only change
 *                                once per mains cycle (zero-voltage switching, whole cycles to the triacs).
 *                                IC5/1 toggles each mains cycle; in Shimmer Dim it gates the latches so the
 *                                lamps get alternate whole cycles = 50 % power with a visible shimmer.
 *                                Standby holds the latches reset (0 %). C11 keeps lights off at switch-on.
 *                                R81–R83, D14–D16: "reset circuit for Treble if other 3 channels are on".
 */

const POSITIONS = ['off', 'static', 'flip', 'chase', 'music', 'man'];
const PATTERNS = ['pairs', 'dark', 'light'];
const SUBSTEP = 0.0005; // 0.5 ms simulation step

const DEFAULT_EMU_OPTS = {
  mainsHz: 50,
  lampSim: true,      // model incandescent filament inertia on the outputs
  lampRiseMs: 60,
  lampFallMs: 160,
  trebleInhibit: true, // R81–R83 / D14–D16 behaviour
  remoteFull: false,   // rear remote-control jack (4N27 opto shorts the FULL pad)
};

function speedPotOhms(speed) {
  // R14 1M log-law pot, wired so clockwise = less resistance = faster.
  const x = 1 - Math.min(1, Math.max(0, speed));
  return 1e6 * (Math.pow(10, 2 * x) - 1) / 99;
}

class Zero4000 {
  constructor(opts = {}) {
    this.opts = { ...DEFAULT_EMU_OPTS, ...opts };
    this.panel = {
      power: true,
      level: 'full',       // 'standby' | 'shimmer' | 'full'
      program: 'music',    // 'music' | 'hold' | 'constant'
      speed: 0.55,
      ch: [3, 3, 3, 3],    // index into POSITIONS
    };
    this.buttons = [false, false, false, false];
    this.taps = new Set();
    this.reset();
  }

  reset() {
    this.mainsPhase = 0;
    this.ramp = 0;
    this.q = [0, 0, 0];
    this.counter = 0;
    this.memMusic = this.panel.program !== 'constant';
    this.shimmerFF = 0;
    this.latched = [0, 0, 0, 0];
    this.lamp = [0, 0, 0, 0];
    this.musicOn = [false, false, false, false];
    this.musicSticky = [false, false, false, false];
    this.musicDrive = [0, 0, 0, 0];
    this.powerUpHold = 0.4; // C11: lights off for a moment at switch-on
    this.steps = 0;
  }

  setOptions(o) { Object.assign(this.opts, o); }

  setPanel(p) {
    const wasOn = this.panel.power;
    for (const k of ['power', 'level', 'program', 'speed']) if (k in p) this.panel[k] = p[k];
    if (Array.isArray(p.ch)) p.ch.forEach((v, i) => { if (v != null && i < 4) this.panel.ch[i] = v | 0; });
    if (this.panel.program === 'music') this.memMusic = true;
    else if (this.panel.program === 'constant') this.memMusic = false;
    if (!wasOn && this.panel.power) this.reset();
  }

  setButton(i, down) { if (i >= 0 && i < 4) this.buttons[i] = !!down; }

  setMusic(on, drive) {
    for (let i = 0; i < 4; i++) {
      this.musicOn[i] = !!on[i];
      if (on[i]) this.musicSticky[i] = true;
      this.musicDrive[i] = Math.max(0, Math.min(1, +drive[i] || 0));
    }
  }

  clearMusic() { this.setMusic([0, 0, 0, 0], [0, 0, 0, 0]); }

  get pattern() {
    const b5 = (this.counter >> 5) & 1, b6 = (this.counter >> 6) & 1;
    return b6 ? 'light' : b5 ? 'dark' : 'pairs';
  }
  get reverse() { return ((this.counter >> 4) & 1) === 1; }

  d1() {
    const [q0, q1, q2] = this.q;
    switch (this.pattern) {
      case 'pairs': return q1 ? 0 : 1;
      case 'dark': return q0 && q1 && q2 ? 0 : 1;
      default: return q0 || q1 || q2 ? 0 : 1;
    }
  }

  // Page 6B: Bass = D1, Alto = Q2. Tenor (K) and Treble (M) go through the 4016 "reverse" switches:
  //   forward (switches open, via R25 / R26):  Tenor ← Q3,  Treble ← Q1
  //   reverse (switches closed, bypassing them): Tenor ← Q1,  Treble ← Q3
  // The light moves D1 → Q1 → Q2 → Q3, so forward runs Bass → Treble → Alto → Tenor, and reverse runs
  // Bass → Tenor → Alto → Treble. The counter starts at 0, so each pattern starts in forward.
  chaseOutputs() {
    const [q0, q1, q2] = this.q;
    const r = this.reverse;
    return [this.d1(), r ? q0 : q2, q1, r ? q2 : q0];
  }

  stepRate() {
    // Run pulses per second from the C9 ramp oscillator.
    let v = 1;
    if (this.memMusic) {
      let s = 0;
      for (const d of this.musicDrive) s += d;
      v = Math.min(1, s * 0.5);
    }
    return v / (1e-6 * 2.1 * (6800 + speedPotOhms(this.panel.speed)) / 0.6);
  }

  clockChase() {
    const prevAlto = this.q[1];
    this.q = [this.d1(), this.q[0], this.q[1]];
    this.steps++;
    // Auto-program counter: L (alto) via 4001 NOR gate, inhibited in Program Hold.
    if (this.panel.program !== 'hold' && !prevAlto && this.q[1]) {
      this.counter = (this.counter + 1) & 0x7f;
      if ((this.counter & 0x60) === 0x60) this.counter = 0; // ÷2^6 AND ÷2^7 → MR
    }
  }

  channelData() {
    const chase = this.chaseOutputs();
    const flip = this.q[1] ? 0 : 1, flop = this.q[1];
    const d = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      switch (POSITIONS[this.panel.ch[i]]) {
        case 'static': d[i] = 1; break;
        case 'flip': d[i] = i < 2 ? flip : flop; break;
        case 'chase': d[i] = chase[i]; break;
        case 'music': d[i] = this.musicOn[i] || this.musicSticky[i] ? 1 : 0; break;
        case 'man': d[i] = this.buttons[i] ? 1 : 0; break;
        default: d[i] = 0;
      }
    }
    if (this.opts.trebleInhibit && d[0] && d[1] && d[2]) d[3] = 0;
    return d;
  }

  mainsEdge() {
    this.shimmerFF ^= 1;
    const level = this.opts.remoteFull ? 'full' : this.panel.level;
    const en = level === 'full' ? 1 : level === 'shimmer' ? this.shimmerFF : 0;
    const d = this.channelData();
    for (let i = 0; i < 4; i++) this.latched[i] = en && this.powerUpHold <= 0 ? d[i] : 0;
    this.musicSticky.fill(false);
  }

  advance(dt) {
    let t = Math.min(dt, 0.25);
    while (t > 1e-9) {
      const h = Math.min(SUBSTEP, t);
      t -= h;
      this.substep(h);
    }
  }

  substep(h) {
    const on = this.panel.power;
    if (on) {
      if (this.powerUpHold > 0) this.powerUpHold -= h;
      this.ramp += this.stepRate() * h;
      while (this.ramp >= 1) { this.ramp -= 1; this.clockChase(); }
      this.mainsPhase += h * this.opts.mainsHz;
      if (this.mainsPhase >= 1) { this.mainsPhase -= 1; this.mainsEdge(); }
    } else {
      this.latched.fill(0);
    }
    const { lampSim, lampRiseMs, lampFallMs } = this.opts;
    const kr = 1 - Math.exp(-h / Math.max(1e-3, lampRiseMs / 1000));
    const kf = 1 - Math.exp(-h / Math.max(1e-3, lampFallMs / 1000));
    for (let i = 0; i < 4; i++) {
      const target = this.latched[i];
      if (!lampSim) this.lamp[i] = target;
      else this.lamp[i] += (target - this.lamp[i]) * (target > this.lamp[i] ? kr : kf);
    }
    for (const tap of this.taps) {
      tap.t += h;
      for (let i = 0; i < 4; i++) { tap.lamp[i] += this.lamp[i] * h; tap.neon[i] += this.latched[i] * h; }
    }
  }

  // A tap integrates outputs between reads (e.g. one per output frame, one per UI frame).
  createTap() {
    const tap = { t: 0, lamp: [0, 0, 0, 0], neon: [0, 0, 0, 0] };
    this.taps.add(tap);
    return tap;
  }

  readTap(tap) {
    const n = tap.t || 1;
    const out = {
      lamp: tap.t ? tap.lamp.map(v => v / n) : this.lamp.slice(),
      neon: tap.t ? tap.neon.map(v => v / n) : this.latched.slice(),
    };
    tap.t = 0; tap.lamp.fill(0); tap.neon.fill(0);
    return out;
  }

  diag() {
    return {
      pattern: this.pattern,
      reverse: this.reverse,
      counter: this.counter,
      mode: this.memMusic ? 'music' : 'constant',
      hold: this.panel.program === 'hold',
      stepRate: this.panel.power ? this.stepRate() : 0,
      q: this.q.slice(),
    };
  }
}

module.exports = { Zero4000, POSITIONS, PATTERNS, DEFAULT_EMU_OPTS, speedPotOhms };
