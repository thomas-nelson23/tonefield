import { gravityTo, isUniform } from "./gravity";

/**
 * The Gray–Scott reaction–diffusion kernel behind Living ink, written so it
 * can run in a Web Worker: it owns the chemical grids and takes everything
 * else (parameters, brush strokes, the spectrum) as plain data. Living ink
 * keeps the interaction and drawing; this does the arithmetic.
 */

/** Feed and kill rates for well-known Gray–Scott regimes. */
export const PRESETS: Record<string, [number, number]> = {
  coral: [0.0545, 0.062],
  mitosis: [0.0367, 0.0649],
  fingerprints: [0.037, 0.06],
  maze: [0.029, 0.057],
  bubbles: [0.098, 0.0555],
  waves: [0.014, 0.045],
};

/** How far fully fed brush strokes lower the kill rate, enough to keep a drawn line alive. */
const HOLD_KILL = 0.007;

/** A disc of cells to seed (or wipe); `feed` also marks it as held by the brush. */
export interface Paint {
  x: number;
  y: number;
  r: number;
  erase: boolean;
  feed: boolean;
}

/** One request to advance the chemistry. */
export interface StepRequest {
  /** Seconds covered, for the brush hold's fade. */
  dt: number;
  /** Reaction iterations to run. */
  iters: number;
  feedShift: number;
  killShift: number;
  /** Diffusion scale, already capped for stability. */
  diffusion: number;
  /** Kill-rate shift per column from the spectrum, `w` entries (or empty). */
  colShift: Float32Array;
  /** Seconds the brush keeps feeding what it drew. */
  brushHold: number;
  /** Seeds and wipes to apply first, in order. */
  paints: Paint[];
  /** Carry the ink along the gravity field this many cells, in this mode; flow 0 skips it. */
  flowMode: string;
  flow: number;
  cell: number;
  time: number;
  /** Shading: `(a - b) * -contrast + offset`, clamped to 0..1, into `shade` as 0..255. */
  contrast: number;
  offset: number;
  /** A buffer of `w * h` bytes to write the shade into (reused between requests). */
  shade: Uint8ClampedArray<ArrayBuffer>;
}

export class GrayScott {
  a: Float32Array;
  b: Float32Array;
  private na: Float32Array;
  private nb: Float32Array;
  private feed: Float32Array;
  private kill: Float32Array;
  /**
   * How strongly each cell is still fed by a brush stroke, 0..1. Fed cells
   * have a lower kill rate, so lines drawn to join shapes stay joined instead
   * of pinching off; the feeding fades over the Brush hold time.
   */
  private hold: Float32Array;
  private holdLeft = 0;
  /** Base kill rate minus brush feeding, rebuilt each step. */
  private killNow: Float32Array;
  private grav = new Float64Array(2);
  /** Reaction iterations run so far. */
  steps = 0;

  constructor(readonly w: number, readonly h: number, pattern: string) {
    const n = w * h;
    this.a = new Float32Array(n).fill(1);
    this.b = new Float32Array(n);
    this.na = new Float32Array(n);
    this.nb = new Float32Array(n);
    this.feed = new Float32Array(n);
    this.kill = new Float32Array(n);
    this.killNow = new Float32Array(n);
    this.hold = new Float32Array(n);
    this.applyPattern(pattern);
  }

