/**
 * The melody's random sources, after Mutable Instruments' Marbles.
 *
 * `DejaVuSequence` is a port of Marbles' RandomSequence (marbles/random/
 * random_sequence.h in pichenettes/eurorack), which is MIT licensed:
 *
 *   Copyright 2015 Emilie Gillet.
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *   The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 *
 * The distribution and the quantizer follow the module's behaviour (Spread,
 * Bias and Steps) but are written here: Marbles reads its beta distributions
 * from precomputed tables, and its quantizer works on control voltages
 * rather than on the song's scale and chords.
 */

/** Marbles keeps the last 16 random values for Déjà vu to loop over. */
export const LOOP_SIZE = 16;

/**
 * A stream of random values with Marbles' Déjà vu. At 0 every value is new;
 * towards the middle, more and more of them repeat the last `length` values,
 * until at the middle the loop is locked; past the middle it stays the same
 * loop but jumps round it at random, until at full every step is a jump.
 */
export class DejaVuSequence {
  private loop = new Float32Array(LOOP_SIZE);
  private writeHead = 0;
  private step = 0;
  length = 8;
  dejaVu = 0;

  constructor(private random: () => number) {
    this.reseed();
  }

  /** Fill the loop with fresh values. */
  reseed(): void {
    for (let i = 0; i < LOOP_SIZE; i++) this.loop[i] = this.random();
    this.step = this.length - 1;
  }

  setLength(length: number): void {
    this.length = Math.max(1, Math.min(LOOP_SIZE, Math.round(length)));
    this.step %= this.length;
  }

  /** The next value. `held` replays the loop as it is, as if Déjà vu were at the middle. */
  next(held = false): number {
    const p = (2 * this.dejaVu - 1) ** 2;
    const mutate = !held && this.random() < p;
    if (mutate && this.dejaVu <= 0.5) {
      // A new value, written at the end of the loop.
      this.loop[this.writeHead] = this.random();
      this.writeHead = (this.writeHead + 1) % LOOP_SIZE;
      this.step = this.length - 1;
    } else if (mutate) {
      this.step = Math.floor(this.random() * this.length);
    } else {
      this.step = (this.step + 1) % this.length;
    }
    return this.cell(this.step);
  }

  /** The loop's `k`th value, oldest first. */
  cell(k: number): number {
    return this.loop[(this.writeHead + LOOP_SIZE - this.length + k) % LOOP_SIZE];
  }

  /** Which cell played last. */
  get position(): number {
    return this.step;
  }
}

/** More values from one: Marbles derives a vector from one random number the same way. */
export function spread(seed: number, i: number): number {
  let word = Math.floor(seed * 4294967296) >>> 0;
  for (let k = 0; k <= i; k++) word = (Math.imul(word, 1664525) + 1013904223) >>> 0;
  return word / 4294967296;
}

const ICDF_SIZE = 128;
const PDF_CELLS = 512;

/**
 * How concentrated the distribution is at a Spread: narrow round Bias at the
 * bottom, a broad bell at the middle, flat at three quarters, and pushed out
 * to the edges at the top, as on the module.
 */
function concentration(spread: number): number {
  const points: [number, number][] = [[0, 80], [0.5, 7], [0.75, 2], [1, 0.25]];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1], [x1, y1] = points[i];
    if (spread <= x1) return Math.exp(Math.log(y0) + ((spread - x0) / (x1 - x0)) * (Math.log(y1) - Math.log(y0)));
  }
  return points[points.length - 1][1];
}

/**
 * A beta distribution set by Spread and Bias, as its probability density (for
 * drawing) and its inverse CDF (to turn a uniform random value into a sample).
 */
export class Distribution {
  readonly pdf = new Float32Array(64);
  private icdf = new Float32Array(ICDF_SIZE + 1);
  private key = "";
  spread = 0.5;
  bias = 0.5;

