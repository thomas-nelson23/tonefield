import { hsla, type Gfx } from "../gl/gfx";
import { curveFor, jitterScale, type ModelDefinition, type MusicFrame, type NoteEvent, type ParamValues, type PointerInput, type SimulationModel, type Viewport } from "./types";
import { gravityModeParam, gravityTo } from "./lib/gravity";
import { noteHue } from "./lib/music";
import { Feedback, applyFeedback, colourParam, feedbackParams, glowSprite, hueToward, schemeHue } from "./lib/visual";

/** Most line pieces kept; the oldest fade out as the buffer fills, so it never pops. */
const MAX_SEGS = 24000;
/** The oldest share of the buffer that fades out ahead of being overwritten. */
const RING_FADE = 0.25;
/** A tip lays down a piece of line every this many pixels. */
const SEG_LEN = 7;
/** Side of a cell in the grid that remembers where lines are, in pixels. */
const CELL = 6;
/** A new tip ignores lines for this many pixels, so siblings can leave the fork they share. */
const GRACE = 14;
/** Lines are drawn in this many hues times this many brightness steps (and, on the CPU, widths). */
const HUES = 18;
const SHADES = 6;
const WIDTHS = 4;
/** Most tip glows drawn in a frame. */
const MAX_GLOWS = 160;

/** Where new trees start. */
const SEED_OPTIONS = [
  { value: "centre", label: "Centre" },
  { value: "ground", label: "Ground" },
  { value: "edges", label: "Edges" },
  { value: "scatter", label: "Scatter" },
];

/**
 * Lines that grow, wander and fork into more lines, like coral, lightning or
 * roots. Each growing tip steers with a little random wander, splits in two
 * now and then, and stops when it runs into a line that is already there, so
 * the branches pack the space the way Living ink's patterns do. Old lines
 * fade away and new trees sprout on the beat, where notes land and wherever
 * you click.
 */
class BranchesSim implements SimulationModel {
  // Growing tips, packed in parallel arrays.
  private tips = 0;
  private tx = new Float64Array(0);
  private ty = new Float64Array(0);
  private ta = new Float64Array(0);
  /** How fast the tip is turning, radians a second; Wander nudges it at random. */
  private tv = new Float64Array(0);
  /** Where the tip last laid a piece of line. */
  private tlx = new Float64Array(0);
  private tly = new Float64Array(0);
  private tw = new Float32Array(0);
  private th = new Float32Array(0);
  private tid = new Int32Array(0);
  /** Pixels the tip has grown; it stops after `tlife`. */
  private tdist = new Float32Array(0);
  private tlife = new Float32Array(0);
  private tspark = new Float32Array(0);
  private nextId = 1;

  // Laid line pieces, a ring buffer: x0 y0 x1 y1, width, hue, birth time.
  private sx0 = new Float32Array(MAX_SEGS);
  private sy0 = new Float32Array(MAX_SEGS);
  private sx1 = new Float32Array(MAX_SEGS);
  private sy1 = new Float32Array(MAX_SEGS);
  private sw = new Float32Array(MAX_SEGS);
  private sh = new Float32Array(MAX_SEGS);
  private sb = new Float32Array(MAX_SEGS);
  private head = 0;
  private count = 0;

  /** For each grid cell, when a line last passed and which tip laid it. */
  private gw = 0;
  private gh = 0;
  private cellTime = new Float32Array(0);
  private cellId = new Int32Array(0);

  private view: Viewport = { width: 1, height: 1 };
  private time = 0;
  private sproutClock = 0;
  private plantClock = 0;
  private pointer: { x: number; y: number; cut: boolean } | null = null;
  /** Bass-line curl, set on each bass note and easing off. */
  private curl = 0;
  private curlSide = 1;
  private flash = 0;
  private fb = new Feedback();
  private stepped = false;
  private grav = new Float64Array(2);
  private params: ParamValues = {};
  private music = { hue: 210, beats: 0 };

