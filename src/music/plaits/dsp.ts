// Synthesis engines ported from Mutable Instruments Plaits and stmlib.
//
// Copyright 2016 Emilie Gillet.
//
// Author: Emilie Gillet (emilie.o.gillet@gmail.com)
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
//
// See http://creativecommons.org/licenses/MIT/ for more information.
//
// -----------------------------------------------------------------------------
//
// TypeScript port for Tonefield of the Plaits engines (virtual analog,
// waveshaping, 2-op FM, grain, additive, string, modal), the divide-down
// string-machine oscillator and chord inversion from Plaits' chord engine,
// and the low-pass gate, all adapted to run polyphonically inside an
// AudioWorklet. Plain functions and classes with no audio-API globals, so
// the same code runs in the worklet and in Node for tests.

import { defaultPatch, type Patch, type SynthMessage } from "./patch";

/** Samples per control block: envelopes and engine parameters update this often. */
export const CB = 16;

/** The sample rate. Plaits runs at 48 kHz; constants given in samples are scaled from that. */
let SR = 48000;


/** Engines that make their own decay (struck strings and resonators), so the low-pass gate is bypassed. */
const SELF_ENVELOPED = [false, false, false, false, false, false, true, true];

// ---- Tables and helpers -------------------------------------------------------

const TAU = Math.PI * 2;
const SINE = new Float32Array(513 + 128);
for (let i = 0; i < SINE.length; i++) SINE[i] = Math.sin((TAU * i) / 512);