  /** Rebuild the tables if Spread or Bias moved. Cheap enough for a slider drag. */
  set(spread: number, bias: number): void {
    const key = `${spread.toFixed(3)}|${bias.toFixed(3)}`;
    if (key === this.key) return;
    this.key = key;
    this.spread = spread;
    this.bias = bias;
    const k = concentration(spread);
    const mean = Math.min(0.98, Math.max(0.02, bias));
    const a = mean * k, b = (1 - mean) * k;
    const density = new Float64Array(PDF_CELLS);
    let total = 0;
    for (let i = 0; i < PDF_CELLS; i++) {
      const x = (i + 0.5) / PDF_CELLS;
      // In logs, so the very narrow bells don't overflow.
      density[i] = Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x));
      total += density[i];
    }
    let cum = 0, j = 0;
    this.icdf[0] = 0;
    for (let i = 0; i < PDF_CELLS; i++) {
      const next = cum + density[i] / total;
      while (j < ICDF_SIZE && (j + 1) / ICDF_SIZE <= next) {
        j++;
        const frac = (j / ICDF_SIZE - cum) / Math.max(1e-12, next - cum);
        this.icdf[j] = (i + frac) / PDF_CELLS;
      }
      cum = next;
    }
    for (; j < ICDF_SIZE; j++) this.icdf[j + 1] = 1;
    this.icdf[ICDF_SIZE] = 1;
    // A coarse copy of the density, scaled to peak at 1, for the view.
    let peak = 0;
    const per = PDF_CELLS / this.pdf.length;
    for (let i = 0; i < this.pdf.length; i++) {
      let sum = 0;
      for (let q = 0; q < per; q++) sum += density[i * per + q];
      this.pdf[i] = sum;
      peak = Math.max(peak, sum);
    }
    for (let i = 0; i < this.pdf.length; i++) this.pdf[i] /= peak || 1;
  }

  /** A sample from a uniform random value, 0..1. */
  sample(u: number): number {
    const pos = Math.min(0.999999, Math.max(0, u)) * ICDF_SIZE;
    const i = Math.floor(pos);
    let v = this.icdf[i] + (this.icdf[i + 1] - this.icdf[i]) * (pos - i);
    // As on Marbles: right at the bottom every value is Bias, right at the top only the two ends.
    const degenerate = Math.min(1, Math.max(0, 1.25 - this.spread * 25));
    const bernoulli = Math.min(1, Math.max(0, this.spread * 25 - 23.75));
    v += degenerate * (this.bias - v);
    v += bernoulli * ((u >= 1 - this.bias ? 0.999 : 0) - v);
    return v;
  }
}

/**
 * Marbles' quantizer ranks a scale's notes by weight, and Steps raises the
 * bar a note's weight must clear. Here the weights come from the chord that's
 * playing and the song's scale: the chord's root first, then its fifth, its
 * third and its other notes, then the rest of the scale.
 */
export const WEIGHT = { root: 255, fifth: 224, third: 192, chord: 160, tonic: 128, scale: 96 };
/** The bar each Steps level sets, from every scale note to the chord's root alone. */
const STEP_LEVELS = [WEIGHT.scale, WEIGHT.chord, WEIGHT.third, WEIGHT.fifth, WEIGHT.root];

/** Which Steps level a 0..1 Steps setting is at. Below the middle notes glide (see `smoothness`). */
export function stepsLevel(steps: number): number {
  if (steps <= 0.5) return 0;
  return Math.min(STEP_LEVELS.length - 1, Math.floor(((steps - 0.5) / 0.5) * STEP_LEVELS.length));
}

/** How much the melody glides between notes: Marbles' smooth half of Steps. */
export function smoothness(steps: number): number {
  return steps < 0.5 ? (0.5 - steps) * 2 : 0;
}

/**
 * Weights for each of the 12 pitch classes, from the key's root, the
 * scale (semitones above it) and the chord (its root as a pitch class and its
 * tones above that).
 */
export function pitchWeights(key: number, scale: number[], chordRoot: number, tones: number[]): Uint8Array {
  const w = new Uint8Array(12);
  for (const s of scale) w[(key + s) % 12] = WEIGHT.scale;
  w[key % 12] = WEIGHT.tonic;
  for (const t of tones) {
    const pc = (((chordRoot + t) % 12) + 12) % 12;
    const i = ((t % 12) + 12) % 12;
    const rank = i === 0 ? WEIGHT.root : i === 7 ? WEIGHT.fifth : i === 3 || i === 4 ? WEIGHT.third : WEIGHT.chord;
    w[pc] = Math.max(w[pc], rank);
  }
  return w;
}

/** Whether a pitch class is allowed at a Steps level. */
export function allowed(weights: Uint8Array, pc: number, level: number): boolean {
  return weights[pc] >= STEP_LEVELS[level];
}

/** The allowed note nearest `pitch` (a fractional MIDI note). */
export function quantize(pitch: number, weights: Uint8Array, level: number): number {
  const base = Math.round(pitch);
  for (let off = 0; off <= 12; off++) {
    // Look either side, nearer side first.
    const first = pitch >= base ? 1 : -1;
    for (const dir of off === 0 ? [0] : [first * off, -first * off]) {
      const n = base + dir;
      if (allowed(weights, ((n % 12) + 12) % 12, level)) return n;
    }
  }
  return base;
}
