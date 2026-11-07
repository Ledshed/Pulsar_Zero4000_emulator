/*
 * Audio front end of the Zero 4000, run as an AudioWorklet.
 *  Pg3  jack: tip + ring summed through 2 × 33k → mono, 1:1 isolating transformer,
 *       D4/D5 anti-parallel diodes = logarithmic compression ("isolating log audio amp").
 *  Pg2  Zero 4000 band filters (first-order RC, 6 dB/octave). Original corner frequencies:
 *         Bass   : C3 0.1µ / R7 15k low-pass            ≈ 106 Hz
 *         Tenor  : C5 20n / R8 15k LP ≈ 530 Hz, C6 20n into ~22k HP ≈ 360 Hz
 *         Alto   : C7 5n  / R9 15k LP ≈ 2.1 kHz, C8 5n into ~22k HP ≈ 1.45 kHz
 *         Treble : C13 2n into ~22k high-pass           ≈ 3.6 kHz
 *       Corners and slope can be changed from the UI ({filters:[{hp,lp}×4], slope}).
 *  Pg7  per channel: D40/D41 peak-peak detector into C41 2µ2 (attack ≈ 15k·2µ2, release ≈ 55k·2µ2),
 *       A.G.C. via C42 4µ7 / R43 220k (≈ 1 s) — the light fires when the band rises above its own
 *       recent average, so the unit needs no level control.
 */
const TAU = Math.PI * 2;
const ORIGINAL = [{ hp: 0, lp: 106 }, { hp: 360, lp: 530 }, { hp: 1450, lp: 2100 }, { hp: 3600, lp: 0 }];

class OnePoleLP {
  constructor(fc, fs) { this.a = 1 - Math.exp(-TAU * fc / fs); this.y = 0; }
  run(x) { return (this.y += this.a * (x - this.y)); }
}
class OnePoleHP {
  constructor(fc, fs) { this.lp = new OnePoleLP(fc, fs); }
  run(x) { return x - this.lp.run(x); }
}

class ZeroDetector extends AudioWorkletProcessor {
  constructor() {
    super();
    const fs = sampleRate;
    this.trim = 1;
    this.sens = 0.5;
    this.slope = 1;
    this.filters = ORIGINAL;
    this.buildChains();
    this.atk = 1 - Math.exp(-1 / (fs * 0.033));
    this.rel = Math.exp(-1 / (fs * 0.121));
    this.agcK = 1 / (fs * 1.03);
    this.env = new Float32Array(4);
    this.avg = new Float32Array(4).fill(0.05);
    this.on = [false, false, false, false];
    this.winOn = [false, false, false, false];
    this.winDrive = new Float32Array(4);
    this.winEnv = new Float32Array(4);
    this.peakIn = 0;
    this.count = 0;
    this.block = Math.round(fs * 0.01);
    this.logA = 1000;
    this.logN = 1 / Math.log(1 + this.logA);
    this.port.onmessage = e => {
      const d = e.data;
      if ('trimDb' in d) this.trim = Math.pow(10, d.trimDb / 20);
      if ('sens' in d) this.sens = d.sens;
      if ('filters' in d || 'slope' in d) {
        if (Array.isArray(d.filters) && d.filters.length === 4) this.filters = d.filters;
        if (d.slope) this.slope = Math.max(1, Math.min(4, d.slope | 0));
        this.buildChains();
      }
    };
  }

  buildChains() {
    const fs = sampleRate, nyq = fs * 0.45;
    this.chain = this.filters.map(({ hp, lp }) => {
      const c = [];
      for (let i = 0; i < this.slope; i++) {
        if (lp > 0) c.push(new OnePoleLP(Math.min(lp, nyq), fs));
        if (hp > 0) c.push(new OnePoleHP(Math.min(hp, nyq), fs));
      }
      return c;
    });
  }

  process(inputs) {
    const inp = inputs[0];
    if (!inp || !inp.length) return true;
    const n = inp[0].length;
    const nch = inp.length;
    const thrOn = 1 + 0.3 * (1 - this.sens);
    const thrOff = 1 + 0.1 * (1 - this.sens);
    const floor = 0.04 + 0.08 * (1 - this.sens);
    for (let s = 0; s < n; s++) {
      let x = 0;
      for (let c = 0; c < nch; c++) x += inp[c][s];
      x = (x / nch) * this.trim;
      const ax = Math.abs(x);
      if (ax > this.peakIn) this.peakIn = ax;
      const y = Math.sign(x) * Math.log(1 + this.logA * Math.min(ax, 4)) * this.logN;
      for (let b = 0; b < 4; b++) {
        let v = y;
        const ch = this.chain[b];
        for (let k = 0; k < ch.length; k++) v = ch[k].run(v);
        const pp = 2 * Math.abs(v);
        let e = this.env[b];
        e = pp > e ? e + (pp - e) * this.atk : e * this.rel;
        this.env[b] = e;
        if (e > this.winEnv[b]) this.winEnv[b] = e;
        this.avg[b] += (e - this.avg[b]) * this.agcK;
        const a = Math.max(this.avg[b], 1e-4);
        if (!this.on[b]) { if (e > floor && e > a * thrOn) this.on[b] = true; }
        else if (e < floor * 0.8 || e < a * thrOff) this.on[b] = false;
        if (this.on[b]) {
          this.winOn[b] = true;
          const d = Math.min(1, 0.25 + (e / a - thrOff) * 3);
          if (d > this.winDrive[b]) this.winDrive[b] = d;
        }
      }
      if (++this.count >= this.block) {
        this.count = 0;
        this.port.postMessage({
          on: this.winOn.slice(),
          drive: Array.from(this.winDrive),
          env: Array.from(this.winEnv),
          avg: Array.from(this.avg),
          peak: this.peakIn,
        });
        this.winOn = this.on.slice();
        this.winDrive.fill(0);
        this.winEnv.fill(0);
        this.peakIn = 0;
      }
    }
    return true;
  }
}

registerProcessor('zero-detector', ZeroDetector);