  reset(view: Viewport, p: ParamValues): void {
    this.view = view;
    this.params = p;
    const max = Math.round(p.maxTips as number);
    this.tx = new Float64Array(max);
    this.ty = new Float64Array(max);
    this.ta = new Float64Array(max);
    this.tv = new Float64Array(max);
    this.tlx = new Float64Array(max);
    this.tly = new Float64Array(max);
    this.tw = new Float32Array(max);
    this.th = new Float32Array(max);
    this.tid = new Int32Array(max);
    this.tdist = new Float32Array(max);
    this.tlife = new Float32Array(max);
    this.tspark = new Float32Array(max);
    this.tips = 0;
    this.head = 0;
    this.count = 0;
    this.time = 0;
    this.makeGrid();
    for (let i = 0; i < 3; i++) this.seed(p, null, null, 210);
  }

  resize(view: Viewport): void {
    this.view = view;
    this.makeGrid();
  }

  private makeGrid(): void {
    this.gw = Math.max(1, Math.ceil(this.view.width / CELL));
    this.gh = Math.max(1, Math.ceil(this.view.height / CELL));
    this.cellTime = new Float32Array(this.gw * this.gh).fill(-1e9);
    this.cellId = new Int32Array(this.gw * this.gh);
  }

  /** How long a line counts as there for collisions: until it has mostly faded. */
  private solidFor(p: ParamValues): number {
    return (p.fade as number) * 0.8;
  }

  /** Add a growing tip; false when there is no room for another. */
  private addTip(x: number, y: number, angle: number, width: number, hue: number, life: number, spark = 0): boolean {
    if (this.tips >= this.tx.length) return false;
    const i = this.tips++;
    this.tx[i] = this.tlx[i] = x;
    this.ty[i] = this.tly[i] = y;
    this.ta[i] = angle;
    this.tv[i] = 0;
    this.tw[i] = width;
    this.th[i] = hue;
    this.tid[i] = this.nextId++;
    this.tdist[i] = 0;
    this.tlife[i] = life;
    this.tspark[i] = spark;
    return true;
  }

  private removeTip(i: number): void {
    const j = --this.tips;
    if (i === j) return;
    this.tx[i] = this.tx[j]; this.ty[i] = this.ty[j]; this.ta[i] = this.ta[j]; this.tv[i] = this.tv[j];
    this.tlx[i] = this.tlx[j]; this.tly[i] = this.tly[j];
    this.tw[i] = this.tw[j]; this.th[i] = this.th[j]; this.tid[i] = this.tid[j];
    this.tdist[i] = this.tdist[j]; this.tlife[i] = this.tlife[j]; this.tspark[i] = this.tspark[j];
  }

  /** How far a tip grows before it stops, in pixels. */
  private tipLife(): number {
    const { width: w, height: h } = this.view;
    return Math.min(w, h) * (0.12 + Math.random() * 0.3);
  }

  /**
   * Start a tree: a few tips leaving one point. Without a place, the Grow
   * from setting picks one. `hue` is the colour it starts with.
   */
  private seed(p: ParamValues, x: number | null, y: number | null, hue: number, arms = 0, strength = 1): void {
    const { width: w, height: h } = this.view;
    const mode = p.seed as string;
    let angle = Math.random() * Math.PI * 2, fan = Math.PI * 2;
    if (x === null || y === null) {
      if (mode === "centre") {
        // Near the middle, in the clearest of a few tries so new trees don't pile onto old ones.
        let best = Infinity;
        for (let k = 0; k < 10; k++) {
          const r = Math.sqrt(Math.random()) * Math.min(w, h) * 0.4, t = Math.random() * Math.PI * 2;
          const cx = w / 2 + Math.cos(t) * r, cy = h / 2 + Math.sin(t) * r;
          const busy = this.busy(cx, cy) + r / (Math.min(w, h) * 0.4) * 0.25;
          if (busy < best) { best = busy; x = cx; y = cy; }
        }
      } else if (mode === "ground") {
        x = w * (0.05 + Math.random() * 0.9);
        y = h - 2;
        angle = -Math.PI / 2;
        fan = Math.PI * 0.5;
      } else if (mode === "edges") {
        // From a random point on an edge, growing inward.
        const side = Math.floor(Math.random() * 4), t = Math.random();
        x = side === 0 ? t * w : side === 1 ? t * w : side === 2 ? 2 : w - 2;
        y = side === 0 ? 2 : side === 1 ? h - 2 : t * h;
        angle = side === 0 ? Math.PI / 2 : side === 1 ? -Math.PI / 2 : side === 2 ? 0 : Math.PI;
        fan = Math.PI * 0.6;
      } else {
        let best = Infinity;
        for (let k = 0; k < 6; k++) {
          const cx = w * (0.08 + Math.random() * 0.84), cy = h * (0.08 + Math.random() * 0.84);
          const busy = this.busy(cx, cy);
          if (busy < best) { best = busy; x = cx; y = cy; }
        }
      }
    }
    if (x === null || y === null) return;
    const n = arms || (fan >= Math.PI * 2 ? 3 + Math.floor(Math.random() * 3) : 1 + Math.floor(Math.random() * 2));
    const width = (p.lineWidth as number) * (0.8 + strength * 0.4);
    for (let k = 0; k < n; k++) {
      const a = fan >= Math.PI * 2 ? angle + (k / n) * Math.PI * 2 : angle + (Math.random() - 0.5) * fan;
      if (!this.addTip(x, y, a, width, (hue + (Math.random() - 0.5) * 16 + 360) % 360, this.tipLife() * (0.7 + strength * 0.5), strength)) break;
    }
  }