/** sin(2π·phase), any phase. */
function sine(phase: number): number {
  const p = (phase - Math.floor(phase)) * 512;
  const i = p | 0;
  return SINE[i] + (SINE[i + 1] - SINE[i]) * (p - i);
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const semis = (s: number) => 2 ** (s / 12);

function interpolate(table: Float32Array, index: number, size: number): number {
  index *= size;
  const i = Math.max(0, Math.min(table.length - 2, Math.floor(index)));
  const f = index - i;
  return table[i] + (table[i + 1] - table[i]) * f;
}

/** Hermite interpolation; `offset` is the C++ `table + 1`. */
function hermite(table: Float32Array, offset: number, index: number, size: number): number {
  index *= size;
  const i = Math.floor(index);
  const f = index - i;
  const j = offset + i;
  const xm1 = table[j - 1], x0 = table[j], x1 = table[j + 1], x2 = table[j + 2];
  const c = (x1 - xm1) * 0.5;
  const v = x0 - x1;
  const w = c + v;
  const a = w + v + (x2 - x0) * 0.5;
  const bNeg = w + a;
  return ((a * f - bNeg) * f + c) * f + x0;
}

const thisBlep = (t: number) => 0.5 * t * t;
const nextBlep = (t: number) => { t = 1 - t; return -0.5 * t * t; };
function nextIntBlep(t: number): number {
  const t1 = 0.5 * t, t2 = t1 * t1;
  return 0.1875 - t1 + 1.5 * t2 - t2 * t2;
}
const thisIntBlep = (t: number) => nextIntBlep(1 - t);

const PI3 = Math.PI ** 3, PI5 = Math.PI ** 5;
const tanDirty = (f: number) => f * (Math.PI + 3.736e-1 * PI3 * f * f);
function tanFast(f: number): number {
  const f2 = f * f;
  return f * (Math.PI + f2 * (3.26e-1 * PI3 + 1.823e-1 * PI5 * f2));
}

/** stmlib's state-variable filter, low-pass and band-pass. */
class Svf {
  g = 0; r = 1; h = 1; s1 = 0; s2 = 0;
  set(g: number, q: number): void {
    this.g = g;
    this.r = 1 / q;
    this.h = 1 / (1 + this.r * g + g * g);
  }
  lp(x: number): number {
    const hp = (x - this.r * this.s1 - this.g * this.s1 - this.s2) * this.h;
    const bp = this.g * hp + this.s1;
    this.s1 = this.g * hp + bp;
    const lp = this.g * bp + this.s2;
    this.s2 = this.g * bp + lp;
    return lp;
  }
}

// FM ratios (Plaits lookup_tables.py), quantized with a plateau at each ratio.
const FM_RATIOS = (() => {
  const ratios = [0.5, 0.5 * semis(16 / 100), Math.SQRT2 / 2, Math.PI / 4, 1, semis(16 / 100), Math.SQRT2, Math.PI / 2, 7 / 4, 2,
    2 * semis(16 / 100), 9 / 4, 11 / 4, 2 * Math.SQRT2, 3, Math.PI, Math.sqrt(3) * 2, 4, Math.SQRT2 * 3, (Math.PI * 3) / 2, 5, Math.SQRT2 * 4, 8];
  const scale: number[] = [];
  for (const r of ratios) {
    const s = 12 * Math.log2(r);
    scale.push(s, s, s);
  }
  while (scale.length < 128) {
    let gap = 0, best = -1;
    for (let i = 0; i + 1 < scale.length; i++) if (scale[i + 1] - scale[i] > best) { best = scale[i + 1] - scale[i]; gap = i; }
    scale.splice(gap + 1, 0, (scale[gap] + scale[gap + 1]) / 2);
  }
  scale.push(scale[scale.length - 1], scale[scale.length - 1]);
  return Float32Array.from(scale);
})();

// Waveshaper curves (borrowed by Plaits from Tides), 257 points each, -1..1.
const WAVESHAPERS = (() => {
  const n = 128;
  const xs = Array.from({ length: n + 1 }, (_, i) => i / n);
  const scale = Math.atan(8);
  const curves = [
    xs.map((x) => Math.acos(Math.tan(scale * (1 - 2 * x)) / 8) / Math.PI),
    xs.map((x) => Math.acos(1 - 2 * x) / Math.PI),
    xs,
    xs.map((x) => ((1 - Math.cos(Math.PI * x * 1.5)) * (1 - Math.cos(Math.PI * Math.min(1, 4 - 4 * x)))) / 4.5),
    xs.map((x) => Math.sin(Math.PI * x * 1.5)),
  ];
  curves.push(curves[4]);
  return curves.map((c) => Float32Array.from([...c.slice(1).reverse().map((v) => -v), ...c]));
})();

const FOLD = (() => {
  const t = new Float32Array(516);
  let max = 0;
  for (let i = 0; i < 516; i++) {
    const x = Math.min(i, 514) / 256 - 1;
    const window = Math.exp(-x * x * 4) ** 2;
    t[i] = Math.sin(8 * Math.PI * x) * window + Math.atan(3 * x) * (1 - window);
    max = Math.max(max, Math.abs(t[i]));
  }
  for (let i = 0; i < t.length; i++) t[i] /= max;
  return t;
})();

const STIFFNESS = (() => {
  const t = new Float32Array(65);
  for (let i = 0; i < 65; i++) {
    let g = i / 64;
    if (g < 0.25) t[i] = -(0.25 - g) * 0.25;
    else if (g < 0.3) t[i] = 0;
    else if (g < 0.9) t[i] = 0.01 * 10 ** (((g - 0.3) / 0.6) * 2.005) - 0.01;
    else {
      g = ((g - 0.9) / 0.1) ** 2;
      t[i] = 1.5 - Math.cos(g * Math.PI) / 2;
    }
  }
  t[63] = t[64] = 2;
  return t;
})();

const SVF_SHIFT = Float32Array.from({ length: 257 }, (_, i) => 1 - (2 * Math.atan(1 / semis(i))) / TAU);

// ---- Engines ----------------------------------------------------------------------

/** What an engine sees each control block, after the envelope modulations. */
export interface EngineParams {
  /** Frequency in cycles per sample. */
  f0: number;
  /** The same pitch as a MIDI note. */
  note: number;
  harmonics: number;
  timbre: number;
  morph: number;
  accent: number;
  /** A new note starts this block. */
  trigger: boolean;
}

interface Engine {
  /** Write `n` samples into `out` from index 0. */
  render(p: EngineParams, out: Float32Array, n: number): void;
}

/** Plaits' variable-shape oscillator, triangle to saw to square/pulse, without sync. */
class VariableShape {
  private phase = 0;
  private next = 0;
  private prevPw = 0.5;
  private high = false;

  render(freq: number, pw: number, shape: number, out: Float32Array, n: number, gain: number, add: boolean): void {
    if (freq >= 0.25) { freq = 0.25; pw = 0.5; } else pw = clamp(pw, freq * 2, 1 - 2 * freq);
    const sq = Math.max(shape - 0.5, 0) * 2;
    const tri = Math.max(1 - shape * 2, 0);
    const up = 1 / pw, down = 1 / (1 - pw);
    let next = this.next, phase = this.phase, high = this.high;
    for (let i = 0; i < n; i++) {
      let s = next;
      next = 0;
      phase += freq;
      for (;;) {
        if (!high) {
          if (phase < pw) break;
          const t = (phase - pw) / (this.prevPw - pw + freq);
          const step = (up + down) * freq * tri;
          s += sq * thisBlep(t);
          next += sq * nextBlep(t);
          s -= step * thisIntBlep(t);
          next -= step * nextIntBlep(t);
          high = true;
        }
        if (phase < 1) break;
        phase -= 1;
        const t = phase / freq;
        const step = (up + down) * freq * tri;
        s -= (1 - tri) * thisBlep(t);
        next -= (1 - tri) * nextBlep(t);
        s += step * thisIntBlep(t);
        next += step * nextIntBlep(t);
        high = false;
      }
      let naive = phase;
      const square = phase < pw ? 0 : 1;
      const triangle = phase < pw ? phase * up : 1 - (phase - pw) * down;
      naive += (square - naive) * sq;
      naive += (triangle - naive) * tri;
      next += naive;
      this.prevPw = pw;
      const v = (2 * s - 1) * gain;
      out[i] = add ? out[i] + v : v;
    }
    this.next = next;
    this.phase = phase;
    this.high = high;
  }
}

const VA_INTERVALS = [0, 7.01, 12.01, 19.01, 24.01];
const squash = (x: number) => x * x * (3 - 2 * x);

/** Two variable-shape oscillators. Harmonics detunes the second, Timbre and Morph shape each. */
class AnalogEngine implements Engine {
  private a = new VariableShape();
  private b = new VariableShape();

  render(p: EngineParams, out: Float32Array, n: number): void {
    let d = clamp(2.05 * p.harmonics - 1.025, -1, 1);
    const sign = d < 0 ? -1 : 1;
    d = d * sign * 3.9999;
    const di = Math.floor(d);
    const detune = (VA_INTERVALS[di] + (VA_INTERVALS[di + 1] - VA_INTERVALS[di]) * squash(squash(d - di))) * sign;
    this.a.render(p.f0, clamp(0.5 + (p.timbre - 0.66) * 1.4, 0.5, 0.99), clamp(p.timbre * 1.5, 0, 1), out, n, 0.5, false);
    this.b.render(p.f0 * semis(detune), clamp(0.5 + (p.morph - 0.66) * 1.4, 0.5, 0.99), clamp(p.morph * 1.5, 0, 1), out, n, 0.5, true);
  }
}

/** A band-limited slope (triangle to ramp) oscillator. */
class Slope {
  private phase = 0;
  private next = 0;
  private high = true;

  render(freq: number, pw: number, out: Float32Array, n: number): void {
    freq = clamp(freq, 0.000001, 0.25);
    pw = clamp(pw, freq * 2, 1 - 2 * freq);
    const up = 1 / pw, down = 1 / (1 - pw);
    const disc = (up + down) * freq;
    let next = this.next, phase = this.phase, high = this.high;
    for (let i = 0; i < n; i++) {
      let s = next;
      next = 0;
      phase += freq;
      if (high !== phase < pw) {
        const t = (phase - pw) / freq;
        s -= thisIntBlep(t) * disc;
        next -= nextIntBlep(t) * disc;
        high = phase < pw;
      }
      if (phase >= 1) {
        phase -= 1;
        const t = phase / freq;
        s += thisIntBlep(t) * disc;
        next += nextIntBlep(t) * disc;
        high = true;
      }
      next += high ? phase * up : 1 - (phase - pw) * down;
      out[i] = 2 * s - 1;
    }
    this.next = next;
    this.phase = phase;
    this.high = high;
  }
}

function tame(f0: number, harmonics: number, order: number): number {
  f0 *= harmonics;
  const maxF = 0.5 / order;
  const a = clamp(1 - (f0 - maxF) / (0.5 - maxF), 0, 1);
  return a * a * a;
}

/** A slope through a waveshaper and a wavefolder. Harmonics picks the shaper, Timbre folds, Morph skews. */
class FoldEngine implements Engine {
  private slope = new Slope();

  render(p: EngineParams, out: Float32Array, n: number): void {
    this.slope.render(p.f0, p.morph * 0.45 + 0.5, out, n);
    const slope = 3 + Math.abs(p.morph - 0.5) * 5;
    const shapeAmount = Math.abs(p.harmonics - 0.5) * 2;
    const shapeAtt = tame(p.f0, slope, 16);
    const foldAtt = tame(p.f0, slope * (3 + shapeAmount * shapeAtt * 5), 12);
    let shape = (0.5 + (p.harmonics - 0.5) * shapeAtt) * 3.9999;
    const si = Math.floor(shape);
    shape -= si;
    const s1 = WAVESHAPERS[si], s2 = WAVESHAPERS[si + 1];
    const gain = 0.03 + 0.46 * p.timbre * foldAtt;
    for (let i = 0; i < n; i++) {
      let w = 127 * out[i] + 128;
      const wi = Math.floor(w) & 255;
      w -= Math.floor(w);
      const x = s1[wi] + (s1[wi + 1] - s1[wi]) * w;
      const y = s2[wi] + (s2[wi + 1] - s2[wi]) * w;
      out[i] = hermite(FOLD, 1, (x + (y - x) * shape) * gain + 0.5, 512);
    }
  }
}

const FIR = [0.02442415, 0.09297315, 0.16712938, 0.21547332];

/** Two-operator phase modulation at 4x oversampling. Harmonics is the ratio, Timbre the index, Morph feedback. */
class FmEngine implements Engine {
  private carrier = 0;
  private modulator = 0;
  private prev = 0;
  private head = 0;

  render(p: EngineParams, out: Float32Array, n: number): void {
    const ratio = interpolate(FM_RATIOS, p.harmonics, 128);
    const carF = p.f0 / 4;
    const modF = Math.min(0.5, carF * semis(ratio));
    let taming = clamp(1 - (p.note - 24 + ratio - 72) * 0.025, 0, 1);
    taming *= taming;
    const amount = 2 * p.timbre * p.timbre * taming;
    const fb = 2 * p.morph - 1;
    const phaseFb = fb < 0 ? 0.5 * fb * fb : 0;
    const modFb = fb > 0 ? 0.25 * fb * fb : 0;
    let head = this.head, tail = 0, prev = this.prev, car = this.carrier, mod = this.modulator;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < 4; j++) {
        mod += modF * (1 + prev * phaseFb);
        mod -= Math.floor(mod);
        car += carF;
        if (car >= 1) car -= 1;
        const m = sine(mod + modFb * prev);
        const c = sine(car + amount * m);
        prev += 0.05 * (c - prev);
        head += c * FIR[3 - j];
        tail += c * FIR[j];
      }
      out[i] = head;
      head = tail;
      tail = 0;
    }
    this.head = head;
    this.prev = prev;
    this.carrier = car;
    this.modulator = mod;
  }
}

