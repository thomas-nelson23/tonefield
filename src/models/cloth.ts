import type { ModelDefinition, MusicFrame, ParamSpec, NoteEvent, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { gravityAt, gravityModeParam, isUniform, uniformDir } from "./lib/gravity";
import { noteHue } from "./lib/music";
import { Feedback, applyFeedback, colourParam, feedbackParams, schemeHue } from "./lib/visual";

/** The fabric is drawn in this many hues times this many shades, one path each, to keep fills cheap. */
const HUES = 18;
const SHADES = 8;
/** Most quads Smoothing may draw in a frame. */
const MAX_QUADS = 20000;

/** How each side of the fabric can be held. */
const ANCHOR_OPTIONS = [
  { value: "free", label: "Free" },
  { value: "edge", label: "Whole edge" },
  { value: "rings", label: "Rings (every few points)" },
  { value: "ends", label: "Just the corners" },
];
const SIDES = ["Top", "Bottom", "Left", "Right"] as const;

/**
 * A sheet of fabric that dances to the music: the spectrum lifts its columns
 * like an equaliser (bass on the left, treble on the right), kicks blow
 * gusts through it, and notes pluck it and dye it their colour. Each side
 * can be anchored on its own. Underneath it is a Verlet cloth with distance
 * constraints; torn links heal back.
 */
class ClothSim implements SimulationModel {
  private n = 0;
  private x = new Float64Array(0);
  private y = new Float64Array(0);
  private px = new Float64Array(0);
  private py = new Float64Array(0);
  private pinned = new Uint8Array(0);
  /** Where each point hangs at rest; anchored points are held there. */
  private homeX = new Float64Array(0);
  private homeY = new Float64Array(0);
  /** The anchor settings `pinned` was built from, to notice when they change. */
  private anchorKey = "";
  private ca = new Int32Array(0);
  private cb = new Int32Array(0);
  private rest = 0;
  private alive = new Uint8Array(0);
  private view: Viewport = { width: 1, height: 1 };
  private grab: number | null = null;
  private cutter: { x: number; y: number } | null = null;
  private pointer = { x: 0, y: 0 };
  private time = 0;
  private torn = 0;
  private gustSide = 1;
  private cols = 0;
  private rows = 0;
  /** Link index of the horizontal / vertical link starting at each point, or -1. */
  private hLink = new Int32Array(0);
  private vLink = new Int32Array(0);
  /** Note colour soaked into each point, fading out. */
  private dyeHue = new Float32Array(0);
  private dye = new Float32Array(0);
  private healClock = 0;
  private tornList: number[] = [];
  private fb = new Feedback();
  private stepped = false;

  reset(view: Viewport, p: ParamValues): void {
    this.view = view;
    const cols = p.resolution as number;
    const clothW = view.width * 0.8;
    const spacing = clothW / (cols - 1);
    const rows = Math.max(4, Math.floor((view.height * 0.72) / spacing));
    const left = (view.width - clothW) / 2, top = view.height * 0.06;
    this.cols = cols;
    this.rows = rows;
    this.n = cols * rows;
    this.x = new Float64Array(this.n);
    this.y = new Float64Array(this.n);
    this.pinned = new Uint8Array(this.n);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        this.x[k] = left + i * spacing;
        this.y[k] = top + j * spacing;
      }
    }
    this.homeX = this.x.slice();
    this.homeY = this.y.slice();
    this.anchorKey = "";
    this.updateAnchors(p);
    this.px = this.x.slice();
    this.py = this.y.slice();
    const a: number[] = [], b: number[] = [];
    this.hLink = new Int32Array(this.n).fill(-1);
    this.vLink = new Int32Array(this.n).fill(-1);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        if (i < cols - 1) { this.hLink[k] = a.length; a.push(k); b.push(k + 1); }
        if (j < rows - 1) { this.vLink[k] = a.length; a.push(k); b.push(k + cols); }
      }
    }
    this.dyeHue = new Float32Array(this.n);
    this.dye = new Float32Array(this.n);
    this.ca = Int32Array.from(a);
    this.cb = Int32Array.from(b);
    this.alive = new Uint8Array(a.length).fill(1);
    this.rest = spacing;
    this.torn = 0;
    this.time = 0;
  }

  resize(view: Viewport): void {
    this.view = view;
  }

  /**
   * Rebuild which points are held from the four side settings. Changing them
   * doesn't restart the scene: newly anchored points glide back to their
   * place (see `step`) and released ones simply fall.
   */
  private updateAnchors(p: ParamValues): void {
    const modes = SIDES.map((side) => (p[`anchor${side}`] as string) ?? "free");
    const key = modes.join();
    if (key === this.anchorKey) return;
    this.anchorKey = key;
    const [top, bottom, left, right] = modes;
    const { cols, rows, pinned } = this;
    pinned.fill(0);
    // Along a side `len` points long, is point `t` held?
    const held = (mode: string, t: number, len: number) =>
      mode === "edge" || (mode === "rings" && (t % 6 === 0 || t === len - 1)) || (mode === "ends" && (t === 0 || t === len - 1));
    for (let i = 0; i < cols; i++) {
      if (held(top, i, cols)) pinned[i] = 1;
      if (held(bottom, i, cols)) pinned[(rows - 1) * cols + i] = 1;
    }
    for (let j = 0; j < rows; j++) {
      if (held(left, j, rows)) pinned[j * cols] = 1;
      if (held(right, j, rows)) pinned[j * cols + cols - 1] = 1;
    }
  }

  step(dt: number, p: ParamValues, m: MusicFrame): void {
    this.updateAnchors(p);
    const { x, y, px, py, pinned, n, homeX, homeY } = this;
    this.stepped = true;
    this.time += dt;
    const gravity = p.gravity as number;
    // The spectrum lifts each column from below, most at the hem: bass on the left, treble on the right.
    // Both are shares of gravity, so the fabric rises toward weightless but only flies off at the extremes.
    const lift = (p.spectrumLift as number) * 0.45 * gravity;
    const billow = (p.billow as number) * Math.min(1.5, m.bass) * 0.25 * gravity;
    const spec = m.spectrum;
    const cols = this.cols, rows = this.rows;
    const fade = Math.exp(-dt * 0.8);
    for (let k = 0; k < n; k++) this.dye[k] *= fade;
    const mode = p.gravityMode as string;
    const uniform = isUniform(mode);
    const [ux, uy] = uniformDir(mode, this.time);
    const { width: w, height: h } = this.view;
    const wind = (p.wind as number) * (0.6 + 0.4 * Math.sin(this.time * 1.3) + 0.2 * Math.sin(this.time * 3.7));
    const damp = 0.995;
    const dt2 = dt * dt;
    const settle = Math.min(1, dt * 8);
    for (let k = 0; k < n; k++) {
      if (pinned[k]) {
        // Anchored points ease back to their place (they only move when an anchor was just added).
        x[k] += (homeX[k] - x[k]) * settle;
        y[k] += (homeY[k] - y[k]) * settle;
        px[k] = x[k];
        py[k] = y[k];
        continue;
      }
      // Wind gusts vary down the cloth so it ripples instead of swinging rigidly.
      const gust = wind * (0.7 + 0.3 * Math.sin(y[k] * 0.02 + this.time * 2));
      const vx = (x[k] - px[k]) * damp, vy = (y[k] - py[k]) * damp;
      px[k] = x[k];
      py[k] = y[k];
      let gx = ux * gravity, gy = uy * gravity;
      if (!uniform) [gx, gy] = gravityAt(mode, gravity, x[k], y[k], w, h, this.time);
      const col = k % cols, row = (k / cols) | 0;
      const depth = row / (rows - 1);
      const up = (spec[Math.min(spec.length - 1, Math.floor((col / cols) * spec.length))] * lift + billow) * depth;
      // The lift pushes against gravity (straight up for the point modes).
      const lx = uniform ? -ux : 0, ly = uniform ? -uy : -1;
      x[k] += vx + (gust + gx + lx * up) * dt2;
      y[k] += vy + (gy + ly * up) * dt2;
    }

    // Finer fabric needs more passes for a pull to travel the same distance.
    // Scaling by the square root keeps high resolutions from going limp
    // without the full (linear) cost.
    const iters = Math.round((p.stiffness as number) * Math.sqrt(Math.max(1, this.cols / 48)));
    const tear = p.tearable ? (p.tearLimit as number) * this.rest : Infinity;
    const { ca, cb, alive, rest } = this;
    for (let it = 0; it < iters; it++) {
      for (let c = 0; c < ca.length; c++) {
        if (!alive[c]) continue;
        const a = ca[c], b = cb[c];
        const dx = x[b] - x[a], dy = y[b] - y[a];
        const d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
        if (d > tear) { alive[c] = 0; this.torn++; continue; }
        const diff = (d - rest) / d;
        const wa = pinned[a] ? 0 : 1, wb = pinned[b] ? 0 : 1;
        const sum = wa + wb;
        if (sum === 0) continue;
        const ox = dx * diff / sum, oy = dy * diff / sum;
        x[a] += ox * wa; y[a] += oy * wa;
        x[b] -= ox * wb; y[b] -= oy * wb;
      }
      if (this.grab !== null) {
        x[this.grab] = this.pointer.x;
        y[this.grab] = this.pointer.y;
      }
    }

    // Every edge is solid (gravity can point any way), with friction along it.
    for (let k = 0; k < n; k++) {
      if (x[k] < 0 || x[k] > w) { x[k] = x[k] < 0 ? 0 : w; py[k] = y[k] - (y[k] - py[k]) * 0.5; }
      if (y[k] < 0 || y[k] > h) { y[k] = y[k] < 0 ? 0 : h; px[k] = x[k] - (x[k] - px[k]) * 0.5; }
    }

    if (this.cutter) this.cut(this.cutter.x, this.cutter.y, 14);
    this.heal(dt, p.heal as number);
  }

  /** Torn links knit back together, a few at a time, once their ends are close enough again. */
  private heal(dt: number, rate: number): void {
    if (rate <= 0 || this.torn === 0) return;
    this.healClock += dt * rate * 40;
    let budget = Math.floor(this.healClock);
    if (budget === 0) return;
    this.healClock -= budget;
    const { x, y, ca, cb, alive, rest } = this;
    // Pick from the torn links themselves, so even a handful of tears among
    // thousands of links heals at the full rate.
    const torn = this.tornList;
    torn.length = 0;
    for (let c = 0; c < ca.length; c++) if (!alive[c]) torn.push(c);
    this.torn = torn.length;
    for (let left = torn.length; budget > 0 && left > 0; left--) {
      const pick = Math.floor(Math.random() * left);
      const c = torn[pick];
      torn[pick] = torn[left - 1];
      const d = Math.hypot(x[cb[c]] - x[ca[c]], y[cb[c]] - y[ca[c]]);
      if (d > rest * 2) continue;
      alive[c] = 1;
      this.torn--;
      budget--;
    }
  }

  /** Give every free point a velocity kick (Verlet velocity is x - px). */
  private impulse(fx: (x: number, y: number) => [number, number]): void {
    for (let k = 0; k < this.n; k++) {
      if (this.pinned[k]) continue;
      const [dx, dy] = fx(this.x[k], this.y[k]);
      this.px[k] -= dx;
      this.py[k] -= dy;
    }
  }

  onNote(ev: NoteEvent, p: ParamValues): void {
    const { width: w, height: h } = this.view;
    const punch = p.punch as number;
    if (ev.role === "kick") {
      // A gust that alternates direction on each kick.
      this.gustSide = -this.gustSide;
      const s = 2.5 * ev.velocity * this.gustSide * punch;
      this.impulse((_x, y) => [s * (0.6 + 0.4 * Math.sin(y * 0.03)), -ev.velocity * punch]);
    } else if (ev.role === "snare") {
      this.impulse(() => [(Math.random() - 0.5) * 2.5 * ev.velocity * punch, (Math.random() - 0.5) * 2.5 * ev.velocity * punch]);
    } else if (ev.role === "hat") {
      // A shimmer: a light flutter down the hem.
      this.impulse((_x, y) => [(Math.random() - 0.5) * 1.2 * ev.velocity * (y / h), 0]);
    } else if (ev.role === "bassline") {
      // A slow swell rolls along the hem, its wavelength set by pitch.
      const k = 0.006 + ev.x * 0.012, phase = Math.random() * Math.PI * 2;
      this.impulse((x, y) => [0, -Math.sin(x * k + phase) * 2.2 * ev.velocity * punch * (y / h)]);
    } else if (ev.role === "chord") {
      // Each note of the chord dyes a soft vertical band, placed by pitch class.
      for (const n of ev.notes ?? [ev.note]) {
        const cx = w * (0.08 + ((((n % 12) + 12) % 12) / 11) * 0.84), hue = noteHue(n);
        for (let k = 0; k < this.n; k++) {
          const f = Math.exp(-((this.x[k] - cx) ** 2) / 2500) * 0.45 * ev.velocity;
          if (f < 0.03) continue;
          if (f > this.dye[k] * 0.5) this.dyeHue[k] = hue;
          this.dye[k] = Math.min(1, this.dye[k] + f);
        }
      }
    } else if (ev.role === "tone") {
      // Notes pluck the cloth where they land, low notes left, high notes right, and dye it their colour.
      const cx = w * (0.12 + ev.x * 0.76), cy = h * (0.35 + Math.random() * 0.3), r = 90;
      const hue = noteHue(ev.note);
      for (let k = 0; k < this.n; k++) {
        const d2 = (this.x[k] - cx) ** 2 + (this.y[k] - cy) ** 2;
        const f = Math.exp(-d2 / (r * r * 1.5));
        if (f < 0.05) continue;
        if (f * ev.velocity > this.dye[k] * 0.5) this.dyeHue[k] = hue;
        this.dye[k] = Math.min(1, this.dye[k] + f * ev.velocity);
      }
      this.impulse((x, y) => {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2;
        const f = Math.exp(-d2 / (r * r)) * 5 * ev.velocity * punch;
        return [0, -f];
      });
    }
  }

  private cut(cx: number, cy: number, r: number): void {
    const { x, y, ca, cb, alive } = this;
    for (let c = 0; c < ca.length; c++) {
      if (!alive[c]) continue;
      const mx = (x[ca[c]] + x[cb[c]]) / 2, my = (y[ca[c]] + y[cb[c]]) / 2;
      if ((mx - cx) ** 2 + (my - cy) ** 2 < r * r) { alive[c] = 0; this.torn++; }
    }
  }

  onPointer(input: PointerInput): void {
    this.pointer.x = input.x;
    this.pointer.y = input.y;
    const cutting = input.button === 2 || input.shift;
    if (input.type === "down") {
      if (cutting) {
        this.cutter = { x: input.x, y: input.y };
      } else {
        let best = -1, bestD = 40 * 40;
        for (let k = 0; k < this.n; k++) {
          const d = (this.x[k] - input.x) ** 2 + (this.y[k] - input.y) ** 2;
          if (d < bestD) { bestD = d; best = k; }
        }
        this.grab = best >= 0 ? best : null;
      }
    } else if (input.type === "move") {
      if (this.cutter) { this.cutter.x = input.x; this.cutter.y = input.y; }
    } else {
      this.grab = null;
      this.cutter = null;
    }
  }

  private styles: string[] = new Array(HUES * SHADES).fill("");
  private smoothX = new Float64Array(0);
  private smoothY = new Float64Array(0);
  private rowX = new Float64Array(0);
  private rowY = new Float64Array(0);

  /**
   * The fabric resampled D times finer with Catmull–Rom curves: first along
   * each row, then down each column of the result. A torn link stops the
   * curve bending across the tear (the missing neighbour is mirrored instead).
   */
  private smoothGrid(D: number): [Float64Array, Float64Array] {
    const { x, y, cols, rows, hLink, vLink, alive } = this;
    const SW = (cols - 1) * D + 1, SH = (rows - 1) * D + 1;
    if (this.smoothX.length !== SW * SH) {
      this.smoothX = new Float64Array(SW * SH);
      this.smoothY = new Float64Array(SW * SH);
    }
    if (this.rowX.length !== SW * rows) {
      this.rowX = new Float64Array(SW * rows);
      this.rowY = new Float64Array(SW * rows);
    }
    const w = new Float64Array(D * 4);
    for (let t = 0; t < D; t++) {
      const s = t / D, s2 = s * s, s3 = s2 * s;
      w[t * 4] = 0.5 * (-s + 2 * s2 - s3);
      w[t * 4 + 1] = 0.5 * (2 - 5 * s2 + 3 * s3);
      w[t * 4 + 2] = 0.5 * (s + 4 * s2 - 3 * s3);
      w[t * 4 + 3] = 0.5 * (-s2 + s3);
    }
    const { rowX, rowY, smoothX, smoothY } = this;
    // Along rows: points k-1, k, k+1, k+2 give the curve from k to k+1.
    for (let j = 0; j < rows; j++) {
      const base = j * cols, out = j * SW;
      for (let i = 0; i < cols - 1; i++) {
        const k = base + i;
        const x1 = x[k], y1 = y[k], x2 = x[k + 1], y2 = y[k + 1];
        const hasPrev = i > 0 && alive[hLink[k - 1]] === 1, hasNext = i < cols - 2 && alive[hLink[k + 1]] === 1;
        const x0 = hasPrev ? x[k - 1] : 2 * x1 - x2, y0 = hasPrev ? y[k - 1] : 2 * y1 - y2;
        const x3 = hasNext ? x[k + 2] : 2 * x2 - x1, y3 = hasNext ? y[k + 2] : 2 * y2 - y1;
        for (let t = 0; t < D; t++) {
          const o = t * 4;
          rowX[out + i * D + t] = w[o] * x0 + w[o + 1] * x1 + w[o + 2] * x2 + w[o + 3] * x3;
          rowY[out + i * D + t] = w[o] * y0 + w[o + 1] * y1 + w[o + 2] * y2 + w[o + 3] * y3;
        }
      }
      rowX[out + SW - 1] = x[base + cols - 1];
      rowY[out + SW - 1] = y[base + cols - 1];
    }
    // Down columns of the row-smoothed points; tears are judged by the nearest real column.
    for (let c = 0; c < SW; c++) {
      const col = Math.min(cols - 1, Math.round(c / D));
      for (let j = 0; j < rows - 1; j++) {
        const r1 = j * SW + c, r2 = r1 + SW;
        const x1 = rowX[r1], y1 = rowY[r1], x2 = rowX[r2], y2 = rowY[r2];
        const hasPrev = j > 0 && alive[vLink[(j - 1) * cols + col]] === 1;
        const hasNext = j < rows - 2 && alive[vLink[(j + 1) * cols + col]] === 1;
        const x0 = hasPrev ? rowX[r1 - SW] : 2 * x1 - x2, y0 = hasPrev ? rowY[r1 - SW] : 2 * y1 - y2;
        const x3 = hasNext ? rowX[r2 + SW] : 2 * x2 - x1, y3 = hasNext ? rowY[r2 + SW] : 2 * y2 - y1;
        for (let t = 0; t < D; t++) {
          const o = t * 4, idx = (j * D + t) * SW + c;
          smoothX[idx] = w[o] * x0 + w[o + 1] * x1 + w[o + 2] * x2 + w[o + 3] * x3;
          smoothY[idx] = w[o] * y0 + w[o + 1] * y1 + w[o + 2] * y2 + w[o + 3] * y3;
        }
      }
      smoothX[(SH - 1) * SW + c] = rowX[(rows - 1) * SW + c];
      smoothY[(SH - 1) * SW + c] = rowY[(rows - 1) * SW + c];
    }
    return [smoothX, smoothY];
  }

  render(g: CanvasRenderingContext2D, view: Viewport, p: ParamValues, m: MusicFrame): void {
    applyFeedback(this.fb, g, view, p, this.stepped);
    this.stepped = false;
    const { x, y, alive, rest, cols, rows, hLink, vLink, dye, dyeHue } = this;
    const scheme = p.colours as string;
    const restArea = rest * rest;
    const glow = 0.5 + Math.min(1, m.level) * 0.3 + m.kick * 0.15;
    // Each quad is shaded by how bunched up it is (folds go dark, stretched fabric catches the light).
    // Smoothing draws each cell as D×D smaller quads laid on a curve through
    // the neighbouring points, so folds look round without simulating more points.
    // Capped so the total stays drawable: high resolutions are already smooth.
    const cells = (cols - 1) * (rows - 1);
    const D = Math.max(1, Math.min(Math.round((p.smoothing as number) || 1), Math.floor(Math.sqrt(MAX_QUADS / cells))));
    const [sx, sy] = D > 1 ? this.smoothGrid(D) : [x, y];
    const SW = (cols - 1) * D + 1;
    const subArea = restArea / (D * D);
    const styles = this.styles;
    for (let i = 0; i < HUES * SHADES; i++) {
      const shade = (i % SHADES) / (SHADES - 1);
      styles[i] = `hsla(${Math.floor(i / SHADES) * (360 / HUES)} 80% ${12 + shade * 50 * glow + shade * 10}% / ${0.55 + shade * 0.4})`;
    }
    // Quads go into one path per colour, filled a small tile at a time: software
    // canvas rasterisers slow down badly on paths that span the whole fabric.
    const paths: (Path2D | null)[] = new Array(HUES * SHADES).fill(null);
    const used: number[] = [];
    const tile = Math.max(2, Math.round(12 / D));
    for (let tj = 0; tj < rows - 1; tj += tile) {
      for (let ti = 0; ti < cols - 1; ti += tile) {
        for (let j = tj; j < Math.min(rows - 1, tj + tile); j++) {
          for (let i = ti; i < Math.min(cols - 1, ti + tile); i++) {
            const k = j * cols + i;
            const top = hLink[k], left = vLink[k], right = vLink[k + 1], bottom = hLink[k + cols];
            if (!alive[top] || !alive[left] || !alive[right] || !alive[bottom]) continue;
            let hue = schemeHue(scheme, i / (cols - 1), m.hue, m.beats);
            if (dye[k] > 0.15) hue = dyeHue[k];
            const hb = Math.floor((((hue % 360) + 360) % 360) / (360 / HUES)) % HUES;
            for (let v = 0; v < D; v++) {
              for (let u = 0; u < D; u++) {
                const a = (j * D + v) * SW + i * D + u, b = a + 1, c = a + SW + 1, d = a + SW;
                const area = Math.abs((sx[c] - sx[a]) * (sy[d] - sy[b]) - (sy[c] - sy[a]) * (sx[d] - sx[b])) / 2;
                const shade = Math.min(1, (area / subArea) * 0.8 + dye[k] * 0.6);
                const bucket = hb * SHADES + Math.min(SHADES - 1, Math.floor(shade * SHADES));
                let path = paths[bucket];
                if (!path) { path = paths[bucket] = new Path2D(); used.push(bucket); }
                path.moveTo(sx[a], sy[a]);
                path.lineTo(sx[b], sy[b]);
                path.lineTo(sx[c], sy[c]);
                path.lineTo(sx[d], sy[d]);
                path.closePath();
              }
            }
          }
        }
        used.sort((p, q) => p - q);
        for (const bucket of used) {
          g.fillStyle = styles[bucket];
          g.fill(paths[bucket]!);
          paths[bucket] = null;
        }
        used.length = 0;
      }
    }
    if (p.threads) {
      g.globalCompositeOperation = "lighter";
      g.lineWidth = 0.6;
      g.strokeStyle = `rgba(255,255,255,${0.06 + m.hat * 0.15 + m.treble * 0.1})`;
      // Stroked a row of links at a time, for the same reason as the quads.
      const { ca, cb } = this;
      let lines = new Path2D(), count = 0;
      for (let c = 0; c < ca.length; c++) {
        if (!alive[c]) continue;
        lines.moveTo(x[ca[c]], y[ca[c]]);
        lines.lineTo(x[cb[c]], y[cb[c]]);
        if (++count === 2 * cols) { g.stroke(lines); lines = new Path2D(); count = 0; }
      }
      g.stroke(lines);
      g.lineWidth = 1;
      g.globalCompositeOperation = "source-over";
    }
    if (this.cutter) {
      g.beginPath();
      g.arc(this.cutter.x, this.cutter.y, 14, 0, Math.PI * 2);
      g.strokeStyle = "rgba(255,120,120,0.7)";
      g.stroke();
    }
  }

  stats(): string {
    return `${this.n} points · ${this.torn} links torn`;
  }
}