  /** The hue a new tree takes under the colour scheme. */
  private seedHue(p: ParamValues): number {
    return schemeHue(p.colours as string, Math.random(), this.music.hue, this.music.beats);
  }

  /** How much of the area round (x, y) is covered by lines still showing, 0..1. */
  private busy(x: number, y: number): number {
    const solid = this.solidFor(this.params);
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    let hit = 0, all = 0;
    for (let j = cy - 6; j <= cy + 6; j += 2) {
      for (let i = cx - 6; i <= cx + 6; i += 2) {
        if (i < 0 || j < 0 || i >= this.gw || j >= this.gh) continue;
        all++;
        if (this.time - this.cellTime[j * this.gw + i] < solid) hit++;
      }
    }
    return all ? hit / all : 0;
  }

  /** Lay a piece of line into the ring buffer and mark its cells. */
  private lay(x0: number, y0: number, x1: number, y1: number, width: number, hue: number, id: number): void {
    const s = this.head;
    this.sx0[s] = x0; this.sy0[s] = y0; this.sx1[s] = x1; this.sy1[s] = y1;
    this.sw[s] = width; this.sh[s] = hue; this.sb[s] = this.time;
    this.head = (s + 1) % MAX_SEGS;
    if (this.count < MAX_SEGS) this.count++;
    this.mark(x1, y1, id);
    this.mark((x0 + x1) / 2, (y0 + y1) / 2, id);
  }

  private mark(x: number, y: number, id: number): void {
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    if (cx < 0 || cy < 0 || cx >= this.gw || cy >= this.gh) return;
    const c = cy * this.gw + cx;
    this.cellTime[c] = this.time;
    this.cellId[c] = id;
  }

  /** Whether another tip's line, still solid, is at (x, y). */
  private blocked(x: number, y: number, id: number, solid: number): boolean {
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    if (cx < 0 || cy < 0 || cx >= this.gw || cy >= this.gh) return false;
    const c = cy * this.gw + cx;
    return this.cellId[c] !== id && this.time - this.cellTime[c] < solid;
  }