/** Plaits' grainlet: a carrier window shaping a formant sine, hard-synced to the note. */
class Grainlet {
  private carrier = 0;
  private formant = 0;
  private next = 0;

  private static window(phase: number, shape: number): number {
    shape *= 3;
    const si = Math.floor(shape);
    let t = 1 - (shape - si);
    if (si === 0) {
      phase = Math.min(1, phase * (1 + t * t * t * 15)) + 0.75;
    } else if (si === 1) {
      const bp = 0.001 + 0.499 * t * t * t;
      phase = (phase < bp ? phase * (0.5 / bp) : 0.5 + ((phase - bp) * 0.5) / (1 - bp)) + 0.75;
    } else {
      t = 1 - t;
      phase = Math.min(0.75, 0.25 + phase * (0.5 + t * t * t * 14.5));
    }
    return (sine(phase) + 1) * 0.25;
  }

  private static grain(carrier: number, formant: number, shape: number, bleed: number): number {
    return (Grainlet.window(carrier, shape) * (sine(formant) + bleed)) / (1 + bleed);
  }

  render(f0: number, f1: number, shape: number, bleed: number, out: Float32Array, n: number, add: boolean): void {
    f0 = Math.min(f0, 0.125);
    f1 = Math.min(f1, 0.25);
    let next = this.next;
    for (let i = 0; i < n; i++) {
      let s = next;
      next = 0;
      this.carrier += f0;
      if (this.carrier >= 1) {
        this.carrier -= 1;
        const rt = this.carrier / f0;
        const before = Grainlet.grain(1, this.formant + (1 - rt) * f1, shape, bleed);
        const after = Grainlet.grain(0, 0, shape, bleed);
        const d = after - before;
        s += d * thisBlep(rt);
        next += d * nextBlep(rt);
        this.formant = rt * f1;
      } else {
        this.formant += f1;
        if (this.formant >= 1) this.formant -= 1;
      }
      next += Grainlet.grain(this.carrier, this.formant, shape, bleed);
      out[i] = add ? out[i] + s : s;
    }
    this.next = next;
  }
}

