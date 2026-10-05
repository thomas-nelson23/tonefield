import type { ModelDefinition, MusicFrame, NoteEvent, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { gravityAt, gravityModeParam, isUniform, uniformDir } from "./lib/gravity";
import { noteHue } from "./lib/music";
import { Feedback, applyFeedback, colourParam, feedbackParams, schemeHue } from "./lib/visual";

/** Silk is drawn in this many hues times this many shades, one path each, to keep fills cheap. */
const HUES = 18;
const SHADES = 8;

/**
 * A silk curtain that dances to the music: the spectrum lifts its columns
 * like an equaliser (bass on the left, treble on the right), kicks blow
 * gusts through it, and notes pluck it and dye it their colour. Underneath
 * it is a Verlet cloth with distance constraints; torn links heal back.
 */
class ClothSim implements SimulationModel {
  private n = 0;
  private x = new Float64Array(0);
  private y = new Float64Array(0);
  private px = new Float64Array(0);
  private py = new Float64Array(0);
  private pinned = new Uint8Array(0);
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
        if (j === 0) {
          const pins = p.pins;
          if (pins === "edge") this.pinned[k] = 1;
          else if (pins === "corners") this.pinned[k] = i === 0 || i === cols - 1 ? 1 : 0;
          else if (pins === "curtain") this.pinned[k] = i % 6 === 0 || i === cols - 1 ? 1 : 0;
        }
      }
    }
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

  step(dt: number, p: ParamValues, m: MusicFrame): void {
    const { x, y, px, py, pinned, n } = this;
    this.stepped = true;
    this.time += dt;
    const gravity = p.gravity as number;
    // The spectrum lifts each column from below, most at the hem: bass on the left, treble on the right.
    // Both are shares of gravity, so the silk rises toward weightless but only flies off at the extremes.
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
    for (let k = 0; k < n; k++) {
      if (pinned[k]) continue;
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

    const iters = p.stiffness as number;
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
    const { x, y, ca, cb, alive, rest } = this;
    let budget = Math.floor(this.healClock);
    this.healClock -= budget;
    for (let tries = 0; budget > 0 && tries < 400; tries++) {
      const c = Math.floor(Math.random() * ca.length);
      if (alive[c]) continue;
      const d = Math.hypot(x[cb[c]] - x[ca[c]], y[cb[c]] - y[ca[c]]);
      if (d > rest * 1.6) continue;
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
      const s = 4 * ev.velocity * this.gustSide * punch;
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

  render(g: CanvasRenderingContext2D, view: Viewport, p: ParamValues, m: MusicFrame): void {
    applyFeedback(this.fb, g, view, p, this.stepped);
    this.stepped = false;
    const { x, y, alive, rest, cols, rows, hLink, vLink, dye, dyeHue } = this;
    const scheme = p.colours as string;
    const restArea = rest * rest;
    const glow = 0.5 + Math.min(1, m.level) * 0.3 + m.kick * 0.15;
    // Each quad is shaded by how bunched up it is (folds go dark, stretched silk catches the light).
    const paths: Path2D[] = Array.from({ length: HUES * SHADES }, () => new Path2D());
    const hues = new Float32Array(HUES * SHADES);
    const used = new Uint8Array(HUES * SHADES);
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const k = j * cols + i;
        const top = hLink[k], left = vLink[k], right = vLink[k + 1], bottom = hLink[k + cols];
        if (!alive[top] || !alive[left] || !alive[right] || !alive[bottom]) continue;
        const a = k, b = k + 1, c = k + cols + 1, d = k + cols;
        const area = Math.abs((x[c] - x[a]) * (y[d] - y[b]) - (y[c] - y[a]) * (x[d] - x[b])) / 2;
        const shade = Math.min(1, (area / restArea) * 0.8 + dye[k] * 0.6);
        let hue = schemeHue(scheme, i / (cols - 1), m.hue, m.beats);
        if (dye[k] > 0.15) hue = dyeHue[k];
        const hb = Math.floor((((hue % 360) + 360) % 360) / (360 / HUES)) % HUES;
        const sb = Math.min(SHADES - 1, Math.floor(shade * SHADES));
        const bucket = hb * SHADES + sb;
        hues[bucket] = hb * (360 / HUES);
        used[bucket] = 1;
        const path = paths[bucket];
        path.moveTo(x[a], y[a]);
        path.lineTo(x[b], y[b]);
        path.lineTo(x[c], y[c]);
        path.lineTo(x[d], y[d]);
        path.closePath();
      }
    }
    for (let i = 0; i < paths.length; i++) {
      if (!used[i]) continue;
      const shade = (i % SHADES) / (SHADES - 1);
      g.fillStyle = `hsla(${hues[i]} 80% ${12 + shade * 50 * glow + shade * 10}% / ${0.55 + shade * 0.4})`;
      g.fill(paths[i]);
    }
    if (p.threads) {
      g.globalCompositeOperation = "lighter";
      const lines = new Path2D();
      const { ca, cb } = this;
      for (let c = 0; c < ca.length; c++) {
        if (!alive[c]) continue;
        lines.moveTo(x[ca[c]], y[ca[c]]);
        lines.lineTo(x[cb[c]], y[cb[c]]);
      }
      g.lineWidth = 0.6;
      g.strokeStyle = `rgba(255,255,255,${0.06 + m.hat * 0.15 + m.treble * 0.1})`;
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
  id: "cloth",
  name: "Silk curtain",
  category: "Surfaces",
  description: "A silk curtain that dances to the music. The spectrum lifts it like an equaliser, bass on the left and treble on the right; kicks blow gusts through it and every note plucks it and dyes it its colour.",
  hint: "Drag to grab and pull the silk. Right-drag or Shift-drag to slice it; it slowly knits back together.",
  fixedDt: 1 / 60,
  paintsBackground: true,
  params: [
    { kind: "number", key: "spectrumLift", label: "Spectrum lift", min: 0, max: 4, step: 0.05, default: 1.2, group: "Music",
      description: "How high loud frequencies lift their part of the curtain. High values fling the hem into the air." },
    { kind: "number", key: "billow", label: "Bass billow", min: 0, max: 4, step: 0.05, default: 0.8, group: "Music", global: "energy",
      description: "How much the bass lifts the whole curtain at once." },
    { kind: "number", key: "punch", label: "Hit punch", min: 0, max: 4, step: 0.05, default: 1, group: "Music", global: "energy",
      description: "How hard kicks, snares and notes shove the silk." },
    gravityModeParam("down"),
    {
      kind: "number", key: "gravity", label: "Gravity strength", min: 0, max: 5000, step: 10, default: 700, group: "Gravity", global: "gravity",
      description: "How heavy the silk hangs. Low floats like chiffon; very high stretches and rips it.",
    },
    {
      kind: "number", key: "wind", label: "Wind", min: -4000, max: 4000, step: 10, default: 60, group: "Forces", global: "energy",
      description: "A gusty sideways breeze. Negative blows left, positive blows right.",
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
      kind: "number", key: "heal", label: "Healing", min: 0, max: 5, step: 0.05, default: 1, group: "Behaviour",
      description: "How fast torn silk knits back together. Zero keeps every tear.",
    },
    colourParam("notes"),
    {
      kind: "boolean", key: "threads", label: "Show threads", default: true, group: "Look",
      description: "Draws the weave as fine glowing lines over the silk; they sparkle with the hi-hats.",
    },
    ...feedbackParams(0.45, 0, 0),
    {
      kind: "choice", key: "pins", label: "Hang from", default: "curtain", resetOnChange: true, group: "Setup",
      description: "Where the cloth is pinned along its top. Changing it restarts the scene.",
      options: [
        { value: "edge", label: "Whole top edge" },
        { value: "curtain", label: "Curtain rings" },
        { value: "corners", label: "Two corners" },
      ],
    },
    {
      kind: "number", key: "resolution", label: "Resolution", min: 10, max: 90, step: 1, default: 48, resetOnChange: true, group: "Setup",
      description: "How many points across the cloth. Higher is smoother but heavier to run.",
    },
  ],
  macros: [
    { key: "storm", label: "Storm", description: "A gale whips the silk sideways and every hit slams into it.",
      targets: [{ param: "wind", amount: 0.15 }, { param: "punch", amount: 0.6 }, { param: "stiffness", amount: -0.15 }, { param: "afterglow", amount: 0.2 }] },
    { key: "float", label: "Weightless", description: "The silk floats up and drifts with the music in a dreamy haze.",
      targets: [{ param: "gravity", amount: -0.1 }, { param: "spectrumLift", amount: 0.2 }, { param: "billow", amount: 0.15 }, { param: "afterglow", amount: 0.35 }, { param: "zoom", amount: 0.2 }] },
    { key: "shred", label: "Shred", description: "Heavy, brittle silk that rips to ribbons on every hit, then knits back together.",
      targets: [{ param: "gravity", amount: 0.12 }, { param: "tearLimit", amount: -0.2 }, { param: "heal", amount: 0.1 }, { param: "punch", amount: 0.4 }, { param: "tearable", set: true, at: 0.1 }] },
    { key: "vortex", label: "Vortex", description: "Gravity swirls the silk round the centre inside a turning tunnel.",
      targets: [{ param: "afterglow", amount: 0.35 }, { param: "spin", amount: 0.4 }, { param: "zoom", amount: -0.3 }, { param: "gravityMode", set: "swirl", at: 0.3 }] },
  ],
  modulations: [
    { source: "lfoBar", target: "wind", amount: 0.08 },
    { source: "snare", target: "stiffness", amount: -0.2 },
    { source: "treble", target: "afterglow", amount: 0.2 },
  ],
  reactions: [
    { source: "kick", text: "A gust that switches side on each kick" },
    { source: "snare", text: "Shakes every point at random" },
    { source: "hat", text: "A flutter along the hem, and the threads sparkle" },
    { source: "tone", text: "Plucks the silk where the note lands (low left, high right) and dyes it the note's colour" },
    { source: "bassline", text: "A slow swell rolls along the hem" },
    { source: "chord", text: "Each note of the chord dyes a soft vertical band of silk" },
    { source: "spectrum", text: "Each frequency lifts its column of silk (Spectrum lift)" },
    { source: "bass", text: "Lifts the whole curtain (Bass billow)" },
    { source: "level", text: "The silk glows brighter as the music gets louder" },
    { source: "treble", text: "The threads sparkle" },
  ],
  create: () => new ClothSim(),
};