  step(dt: number, p: ParamValues, m: MusicFrame): void {
    this.params = p;
    this.stepped = true;
    this.time += dt;
    this.music.hue = m.hue;
    this.music.beats = m.beats;
    const { width: w, height: h } = this.view;
    const speed = (p.speed as number) * (1 + Math.min(1.5, m.level) * 0.5);
    const branching = p.branching as number;
    const spread = ((p.spread as number) * Math.PI) / 180;
    // The turn rate takes a random walk that settles back toward straight, so tips curve smoothly.
    const wander = (p.wander as number) * 3 * jitterScale(dt) * Math.sqrt(1 / 60);
    const settle = Math.exp(-dt * 3);
    const avoid = p.avoid as boolean;
    const solid = this.solidFor(p);
    const taper = p.taper as number;
    const minWidth = 0.35;
    const g = p.fieldGravity as number, mode = p.gravityMode as string;
    this.curl *= Math.exp(-dt * 1.5);
    this.flash *= Math.exp(-dt * 6);
    const curl = this.curl * this.curlSide;
    const fade = Math.exp(-dt * 5);

    // Grow every tip. Tips added by a split this step wait for the next one.
    const before = this.tips;
    for (let i = 0; i < before && i < this.tips; i++) {
      this.tv[i] = (this.tv[i] + (Math.random() - 0.5) * 2 * wander) * settle;
      let a = this.ta[i] + (this.tv[i] + curl) * dt;
      if (mode !== "off" && g > 0) {
        // Gravity bends the tip toward its pull.
        gravityTo(this.grav, mode, g, this.tx[i], this.ty[i], w, h, this.time);
        const gx = this.grav[0], gy = this.grav[1];
        const pull = Math.hypot(gx, gy);
        if (pull > 0) {
          const d = ((Math.atan2(gy, gx) - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
          a += d * Math.min(1, (pull / 1000) * dt * 2);
        }
      }
      this.ta[i] = a;
      const step = speed * dt;
      const x = this.tx[i] + Math.cos(a) * step, y = this.ty[i] + Math.sin(a) * step;
      this.tspark[i] *= fade;
      this.tdist[i] += step;
      // Off the screen, worn out, or about to run into another line: the tip stops.
      const ahead = CELL * 1.2;
      if (x < -4 || y < -4 || x > w + 4 || y > h + 4 || this.tdist[i] > this.tlife[i]
        || (avoid && this.tdist[i] > GRACE && this.blocked(x + Math.cos(a) * ahead, y + Math.sin(a) * ahead, this.tid[i], solid))) {
        this.lay(this.tlx[i], this.tly[i], x, y, this.tw[i], this.th[i], this.tid[i]);
        this.removeTip(i);
        i--;
        continue;
      }
      this.tx[i] = x;
      this.ty[i] = y;
      if (Math.hypot(x - this.tlx[i], y - this.tly[i]) >= SEG_LEN) {
        this.lay(this.tlx[i], this.tly[i], x, y, this.tw[i], this.th[i], this.tid[i]);
        this.tlx[i] = x;
        this.tly[i] = y;
      }
      // Fork now and then: this tip bends one way and a new one leaves the other way.
      if (Math.random() < branching * dt && this.tdist[i] > GRACE) this.split(i, spread, taper, minWidth);
    }

    // Keep something growing even in silence.
    this.sproutClock += dt;
    if (this.tips < 3 && this.sproutClock > 0.35) {
      this.sproutClock = 0;
      this.seed(p, null, null, this.seedHue(p));
    }
    // Holding the mouse plants trees under it.
    if (this.pointer && !this.pointer.cut) {
      this.plantClock += dt;
      if (this.plantClock > 0.12) {
        this.plantClock = 0;
        this.seed(p, this.pointer.x, this.pointer.y, this.seedHue(p), 3, 0.8);
      }
    } else if (this.pointer?.cut) {
      this.cut(this.pointer.x, this.pointer.y, 36);
    }
  }

  private split(i: number, spread: number, taper: number, minWidth: number): void {
    const half = spread * (0.6 + Math.random() * 0.4) / 2;
    const side = Math.random() < 0.5 ? 1 : -1;
    const width = Math.max(minWidth, this.tw[i] * taper);
    // Lay the piece up to the fork so both arms leave from the same point.
    this.lay(this.tlx[i], this.tly[i], this.tx[i], this.ty[i], this.tw[i], this.th[i], this.tid[i]);
    this.tlx[i] = this.tx[i];
    this.tly[i] = this.ty[i];
    const a = this.ta[i];
    if (this.addTip(this.tx[i], this.ty[i], a - side * half, width, (this.th[i] + (Math.random() - 0.5) * 12 + 360) % 360, this.tipLife(), this.tspark[i])) {
      this.ta[i] = a + side * half;
      this.tw[i] = width;
    }
  }

  /** Every tip forks at once. */
  private splitAll(strength: number): void {
    const p = this.params;
    const spread = ((p.spread as number) * Math.PI) / 180;
    const n = this.tips;
    for (let i = 0; i < n; i++) {
      if (Math.random() < strength) {
        this.split(i, spread * 1.3, p.taper as number, 0.35);
        this.tspark[i] = Math.max(this.tspark[i], strength);
      }
    }
  }

  /** Clear lines and tips within `r` of a point. */
  private cut(x: number, y: number, r: number): void {
    const r2 = r * r;
    for (let i = 0; i < this.tips; i++) {
      if ((this.tx[i] - x) ** 2 + (this.ty[i] - y) ** 2 < r2) { this.removeTip(i); i--; }
    }
    const { sx0, sy0, sx1, sy1, sb } = this;
    for (let s = 0; s < this.count; s++) {
      const mx = (sx0[s] + sx1[s]) / 2, my = (sy0[s] + sy1[s]) / 2;
      if ((mx - x) ** 2 + (my - y) ** 2 < r2) sb[s] = -1e9;
    }
    const c0 = Math.max(0, Math.floor((x - r) / CELL)), c1 = Math.min(this.gw - 1, Math.floor((x + r) / CELL));
    const r0 = Math.max(0, Math.floor((y - r) / CELL)), r1 = Math.min(this.gh - 1, Math.floor((y + r) / CELL));
    for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) this.cellTime[cy * this.gw + cx] = -1e9;
  }

  onNote(ev: NoteEvent, p: ParamValues): void {
    const { width: w, height: h } = this.view;
    if (ev.role === "kick") {
      // A new tree bursts out, more arms the harder the kick.
      const arms = Math.max(1, Math.round((p.bloom as number) * ev.velocity));
      this.seed(p, null, null, this.seedHue(p), p.seed === "centre" ? arms : Math.max(1, Math.round(arms / 2)), Math.min(1.5, ev.velocity));
      this.flash = Math.min(1, this.flash + ev.velocity * 0.6);
    } else if (ev.role === "snare") {
      this.splitAll(Math.min(1, ev.velocity * (p.snareSplit as number)));
    } else if (ev.role === "hat") {
      // A few tips spark.
      for (let k = 0; k < 4 && this.tips > 0; k++) {
        const i = Math.floor(Math.random() * this.tips);
        this.tspark[i] = Math.max(this.tspark[i], ev.velocity);
      }
    } else if (ev.role === "tone") {
      // A sprout where the note lands, low notes left and high notes right, in the note's colour.
      if (ev.velocity <= 0.02) return;
      const x = w * (0.08 + ev.x * 0.84);
      const y = p.seed === "ground" ? h - 2 : h * (0.25 + Math.random() * 0.5);
      const hue = p.colours === "notes" ? noteHue(ev.note) : this.seedHue(p);
      this.seed(p, x, y, hue, p.seed === "ground" ? 1 : 2, Math.min(1.5, ev.velocity));
    } else if (ev.role === "bassline") {
      // Each bass note curls the growing tips, the way it turns set by the note.
      this.curlSide = ev.note % 2 === 0 ? 1 : -1;
      this.curl = Math.max(this.curl, (p.curl as number) * ev.velocity);
    } else if (ev.role === "chord") {
      // The tips take the chord's colours.
      const notes = ev.notes ?? [ev.note];
      for (let i = 0; i < this.tips; i++) this.th[i] = hueToward(this.th[i], noteHue(notes[i % notes.length]), Math.min(1, ev.velocity * 1.2));
    }
  }

  onPointer(input: PointerInput): void {
    if (input.type === "up") { this.pointer = null; return; }
    const cut = input.button === 2 || input.shift;
    if (input.type === "down") {
      this.pointer = { x: input.x, y: input.y, cut };
      if (!cut) {
        this.plantClock = 0;
        this.seed(this.params, input.x, input.y, this.seedHue(this.params), 5, 1);
      }
    } else if (this.pointer) {
      this.pointer.x = input.x;
      this.pointer.y = input.y;
    }
  }

  /**
   * How visible piece `s` is, 0..1: it fades over Fade seconds, and the
   * oldest quarter of a full buffer fades out before it is overwritten.
   */
  private alpha(s: number, life: number): number {
    const age = (this.time - this.sb[s]) / life;
    if (age >= 1) return 0;
    let a = 1 - age;
    if (this.count === MAX_SEGS) {
      const fromOldest = ((s - this.head + MAX_SEGS) % MAX_SEGS) / (MAX_SEGS * RING_FADE);
      if (fromOldest < 1) a *= fromOldest;
    }
    return a;
  }

  /** Line brightness right now. */
  private bright(p: ParamValues, m: MusicFrame): number {
    return (p.glow as number) * (0.75 + Math.min(1, m.level) * 0.35 + m.pulse * 0.15 + this.flash * 0.3);
  }

  private widthScale(m: MusicFrame): number {
    return 1 + Math.min(1.5, m.bass) * 0.5;
  }

  private readonly cpuStyles: string[] = new Array(HUES * SHADES).fill("");
  private readonly paths: (Path2D | null)[] = new Array(HUES * SHADES * WIDTHS).fill(null);

  render(g: CanvasRenderingContext2D, view: Viewport, p: ParamValues, m: MusicFrame): void {
    applyFeedback(this.fb, g, view, p, this.stepped);
    this.stepped = false;
    const life = p.fade as number;
    const bright = this.bright(p, m);
    const wScale = this.widthScale(m);
    const maxW = (p.lineWidth as number) * 1.6;
    for (let b = 0; b < HUES * SHADES; b++) {
      const shade = ((b % SHADES) + 0.5) / SHADES;
      this.cpuStyles[b] = `hsla(${(Math.floor(b / SHADES) + 0.5) * (360 / HUES)} 85% ${58 + shade * 12}% / ${Math.min(1, shade * bright)})`;
    }
    // One path per hue, brightness and width class: a few dozen strokes a frame instead of thousands.
    const paths = this.paths;
    const used: number[] = [];
    for (let s = 0; s < this.count; s++) {
      const a = this.alpha(s, life);
      if (a < 0.04) continue;
      const hb = Math.floor(this.sh[s] / (360 / HUES)) % HUES;
      const wb = Math.min(WIDTHS - 1, Math.floor((this.sw[s] / maxW) * WIDTHS));
      const bucket = (wb * HUES + hb) * SHADES + Math.min(SHADES - 1, Math.floor(a * SHADES));
      let path = paths[bucket];
      if (!path) { path = paths[bucket] = new Path2D(); used.push(bucket); }
      path.moveTo(this.sx0[s], this.sy0[s]);
      path.lineTo(this.sx1[s], this.sy1[s]);
    }
    // Square ends: round ones would overlap at every joint and bead the lines with bright dots.
    g.globalCompositeOperation = "lighter";
    for (const bucket of used) {
      const wb = Math.floor(bucket / (HUES * SHADES));
      g.lineWidth = Math.max(0.5, ((wb + 0.5) / WIDTHS) * maxW * wScale);
      g.strokeStyle = this.cpuStyles[bucket % (HUES * SHADES)];
      g.stroke(paths[bucket]!);
      paths[bucket] = null;
    }
    // The growing tips: the piece not yet laid, and a glow where they spark.
    g.lineWidth = (p.lineWidth as number) * wScale;
    for (let i = 0; i < this.tips; i++) {
      g.strokeStyle = `hsl(${this.th[i]} 90% 70%)`;
      g.beginPath();
      g.moveTo(this.tlx[i], this.tly[i]);
      g.lineTo(this.tx[i], this.ty[i]);
      g.stroke();
    }
    if (p.tipGlow) {
      const dpr = window.devicePixelRatio || 1;
      const size = (p.lineWidth as number) * 7 * (1 + Math.min(1, m.treble) * 0.6);
      for (let i = 0, drawn = 0; i < this.tips && drawn < MAX_GLOWS; i++) {
        const sp = 0.35 + this.tspark[i];
        const s = size * sp;
        g.drawImage(glowSprite(this.th[i], 90, s * dpr), this.tx[i] - s / 2, this.ty[i] - s / 2, s, s);
        drawn++;
      }
    }
    g.lineWidth = 1;
    g.globalCompositeOperation = "source-over";
  }

  /** The same picture as `render`, drawn on the GPU. */
  renderGL(gfx: Gfx, _view: Viewport, p: ParamValues, m: MusicFrame): void {
    gfx.feedback(p.afterglow as number, p.zoom as number, p.spin as number, this.stepped);
    this.stepped = false;
    const life = p.fade as number;
    const bright = this.bright(p, m);
    const wScale = this.widthScale(m);
    const colours = this.glColours;
    for (let b = 0; b < HUES * SHADES; b++) {
      const shade = ((b % SHADES) + 0.5) / SHADES;
      colours[b] = hsla((Math.floor(b / SHADES) + 0.5) * (360 / HUES), 0.85, (58 + shade * 12) / 100, Math.min(1, shade * bright));
    }
    gfx.blend("add");
    for (let s = 0; s < this.count; s++) {
      const a = this.alpha(s, life);
      if (a < 0.04) continue;
      const hb = Math.floor(this.sh[s] / (360 / HUES)) % HUES;
      gfx.line(this.sx0[s], this.sy0[s], this.sx1[s], this.sy1[s], this.sw[s] * wScale, colours[hb * SHADES + Math.min(SHADES - 1, Math.floor(a * SHADES))], false);
    }
    for (let i = 0; i < this.tips; i++) {
      gfx.line(this.tlx[i], this.tly[i], this.tx[i], this.ty[i], this.tw[i] * wScale, hsla(this.th[i], 0.9, 0.7));
    }
    if (p.tipGlow) {
      const size = (p.lineWidth as number) * 7 * (1 + Math.min(1, m.treble) * 0.6);
      for (let i = 0, drawn = 0; i < this.tips && drawn < MAX_GLOWS; i++) {
        gfx.glow(this.tx[i], this.ty[i], size * (0.35 + this.tspark[i]), Math.round(this.th[i] / 10) * 10, 90);
        drawn++;
      }
    }
    gfx.blend("normal");
  }

  private readonly glColours = new Uint32Array(HUES * SHADES);

  stats(): string {
    const life = (this.params.fade as number) || 1;
    let shown = 0;
    for (let s = 0; s < this.count; s++) if (this.time - this.sb[s] < life) shown++;
    return `${this.tips} growing tips · ${shown} line pieces`;
  }
}

export const branches: ModelDefinition = {
  id: "branches",
  name: "Branches",
  category: "Surfaces",
  description: "Glowing lines that grow, wander and fork into more lines, like coral, lightning or roots. A branch stops when it meets another line, so the tree packs the space the way Living ink does. Kicks sprout new trees, snares fork every growing tip at once, notes sprout where they land (low left, high right) and the bass line curls the branches.",
  hint: "Click or hold to plant trees under the mouse. Right-drag or Shift-drag to clear lines away.",
  fixedDt: 1 / 60,
  paintsBackground: true,
  params: [
    { kind: "choice", key: "seed", label: "Grow from", default: "centre", segmented: true, options: SEED_OPTIONS,
      description: "Where new trees start: the middle of the screen, along the bottom like plants, in from the edges, or anywhere." },
    { kind: "number", key: "speed", label: "Growth speed", min: 20, max: 800, step: 5, default: 160, curve: curveFor(20, 800, 160), random: [60, 450], global: "energy",
      description: "How fast the tips grow, in pixels a second. Louder music speeds them up." },
    { kind: "number", key: "branching", label: "Branching", min: 0, max: 6, step: 0.05, default: 1.6, curve: curveFor(0, 6, 1.6), random: [0.4, 4],
      description: "How often each tip forks in two, times a second. Zero grows single wandering lines." },
    { kind: "number", key: "spread", label: "Fork angle", min: 5, max: 150, step: 1, default: 50, random: [15, 110],
      description: "How wide the two arms of a fork open, in degrees. Narrow looks like lightning; wide looks like coral." },
    { kind: "number", key: "wander", label: "Wander", min: 0, max: 12, step: 0.1, default: 2, curve: curveFor(0, 12, 2), random: [0.3, 7],
      description: "How much a tip wobbles as it grows. Low grows straight; high grows twisty, like roots or veins." },
    { kind: "number", key: "fade", label: "Fade", min: 1, max: 60, step: 0.5, default: 9, curve: curveFor(1, 60, 9), random: [3, 25],
      description: "How many seconds a line lasts before it fades away. Faded lines stop blocking, so new growth can fill their space." },
    { kind: "number", key: "lineWidth", label: "Line width", min: 0.4, max: 6, step: 0.1, default: 2.2, random: [0.8, 4],
      description: "How thick a new tree's trunk is. Each fork is thinner by the Taper; the bass thickens every line." },
    { kind: "number", key: "maxTips", label: "Growing tips", min: 20, max: 800, step: 10, default: 260, resetOnChange: true, perf: true, advanced: true,
      description: "The most tips growing at once. More fills the screen faster and is heavier to draw. Rebuilds the scene." },
    { kind: "number", key: "taper", label: "Taper", min: 0.5, max: 1, step: 0.01, default: 0.82, advanced: true, random: [0.65, 0.98],
      description: "How much thinner each fork is than the branch it leaves. 1 keeps every branch as thick as the trunk." },
    { kind: "number", key: "glow", label: "Line glow", min: 0.1, max: 2, step: 0.01, default: 1, advanced: true, random: [0.4, 1.2],
      description: "How bright the lines are. Where they cross they add up toward white." },
    { kind: "boolean", key: "avoid", label: "Stop at other lines", default: true, advanced: true,
      description: "A branch stops when it reaches a line that is still showing, so trees pack the space like coral. Off lets branches cross and tangle." },
    { kind: "boolean", key: "tipGlow", label: "Glowing tips", default: true, advanced: true,
      description: "A small light at each growing tip; it flares on the hi-hats and snares." },
    // Set by the matrix rows Sprout a tree, Fork every tip and Curl.
    { kind: "number", key: "bloom", label: "Kick sprout", min: 0, max: 16, step: 1, default: 6, hidden: true },
    { kind: "number", key: "snareSplit", label: "Snare fork", min: 0, max: 2, step: 0.05, default: 0.7, hidden: true },
    { kind: "number", key: "curl", label: "Bass curl", min: 0, max: 12, step: 0.1, default: 3, hidden: true },
    gravityModeParam("off"),
    { kind: "number", key: "fieldGravity", label: "Field strength", min: 0, max: 2000, step: 10, default: 300, global: "gravity", hidden: true,
      description: "How hard gravity bends the growing tips toward its pull." },
    colourParam(),
    ...feedbackParams(0.25),
  ],
  macros: [
    { key: "lightning", label: "Lightning", description: "Fast, straight, narrow forks that flash and fade quickly.",
      targets: [{ param: "speed", amount: 0.5 }, { param: "wander", amount: -0.15 }, { param: "spread", amount: -0.2 }, { param: "branching", amount: 0.3 }, { param: "fade", amount: -0.1 }] },
    { key: "coral", label: "Coral", description: "Slow, twisting growth with wide forks that packs the screen and lingers.",
      targets: [{ param: "speed", amount: -0.15 }, { param: "wander", amount: 0.3 }, { param: "spread", amount: 0.35 }, { param: "fade", amount: 0.4 }, { param: "avoid", set: true, at: 0.1 }] },
    { key: "tangle", label: "Tangle", description: "Branches stop avoiding each other and curl into a dense, glowing knot.",
      targets: [{ param: "wander", amount: 0.4 }, { param: "branching", amount: 0.25 }, { param: "curl", amount: 0.4 }, { param: "avoid", set: false, at: 0.3 }] },
    { key: "hyper", label: "Hyperspace", description: "Long trails that fly outward into a turning tunnel.",
      targets: [{ param: "afterglow", amount: 0.45 }, { param: "zoom", amount: 0.45 }, { param: "spin", amount: 0.2 }, { param: "glow", amount: -0.15 }] },
  ],
  modulations: [
    { source: "lfoBar", target: "spread", amount: 0.12 },
    { source: "kick", target: "lineWidth", amount: 0.15 },
    { source: "treble", target: "global:trails", amount: 0.1 },
  ],
  reactions: [
    { source: "kick", label: "Sprout a tree", text: "A new tree bursts out where trees grow from. The strength is how many arms it has", param: "bloom" },
    { source: "snare", label: "Fork every tip", text: "Every growing tip forks at once and flares. The strength is how many of them", param: "snareSplit" },
    { source: "hat", label: "Tip sparks", text: "A few growing tips spark" },
    { source: "tone", label: "Sprout on notes", text: "A sprout grows where the note lands, low notes left and high notes right, in the note's colour" },
    { source: "bassline", label: "Curl", text: "Each bass note curls the growing tips one way or the other. The strength is how hard", param: "curl" },
    { source: "chord", label: "Chord colours", text: "The growing tips take the chord's colours" },
    { source: "bass", label: "Thicker lines", text: "The bass thickens every line" },
    { source: "level", label: "Grow and glow", text: "Louder music grows the tips faster and makes the lines brighter" },
    { source: "treble", label: "Bigger tip glow", text: "The glows at the tips grow bigger" },
    { source: "beat", label: "Beat pulse", text: "The lines pulse brighter on the beat" },
  ],
  create: () => new BranchesSim(),
};