export const cloth: ModelDefinition = {
  // The id stays "cloth" so routes and macros saved under the old Silk curtain name carry over.
  id: "cloth",
  name: "Fabric",
  category: "Surfaces",
  description: "A sheet of fabric that dances to the music. The spectrum lifts it like an equaliser, bass on the left and treble on the right; kicks blow gusts through it and every note plucks it and dyes it its colour. Anchor any of its four sides.",
  hint: "Drag to grab and pull the fabric. Right-drag or Shift-drag to slice it; it slowly knits back together.",
  fixedDt: 1 / 60,
  paintsBackground: true,
  params: [
    { kind: "number", key: "spectrumLift", label: "Spectrum lift", min: 0, max: 4, step: 0.05, default: 1.2, group: "Music",
      description: "How high loud frequencies lift their part of the fabric. High values fling the hem into the air." },
    { kind: "number", key: "billow", label: "Bass billow", min: 0, max: 4, step: 0.05, default: 0.8, group: "Music", global: "energy",
      description: "How much the bass lifts the whole fabric at once." },
    { kind: "number", key: "punch", label: "Hit punch", min: 0, max: 4, step: 0.05, default: 1, group: "Music", global: "energy",
      description: "How hard kicks, snares and notes shove the fabric." },
    gravityModeParam("down"),
    {
      kind: "number", key: "gravity", label: "Gravity strength", min: 0, max: 5000, step: 10, default: 700, group: "Gravity", global: "gravity",
      description: "How heavy the fabric hangs. Low floats like chiffon; very high stretches and rips it.",
    },
    {
      kind: "number", key: "wind", label: "Wind", min: -800, max: 800, step: 5, default: 40, group: "Forces", global: "energy",
      description: "A gusty sideways breeze. Negative blows left, positive blows right. Around 700 matches the default gravity, so the fabric streams out sideways.",
    },
    {
      kind: "number", key: "stiffness", label: "Stiffness", min: 1, max: 40, step: 1, default: 6, group: "Behaviour",
      description: "How firmly the fabric holds its shape. Low is stretchy like rubber; high is stiff like canvas.",
    },
    {
      kind: "number", key: "tearLimit", label: "Tear limit", min: 1.2, max: 12, step: 0.1, default: 4, group: "Behaviour",
      description: "How far a link can stretch (times its rest length) before it snaps.",
    },
    {
      kind: "boolean", key: "tearable", label: "Tearable", default: true, group: "Behaviour",
      description: "Lets over-stretched links snap. Off: the cloth stretches without ever breaking.",
    },
    {
      kind: "number", key: "heal", label: "Healing", min: 0, max: 30, step: 0.1, default: 1, group: "Behaviour",
      description: "How fast torn fabric knits back together. Zero keeps every tear; 30 closes cuts almost as fast as you make them.",
    },
    colourParam("notes"),
    {
      kind: "number", key: "smoothing", label: "Smoothing", min: 1, max: 4, step: 1, default: 2, group: "Look",
      description: "Draws each square of fabric as 1 to 16 smaller polygons on a curve, so folds look round. Costs drawing time, not simulation, and eases off by itself at high resolutions.",
    },
    {
      kind: "boolean", key: "threads", label: "Show threads", default: true, group: "Look",
      description: "Draws the weave as fine glowing lines over the fabric; they sparkle with the hi-hats.",
    },
    ...feedbackParams(0.45, 0, 0),
    ...SIDES.map((side): ParamSpec => ({
      kind: "choice", key: `anchor${side}`, label: `${side} side`, group: "Anchors", options: ANCHOR_OPTIONS,
      default: side === "Top" ? "rings" : "free",
      description: side === "Top"
        ? "How the top edge is held. Rings hang it like a curtain; Free lets that side flap loose."
        : `How the ${side.toLowerCase()} edge is held. Free lets it flap; anchoring it stretches the fabric out that way.`,
    })),
    {
      kind: "number", key: "resolution", label: "Resolution", min: 10, max: 200, step: 1, default: 48, resetOnChange: true, group: "Setup",
      description: "How many points across the fabric, i.e. how many polygons it is made of. Higher folds more finely but is heavier to run.",
    },
  ],
  macros: [
    { key: "storm", label: "Storm", description: "A gale whips the fabric sideways and every hit slams into it.",
      targets: [{ param: "wind", amount: 0.3 }, { param: "punch", amount: 0.6 }, { param: "stiffness", amount: -0.15 }, { param: "afterglow", amount: 0.2 }] },
    { key: "float", label: "Weightless", description: "The fabric floats up and drifts with the music in a dreamy haze.",
      targets: [{ param: "gravity", amount: -0.1 }, { param: "spectrumLift", amount: 0.2 }, { param: "billow", amount: 0.15 }, { param: "afterglow", amount: 0.35 }, { param: "zoom", amount: 0.2 }] },
    { key: "shred", label: "Shred", description: "Heavy, brittle fabric that rips to ribbons on every hit, then knits back together.",
      targets: [{ param: "gravity", amount: 0.12 }, { param: "tearLimit", amount: -0.2 }, { param: "heal", amount: 0.1 }, { param: "punch", amount: 0.4 }, { param: "tearable", set: true, at: 0.1 }] },
    { key: "vortex", label: "Vortex", description: "Gravity swirls the fabric round the centre inside a turning tunnel.",
      targets: [{ param: "afterglow", amount: 0.35 }, { param: "spin", amount: 0.4 }, { param: "zoom", amount: -0.3 }, { param: "gravityMode", set: "swirl", at: 0.3 }] },
  ],
  modulations: [
    { source: "lfoBar", target: "wind", amount: 0.03 },
    { source: "snare", target: "stiffness", amount: -0.2 },
    { source: "treble", target: "afterglow", amount: 0.2 },
  ],
  reactions: [
    { source: "kick", text: "A gust that switches side on each kick" },
    { source: "snare", text: "Shakes every point at random" },
    { source: "hat", text: "A flutter along the hem, and the threads sparkle" },
    { source: "tone", text: "Plucks the fabric where the note lands (low left, high right) and dyes it the note's colour" },
    { source: "bassline", text: "A slow swell rolls along the hem" },
    { source: "chord", text: "Each note of the chord dyes a soft vertical band of fabric" },
    { source: "spectrum", text: "Each frequency lifts its column of fabric (Spectrum lift)" },
    { source: "bass", text: "Lifts the whole fabric (Bass billow)" },
    { source: "level", text: "The fabric glows brighter as the music gets louder" },
    { source: "treble", text: "The threads sparkle" },
  ],
  create: () => new ClothSim(),
};