/** Two grainlets a ratio apart. Harmonics sets the ratio, Timbre the formant, Morph the window. */
class GrainEngine implements Engine {
  private a = new Grainlet();
  private b = new Grainlet();
  private lp = 0;

  render(p: EngineParams, out: Float32Array, n: number): void {
    const f1 = (440 / SR) * semis(24 + 84 * p.timbre - 69);
    const ratio = semis(-24 + 48 * p.harmonics);
    const bleed = p.harmonics < 0.5 ? 1 - 2 * p.harmonics : 0;
    const bleedFixed = bleed * (2 - bleed);
    const shape = 0.33 + (p.morph - 0.33) * Math.max(1 - p.f0 * 24, 0);
    this.a.render(p.f0, f1, shape, bleedFixed, out, n, false);
    this.b.render(p.f0, f1 * ratio, shape, bleedFixed, out, n, true);
    // DC blocker at 0.3 f0.
    const k = 1 - Math.exp(-TAU * 0.3 * p.f0);
    let lp = this.lp;
    for (let i = 0; i < n; i++) {
      lp += k * (out[i] - lp);
      out[i] -= lp;
    }
    this.lp = lp;
  }
}

const NUM_HARMONICS = 24;

/** 24 sine harmonics. Timbre is the spectral centroid, Morph the slope, Harmonics adds bumps. */
class AdditiveEngine implements Engine {
  private amps = new Float32Array(NUM_HARMONICS);
  private phase = 0;

  render(p: EngineParams, out: Float32Array, n: number): void {
    const bumpsRaw = p.harmonics;
    const slopeRaw = (1 - 0.6 * bumpsRaw) * p.morph;
    const slope = 0.01 + 1.99 * slopeRaw * slopeRaw * slopeRaw;
    const bumps = 16 * bumpsRaw * bumpsRaw;
    const count = NUM_HARMONICS - 1;
    const margin = (1 / slope - 1) / (1 + bumps);
    const center = p.timbre * (count + margin) - 0.5 * margin;
    const amps = this.amps;
    let sum = 0.001;
    for (let i = 0; i < NUM_HARMONICS; i++) {
      const order = Math.abs(i - center) * slope;
      let g = 1 - order;
      g += Math.abs(g);
      g *= g;
      g *= 1 + sine(0.25 + order * bumps);
      g *= g;
      g *= g;
      amps[i] += 0.0015 * (g - amps[i]);
      sum += amps[i];
    }
    const f = Math.min(p.f0, 0.5);
    let phase = this.phase;
    for (let s = 0; s < n; s++) {
      phase += f;
      if (phase >= 1) phase -= 1;
      const twoX = 2 * sine(phase);
      let prev = 1, cur = twoX * 0.5, acc = 0;
      for (let i = 0; i < NUM_HARMONICS; i++) {
        const hf = f * (i + 1);
        if (hf >= 0.5) break;
        acc += (amps[i] / sum) * (1 - hf * 2) * cur;
        const t = cur;
        cur = twoX * cur - prev;
        prev = t;
      }
      out[s] = acc;
    }
    this.phase = phase;
  }
}

// Divide-down registrations from Plaits' chord engine: saw/square at 8', 4', 2'.
const REGISTRATIONS = [
  [0, 1, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0], [0.5, 0, 0.5, 0, 0, 0], [0.33, 0, 0.33, 0, 0.33, 0],
  [0.33, 0, 0, 0.33, 0, 0.33], [0.5, 0, 0, 0, 0, 0.5], [0, 0.5, 0, 0, 0, 0.5], [0, 0.1, 0.1, 0, 0.2, 0.6],
];

/**
 * The string-machine / organ voice of Plaits' chord engine: band-limited saws
 * and squares at four footages from one phase counter, then an ensemble
 * chorus. Morph sweeps the registration, Timbre the ensemble, Harmonics the
 * brightness.
 */
class StringsEngine implements Engine {
  private phase = 0;
  private next = 0;
  private segment = 0;
  private reg = new Float32Array(7);
  private line = new Float32Array(1024);
  private wp = 0;
  private lfo = Math.random();
  private lp = 0;

  render(p: EngineParams, out: Float32Array, n: number): void {
    let r = p.morph * (REGISTRATIONS.length - 1.001);
    const ri = Math.floor(r);
    r -= ri;
    const reg = this.reg;
    for (let i = 0; i < 6; i++) reg[i] = REGISTRATIONS[ri][i] + (REGISTRATIONS[ri + 1][i] - REGISTRATIONS[ri][i]) * r;
    reg[6] = 0;
    // High notes lose their lowest footages, as on a divide-down organ.
    let freq = p.f0 * 8;
    let shift = 0;
    while (freq > 0.5) { shift += 2; freq *= 0.5; }
    if (shift >= 8) { out.fill(0, 0, n); return; }
    for (let i = 6; i >= 0; i--) reg[i] = i - shift >= 0 ? reg[i - shift] : 0;
    const gain = clamp(4 - p.f0 * 32, 0, 1);
    const g8 = (reg[0] + 2 * reg[1]) * gain;
    const g4 = (reg[2] - reg[1] + 2 * reg[3]) * gain;
    const g2 = (reg[4] - reg[3] + 2 * reg[5]) * gain;
    const g1 = (reg[6] - reg[5]) * gain;
    let phase = this.phase, next = this.next, segment = this.segment;
    for (let i = 0; i < n; i++) {
      let s = next;
      next = 0;
      phase += freq;
      let ns = Math.floor(phase);
      if (ns !== segment) {
        let d = 0;
        if (ns === 8) { phase -= 8; ns -= 8; d -= g8; }
        if ((ns & 3) === 0) d -= g4;
        if ((ns & 1) === 0) d -= g2;
        d -= g1;
        if (d !== 0) {
          const t = (phase - ns) / freq;
          s += thisBlep(t) * d;
          next += nextBlep(t) * d;
        }
      }
      segment = ns;
      next += (phase - 4) * g8 * 0.125;
      next += (phase - (segment & 4) - 2) * g4 * 0.25;
      next += (phase - (segment & 6) - 1) * g2 * 0.5;
      next += (phase - (segment & 7) - 0.5) * g1;
      out[i] = 2 * s;
    }
    this.phase = phase;
    this.next = next;
    this.segment = segment;
    // Brightness, then a two-tap ensemble with slowly drifting delays.
    const k = 1 - Math.exp(-TAU * Math.min(0.45, (300 / SR) * semis(p.harmonics * 60)));
    const depth = p.timbre;
    const line = this.line, mask = line.length - 1;
    let lp = this.lp, wp = this.wp, lfo = this.lfo;
    const rate = 0.6 / SR;
    for (let i = 0; i < n; i++) {
      lp += k * (out[i] - lp);
      line[wp] = lp;
      lfo += rate;
      if (lfo >= 1) lfo -= 1;
      let wet = 0;
      for (let tap = 0; tap < 2; tap++) {
        const d = (SR / 48000) * (240 + 160 * depth * sine(lfo + tap * 0.33) + tap * 90);
        const pos = wp - d;
        const pi = Math.floor(pos);
        const f = pos - pi;
        const a = line[pi & mask], b = line[(pi + 1) & mask];
        wet += a + (b - a) * f;
      }
      out[i] = lp + (wet * 0.5 - lp) * depth * 0.6;
      wp = (wp + 1) & mask;
    }
    this.lp = lp;
    this.wp = wp;
    this.lfo = lfo;
  }
}