  private applyPattern(pattern: string): void {
    const { w, h } = this;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (pattern === "map") {
          // Kill rate varies left to right, feed rate bottom to top: a live map of every regime.
          this.kill[i] = 0.045 + (x / w) * 0.025;
          this.feed[i] = 0.01 + (1 - y / h) * 0.09;
        } else {
          const [f, k] = PRESETS[pattern] ?? PRESETS.coral;
          this.feed[i] = f;
          this.kill[i] = k;
        }
      }
    }
  }

  /** Seed (or wipe) a disc of cells. */
  paint(p: Paint): void {
    const { w, h } = this;
    const { x: cx, y: cy, r } = p;
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
        const i = ((y + h) % h) * w + ((x + w) % w);
        if (p.erase) { this.a[i] = 1; this.b[i] = 0; this.hold[i] = 0; }
        else {
          this.a[i] = 0.5; this.b[i] = 0.25 + Math.random() * 0.05;
          if (p.feed) this.hold[i] = 1;
        }
      }
    }
    if (p.feed && !p.erase) this.holdLeft = 1;
  }

  /** Apply a request in full: paints, brush hold, flow, the iterations, then the shade. */
  run(q: StepRequest): void {
    for (const p of q.paints) this.paint(p);
    this.updateHold(q.dt, q.brushHold);
    if (q.flowMode !== "off" && q.flow > 0) this.advect(q.flowMode, q.flow, q.cell, q.time);
    this.iterate(q.iters, q.feedShift, q.killShift, q.diffusion, q.colShift);
    this.shade(q.shade, q.contrast, q.offset);
  }

  /** Run `iters` reaction iterations. */
  iterate(iters: number, df: number, dk: number, diffusion: number, colShift: Float32Array): void {
    const { w, h, feed } = this;
    const kill = this.holdLeft > 0 ? this.killNow : this.kill;
    const dA = 1.0 * diffusion, dB = 0.5 * diffusion;
    const shifted = colShift.length === w;
    for (let it = 0; it < iters; it++) {
      const a = this.a, b = this.b, na = this.na, nb = this.nb;
      for (let y = 0; y < h; y++) {
        const up = ((y - 1 + h) % h) * w, mid = y * w, down = ((y + 1) % h) * w;
        // Walk the row carrying the left and centre columns in locals, so each
        // cell only loads its right-hand column (a big win over 18 array reads).
        let aul = a[up + w - 1], aml = a[mid + w - 1], adl = a[down + w - 1], auc = a[up], amc = a[mid], adc = a[down];
        let bul = b[up + w - 1], bml = b[mid + w - 1], bdl = b[down + w - 1], buc = b[up], bmc = b[mid], bdc = b[down];
        for (let x = 0; x < w; x++) {
          const r = x === w - 1 ? 0 : x + 1;
          const aur = a[up + r], amr = a[mid + r], adr = a[down + r];
          const bur = b[up + r], bmr = b[mid + r], bdr = b[down + r];
          // 9-point Laplacian: 0.2 for edges, 0.05 for corners.
          const lapA = 0.2 * (auc + adc + aml + amr) + 0.05 * (aul + aur + adl + adr) - amc;
          const lapB = 0.2 * (buc + bdc + bml + bmr) + 0.05 * (bul + bur + bdl + bdr) - bmc;
          const i = mid + x;
          const abb = amc * bmc * bmc;
          let f = feed[i] + df;
          if (f < 0) f = 0;
          let k = kill[i] + dk + (shifted ? colShift[x] : 0);
          if (k < 0) k = 0;
          na[i] = amc + dA * lapA - abb + f * (1 - amc);
          nb[i] = bmc + dB * lapB + abb - (k + f) * bmc;
          aul = auc; auc = aur; aml = amc; amc = amr; adl = adc; adc = adr;
          bul = buc; buc = bur; bml = bmc; bmc = bmr; bdl = bdc; bdc = bdr;
        }
      }
      this.a = na; this.na = a;
      this.b = nb; this.nb = b;
      this.steps++;
    }
  }

  /** Fade the brush feeding and fold it into this step's kill rates. */
  private updateHold(dt: number, seconds: number): void {
    if (this.holdLeft <= 0) return;
    const { hold, kill, killNow } = this;
    // The top of the slider keeps strokes fed for good.
    const fade = seconds >= 120 ? 1 : seconds <= 0 ? 0 : Math.exp(-dt / (seconds / 3));
    let any = 0;
    for (let i = 0; i < hold.length; i++) {
      const v = hold[i] * fade;
      hold[i] = v < 0.01 ? 0 : v;
      killNow[i] = kill[i] - hold[i] * HOLD_KILL;
      any = any > v ? any : v;
    }
    this.holdLeft = any;
  }

  /**
   * Carry the ink along the gravity field by `flow` cells: each cell takes
   * its value from upstream, blended between the four nearest cells.
   */
  private advect(mode: string, flow: number, cell: number, time: number): void {
    const { w, h, grav } = this;
    const a = this.a, b = this.b, na = this.na, nb = this.nb;
    const uniform = isUniform(mode);
    gravityTo(grav, mode, flow, 0, 0, w, h, time);
    let dx = grav[0], dy = grav[1];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!uniform) {
          gravityTo(grav, mode, flow, x * cell, y * cell, w * cell, h * cell, time, 40);
          dx = grav[0]; dy = grav[1];
        }
        let sx = x - dx, sy = y - dy;
        sx = ((sx % w) + w) % w;
        sy = ((sy % h) + h) % h;
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        const fx = sx - x0, fy = sy - y0;
        const x1 = x0 + 1 === w ? 0 : x0 + 1, y1 = y0 + 1 === h ? 0 : y0 + 1;
        const i00 = y0 * w + x0, i10 = y0 * w + x1, i01 = y1 * w + x0, i11 = y1 * w + x1;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        const i = y * w + x;
        na[i] = a[i00] * w00 + a[i10] * w10 + a[i01] * w01 + a[i11] * w11;
        nb[i] = b[i00] * w00 + b[i10] * w10 + b[i01] * w01 + b[i11] * w11;
      }
    }
    this.a = na; this.na = a;
    this.b = nb; this.nb = b;
  }

  /** How dark or bright each cell is, 0..255: the a–b difference stretched by `c` around `off`. */
  shade(out: Uint8ClampedArray, c: number, off: number): void {
    const a = this.a, b = this.b, n = out.length;
    for (let i = 0; i < n; i++) out[i] = ((a[i] - b[i]) * -c + off) * 255;
  }
}