const STRING_LINE = 2048;
const LINE_MASK = STRING_LINE - 1;

/**
 * Plaits' string model (from Rings): a Karplus-Strong delay line with a
 * damping filter, dispersion or a curved bridge. Harmonics is the
 * inharmonicity, Timbre the brightness, Morph how long it rings.
 */
class PluckEngine implements Engine {
  private line = new Float32Array(STRING_LINE);
  private wp = 0;
  private stretch = new Float32Array(STRING_LINE / 4);
  private swp = 0;
  private damp = new Svf();
  private exc = new Svf();
  private dcX = 0;
  private dcY = 0;
  private noise = 0;
  private bridge = 0;
  private delay = 100;
  private remaining = 0;

  private read(d: number): number {
    const i = Math.floor(d), f = d - i;
    const a = this.line[(this.wp + i) & LINE_MASK], b = this.line[(this.wp + i + 1) & LINE_MASK];
    return a + (b - a) * f;
  }

  private readHermite(d: number): number {
    const i = Math.floor(d), f = d - i, t = this.wp + i;
    const xm1 = this.line[(t - 1) & LINE_MASK], x0 = this.line[t & LINE_MASK], x1 = this.line[(t + 1) & LINE_MASK], x2 = this.line[(t + 2) & LINE_MASK];
    const c = (x1 - xm1) * 0.5, v = x0 - x1, w = c + v, a = w + v + (x2 - x0) * 0.5, bNeg = w + a;
    return ((a * f - bNeg) * f + c) * f + x0;
  }

  render(p: EngineParams, out: Float32Array, n: number): void {
    let brightness = p.timbre * p.timbre;
    let damping = p.morph;
    brightness += 0.25 * p.accent * (1 - brightness);
    damping += 0.25 * p.accent * (1 - damping);
    const f0 = p.f0;
    if (p.trigger) {
      const cutoff = Math.min(4 * f0 * semis((brightness * (2 - brightness) - 0.5) * 72), 0.499);
      this.remaining = Math.floor(1 / f0);
      this.exc.set(tanDirty(cutoff), 0.5);
    }
    const s0 = p.harmonics;
    const nl = s0 < 0.24 ? (s0 - 0.24) * 4.166 : s0 > 0.26 ? (s0 - 0.26) * 1.35135 : 0;
    const dispersion = nl > 0;
    const amount = Math.abs(nl);
    const delay = clamp(1 / f0, 4, STRING_LINE - 4);
    let dampCut = Math.min(12 + damping * damping * 60 + brightness * 24, 84);
    let dampF = Math.min(f0 * semis(dampCut), 0.499);
    if (damping >= 0.95) {
      const inf = 20 * (damping - 0.95);
      brightness += inf * (1 - brightness);
      dampF += inf * (0.4999 - dampF);
      dampCut += inf * (128 - dampCut);
    }
    this.damp.set(tanFast(dampF), 0.5);
    const target = delay * interpolate(SVF_SHIFT, dampCut, 1);
    const stretchPoint = amount * (2 - amount) * 0.225;
    const stretchCorr = clamp((160 / SR) * delay, 1, 2.1);
    const noiseSqrt = amount > 0.75 ? 4 * (amount - 0.75) : 0;
    const noiseAmount = noiseSqrt * noiseSqrt * 0.1;
    const noiseFilter = 0.06 + 0.94 * brightness * brightness;
    const curving = amount * amount * 0.01;
    const apGain = (-0.618 * amount) / (0.15 + amount);
    const start = this.delay, step = (target - start) / n;
    const pole = 1 - 20 / SR;
    for (let i = 0; i < n; i++) {
      let d = start + step * (i + 1);
      if (!dispersion) d *= 1 - this.bridge * curving;
      else if (noiseAmount > 0) {
        this.noise += noiseFilter * (Math.random() - 0.5 - this.noise);
        d *= 1 + this.noise * noiseAmount;
      }
      let s: number;
      const ap = d * stretchPoint;
      const main = d - ap * (0.408 - stretchPoint * 0.308) * stretchCorr;
      if (dispersion && ap >= 4 && main >= 4) {
        s = this.read(main);
        const M = this.stretch.length - 1;
        const r = this.stretch[(this.swp + Math.floor(ap)) & M];
        const w = s + apGain * r;
        this.stretch[this.swp] = w;
        this.swp = (this.swp - 1) & M;
        s = -w * apGain + r;
      } else s = this.readHermite(d);
      if (!dispersion) {
        const value = Math.abs(s) - 0.025;
        this.bridge = (Math.abs(value) + value) * (s > 0 ? 1 : -1.5);
      }
      let e = 0;
      if (this.remaining > 0) {
        this.remaining--;
        e = Math.random() * 2 - 1;
      }
      s += this.exc.lp(e);
      s = clamp(s, -20, 20);
      const y = s - this.dcX + pole * this.dcY;
      this.dcX = s;
      this.dcY = y;
      s = this.damp.lp(y);
      this.line[this.wp] = s;
      this.wp = (this.wp - 1) & LINE_MASK;
      out[i] = s;
    }
    this.delay = target;
  }
}

/**
 * Plaits' modal resonator (from Rings): a bank of band-pass modes struck by a
 * filtered click. Harmonics is the structure (from inharmonic to bell),
 * Timbre the brightness, Morph how long it rings.
 */
class ModalEngine implements Engine {
  private s1: Float32Array;
  private s2: Float32Array;
  private g: Float32Array;
  private r: Float32Array;
  private h: Float32Array;
  private a: Float32Array;
  private amps: Float32Array;
  private exc = new Svf();
  private structure = 0;
  private click = new Float32Array(CB * 8);

  constructor(private modes = 24) {
    this.s1 = new Float32Array(modes);
    this.s2 = new Float32Array(modes);
    this.g = new Float32Array(modes);
    this.r = new Float32Array(modes);
    this.h = new Float32Array(modes);
    this.a = new Float32Array(modes);
    this.amps = Float32Array.from({ length: modes }, (_, i) => Math.cos(TAU * 0.015 * i) * 0.25);
  }

  render(p: EngineParams, out: Float32Array, n: number): void {
    this.structure += 0.013 * (p.harmonics - this.structure);
    const structure = this.structure;
    let brightness = p.timbre + 0.25 * p.accent * (1 - p.timbre);
    const damping = p.morph + 0.25 * p.accent * (1 - p.morph);
    const cutoff = Math.min(2 * p.f0 * semis((brightness * (2 - brightness) - 0.5) * 60), 0.499);
    const click = this.click;
    click.fill(0, 0, n);
    if (p.trigger) {
      const amp = (0.12 + 0.08 * p.accent) * (1 - damping * 0.5);
      click[0] = (amp * semis(cutoff * cutoff * 24)) / cutoff;
    }
    this.exc.set(tanFast(cutoff), 1.5);
    let stiffness = interpolate(STIFFNESS, structure, 64);
    // Compensate so the third partial stays put.
    let stretch = 1, st = stiffness;
    for (let i = 0; i < 2; i++) { stretch += st; st *= st < 0 ? 0.93 : 0.98; }
    const f0 = p.f0 / stretch;
    let harmonic = f0;
    stretch = 1;
    const qs = semis(damping * 79.7);
    let q = 500 * qs * qs;
    brightness *= 1 - structure * 0.3;
    brightness *= 1 - damping * 0.3;
    const qLoss = brightness * (2 - brightness) * 0.85 + 0.15;
    let count = 0;
    for (let i = 0; i < this.modes; i++) {
      const mf = Math.min(harmonic * stretch, 0.499);
      if (mf < 0.499) {
        const g = tanFast(mf), r = 1 / (1 + mf * q);
        this.g[count] = g;
        this.r[count] = r + g;
        this.h[count] = 1 / (1 + r * g + g * g);
        this.a[count] = this.amps[i] * (1 - mf * 2);
        if (count !== i) { this.s1[count] = this.s1[i]; this.s2[count] = this.s2[i]; }
        count++;
      }
      stretch += stiffness;
      stiffness *= stiffness < 0 ? 0.93 : 0.98;
      harmonic += f0;
      q *= qLoss;
    }
    const { s1, s2, g, r, h, a } = this;
    for (let i = 0; i < n; i++) {
      const x = this.exc.lp(click[i]);
      let y = 0;
      for (let m = 0; m < count; m++) {
        const hp = (x - r[m] * s1[m] - s2[m]) * h[m];
        const bp = g[m] * hp + s1[m];
        s1[m] = g[m] * hp + bp;
        const lp = g[m] * bp + s2[m];
        s2[m] = g[m] * bp + lp;
        y += a[m] * bp;
      }
      out[i] = y;
    }
  }
}

/** Output level per engine, so they sit at about the same loudness. */
const ENGINE_GAIN = [0.47, 0.72, 0.53, 0.82, 1.18, 1.2, 3.2, 1.7];

function makeEngine(kind: number, chord: boolean): Engine {
  switch (kind) {
    case 1: return new FoldEngine();
    case 2: return new FmEngine();
    case 3: return new GrainEngine();
    case 4: return new AdditiveEngine();
    case 5: return new StringsEngine();
    case 6: return new PluckEngine();
    // Chords run a resonator per note, so they get half the modes.
    case 7: return new ModalEngine(chord ? 12 : 24);
    default: return new AnalogEngine();
  }
}

// ---- Voices -------------------------------------------------------------------------

const MAX_NOTES = 6;

class Sub {
  engines: (Engine | undefined)[] = [];
  /** Semitones above the voice's pitch. */
  offset = 0;
  amp = 0;
  level = 0;
  note = -1;
}

const modAmount = (a: number) => a * Math.max(Math.abs(a) - 0.05, 0.05) * 1.05;

class Voice {
  subs: Sub[];
  /** The chord's notes as semitones above its lowest, ascending. */
  base = new Float32Array(MAX_NOTES);
  count = 1;
  noteStart = new Float64Array(MAX_NOTES);
  noteOn = new Uint8Array(MAX_NOTES);
  noteTrig = new Uint8Array(MAX_NOTES);
  id = -1;
  pitch = 60;
  target = 60;
  gate = false;
  offAt = Infinity;
  velocity = 0;
  active = false;
  age = 0;
  env = 0;
  /** The low-pass gate is opening after a trigger (Plaits' ping). */
  ramp = false;
  vactrol = 0;
  attack = 1;
  gain = 0;
  quiet = 0;
  subPhase = 0;
  lpg = new Svf();
  buf = new Float32Array(CB);
  tmp = new Float32Array(CB);
  params: EngineParams = { f0: 0, note: 60, harmonics: 0, timbre: 0, morph: 0, accent: 0, trigger: false };

  constructor(private chord: boolean) {
    this.subs = Array.from({ length: chord ? MAX_NOTES + 1 : 1 }, () => new Sub());
  }

  start(id: number, notes: number[], velocity: number, at: number, duration: number, strum: number, from: number | null, age: number): void {
    const sorted = notes.slice(0, MAX_NOTES).sort((a, b) => a - b);
    this.count = sorted.length;
    for (let i = 0; i < this.count; i++) {
      this.base[i] = sorted[i] - sorted[0];
      this.noteStart[i] = at + i * strum;
      this.noteOn[i] = 0;
    }
    this.id = id;
    this.target = sorted[0];
    this.pitch = from ?? this.target;
    this.gate = true;
    this.offAt = at + duration;
    this.velocity = velocity;
    this.env = 1;
    this.ramp = true;
    this.attack = 0;
    this.active = true;
    this.quiet = 0;
    this.age = age;
  }

  /** Which note each sub plays and how loud: Plaits' chord inversion, with one spare voice to crossfade through. */
  private voiceChord(inversion: number): void {
    const n = this.count;
    const subs = this.subs;
    if (n === 1 || !this.chord) {
      subs[0].offset = 0;
      subs[0].amp = 1;
      subs[0].note = 0;
      for (let j = 1; j < subs.length; j++) { subs[j].amp = 0; subs[j].note = -1; }
      return;
    }
    const V = n + 1;
    const k = clamp(inversion, 0, 1) * 2 * n;
    const ki = Math.min(Math.floor(k), 2 * n);
    const frac = ki === 2 * n ? 0 : k - ki;
    const rotations = Math.floor(ki / n);
    const rotated = ki % n;
    for (let j = 0; j < subs.length; j++) { subs[j].amp = 0; subs[j].note = -1; }
    for (let i = 0; i < n; i++) {
      const offset = this.base[i] + 12 * (Math.floor((n - 1 + ki - i) / n) - 1);
      const target = (((i - rotations) % V) + V) % V;
      const prev = (target - 1 + V) % V;
      if (i === rotated) {
        subs[target].offset = offset;
        subs[target].amp = 1 - frac;
        subs[target].note = i;
        subs[prev].offset = offset + 12;
        subs[prev].amp = frac;
        subs[prev].note = i;
      } else {
        const j = i < rotated ? prev : target;
        subs[j].offset = offset;
        subs[j].amp = 1;
        subs[j].note = i;
      }
    }
  }

  /** Render one control block into `out` at `at`, `now` being the block's first sample. */
  render(patch: Patch, wobble: number, now: number, out: Float32Array, at: number, level: number): void {
    if (this.gate && now >= this.offAt) this.gate = false;
    if (this.pitch !== this.target) {
      const glide = patch.glide * patch.glide * 0.3;
      const k = glide > 0.002 ? 1 - Math.exp(-CB / (glide * SR)) : 1;
      this.pitch += (this.target - this.pitch) * k;
      if (Math.abs(this.target - this.pitch) < 0.001) this.pitch = this.target;
    }
    // Plaits' decay envelope and low-pass gate, run per block as on the module.
    const decay = patch.decay;
    const shortDecay = ((200 * CB) / SR) * semis(-96 * decay);
    this.env *= Math.max(0, 1 - shortDecay * 2);
    // Each note pings the gate open at a speed that follows its pitch. Plaits then lets it
    // decay; here long Decay settings also hold it partly open for as long as the note is held.
    let input: number;
    if (this.ramp) {
      this.vactrol += Math.max(0.02, (440 / SR) * semis(this.pitch - 69) * CB * 2);
      if (this.vactrol >= 1) { this.vactrol = 1; this.ramp = false; }
      input = this.vactrol;
    } else input = this.gate ? clamp((decay - 0.6) / 0.35, 0, 1) : 0;
    const hf = patch.colour;
    const tail = ((20 * CB) / SR) * semis(-72 * decay + 12 * hf) - shortDecay;
    const err = input - this.vactrol;
    const v2 = this.vactrol * this.vactrol, v4 = v2 * v2;
    this.vactrol += (err > 0 ? 0.6 : shortDecay + (1 - v4) * tail) * err;
    if (this.attack < 1) this.attack = Math.min(1, this.attack + CB / (Math.max(0.002, patch.attack * patch.attack * 2) * SR));

    const self = SELF_ENVELOPED[patch.engine];
    let gain: number;
    if (self) {
      // Strings and resonators ring by themselves; Decay sets how fast they're damped once the note ends.
      gain = this.gate ? 1 : this.gain * Math.exp(-CB / ((0.08 + 3 * decay * decay) * SR));
    } else gain = this.vactrol;
    gain *= this.attack;

    // Engine parameters, with the envelope pushing Timbre and Morph.
    const p = this.params;
    p.harmonics = patch.harmonics;
    p.timbre = clamp(patch.timbre + modAmount(patch.timbreEnv) * this.env + wobble, 0, 1);
    p.morph = clamp(patch.morph + modAmount(patch.morphEnv) * this.env, 0, 1);
    p.accent = this.velocity;

    for (let i = 0; i < this.count; i++) {
      this.noteTrig[i] = 0;
      if (!this.noteOn[i] && now + CB > this.noteStart[i]) this.noteOn[i] = this.noteTrig[i] = 1;
    }
    this.voiceChord(patch.inversion);
    const buf = this.buf, tmp = this.tmp;
    buf.fill(0);
    let peak = 0;
    for (const sub of this.subs) {
      const target = sub.note >= 0 && this.noteOn[sub.note] ? sub.amp : 0;
      if (target === 0 && sub.level === 0) continue;
      const engine = (sub.engines[patch.engine] ??= makeEngine(patch.engine, this.chord));
      p.note = this.pitch + sub.offset;
      p.f0 = (440 / SR) * semis(p.note - 69);
      p.trigger = sub.note >= 0 && this.noteTrig[sub.note] === 1;
      engine.render(p, tmp, CB);
      const from = sub.level, step = (target - from) / CB;
      for (let i = 0; i < CB; i++) buf[i] += tmp[i] * (from + step * (i + 1));
      sub.level = target;
    }
    if (patch.sub > 0) {
      const f = (440 / SR) * semis(this.pitch - 69);
      for (let i = 0; i < CB; i++) {
        this.subPhase += f;
        if (this.subPhase >= 1) this.subPhase -= 1;
        buf[i] += sine(this.subPhase) * patch.sub * 0.6;
      }
    }
    const scale = (ENGINE_GAIN[patch.engine] * level * this.velocity) / Math.sqrt(this.count);
    const g0 = this.gain, gStep = (gain - g0) / CB;
    if (self) {
      for (let i = 0; i < CB; i++) {
        const s = buf[i] * (g0 + gStep * (i + 1)) * scale;
        out[at + i] += s;
        peak = Math.max(peak, Math.abs(s));
      }
    } else {
      this.lpg.set(tanDirty(Math.min(0.45, (0.003 + 0.3 * v4 + hf * 0.04) * (48000 / SR))), 0.4);
      const t2 = (1 - this.vactrol) ** 2;
      const bleed = (t2 + (1 - t2) * hf) * hf * hf;
      for (let i = 0; i < CB; i++) {
        const s = buf[i] * (g0 + gStep * (i + 1)) * scale;
        const lp = this.lpg.lp(s);
        const y = lp + (s - lp) * bleed;
        out[at + i] += y;
        peak = Math.max(peak, Math.abs(y));
      }
    }
    this.gain = gain;
    // Once released and silent for a while, stop rendering.
    this.quiet = !this.gate && peak < 1e-4 && gain < 0.01 ? this.quiet + CB : 0;
    if (this.quiet > SR * 0.2) {
      this.active = false;
      for (const sub of this.subs) sub.level = 0;
      this.vactrol = this.gain = 0;
    }
  }
}

class Track {
  patch = defaultPatch();
  voices: Voice[];
  last: number | null = null;
  lfo = 0;

  constructor(voices: number, chord: boolean, readonly mono: boolean, readonly level: number) {
    this.voices = Array.from({ length: voices }, () => new Voice(chord));
  }
}

interface Pending {
  at: number;
  msg: SynthMessage;
}

/** Bass, chords and melody, each a pool of Plaits voices. */
export class Synth {
  readonly tracks = [
    new Track(1, false, true, 1),
    new Track(3, true, false, 0.42),
    new Track(4, false, false, 0.55),
  ];
  private pending: Pending[] = [];
  private age = 0;

  constructor(sampleRate: number) {
    SR = sampleRate;
  }

  /** Queue a message; notes and note-offs wait for their time. */
  post(msg: SynthMessage): void {
    if (msg.type === "patch") {
      this.tracks[msg.track].patch = msg.patch;
      return;
    }
    if (msg.type === "allOff") {
      this.pending = [];
      for (const t of this.tracks) for (const v of t.voices) v.gate = false;
      return;
    }
    const at = Math.round(msg.time * SR);
    let i = this.pending.length;
    while (i > 0 && this.pending[i - 1].at > at) i--;
    this.pending.splice(i, 0, { at, msg });
  }

  private apply(msg: SynthMessage, at: number): void {
    if (msg.type === "off") {
      for (const v of this.tracks[msg.track].voices) if (v.id === msg.id) v.offAt = Math.min(v.offAt, at);
      return;
    }
    if (msg.type !== "note") return;
    const track = this.tracks[msg.track];
    const p = track.patch;
    let voice = track.voices[0];
    if (!track.mono) {
      // A free voice, else the one that's been sounding longest.
      for (const v of track.voices) {
        if (!v.active) { voice = v; break; }
        if (v.age < voice.age) voice = v;
      }
    }
    const lowest = Math.min(...msg.notes);
    const from = p.glide > 0.01 ? (track.mono && voice.active ? voice.pitch : track.last) : null;
    voice.start(msg.id, msg.notes, msg.velocity, at, Math.round(msg.duration * SR), p.strum * 0.035 * SR, from, this.age++);
    track.last = lowest;
  }

  /** Fill `outs` (one per track) with `n` samples starting at sample `start` of the audio clock. */
  render(outs: Float32Array[], start: number, n: number): boolean {
    let any = false;
    for (let b = 0; b < n; b += CB) {
      const now = start + b;
      while (this.pending.length && this.pending[0].at < now + CB) {
        const { at, msg } = this.pending.shift()!;
        this.apply(msg, Math.max(at, now));
      }
      for (let t = 0; t < this.tracks.length; t++) {
        const track = this.tracks[t];
        const p = track.patch;
        track.lfo += (p.wobbleHz * CB) / SR;
        if (track.lfo >= 1) track.lfo -= Math.floor(track.lfo);
        const wobble = p.wobbleDepth > 0 ? p.wobbleDepth * 0.35 * sine(track.lfo) : 0;
        for (const v of track.voices) {
          if (!v.active) continue;
          v.render(p, wobble, now, outs[t], b, track.level);
          any = true;
        }
      }
    }
    return any;
  }
}
