import { type Gfx } from "../gl/gfx";
import { NOMINAL_DT, curveFor, type ModelDefinition, type MusicFrame, type NoteEvent, type ParamValues, type PointerInput, type SimulationModel, type Viewport } from "./types";
import { noteHash } from "./lib/music";
import { Raster, hsl, palette } from "./lib/raster";
import { Feedback, applyFeedback, colourParam, feedbackParams, hueToward } from "./lib/visual";
import { gravityModeParam } from "./lib/gravity";
import { GrayScott, type Paint, type StepRequest } from "./lib/grayscott";
import type { WorkerIn, WorkerOut } from "./lib/grayscott.worker";

/** Most pixels the ink is coloured at before the canvas stretches it; see `render`. */
const RENDER_PIXEL_BUDGET = 1_600_000;

const PALETTES: Record<string, Uint32Array> = {
  ice: palette([[0, 8, 12, 22], [0.25, 10, 60, 110], [0.5, 40, 170, 200], [0.75, 210, 240, 230], [1, 255, 255, 255]]),
  fire: palette([[0, 10, 6, 6], [0.3, 120, 20, 10], [0.6, 240, 120, 30], [1, 255, 240, 180]]),
  bio: palette([[0, 6, 10, 8], [0.35, 30, 90, 40], [0.65, 150, 220, 80], [1, 240, 255, 200]]),
};

/** A palette built round one hue: black, deep hue, bright hue, then a lighter neighbouring hue at the core. */
function huePalette(h: number): Uint32Array {
  const deep = hsl(h, 0.85, 0.16), mid = hsl(h, 0.95, 0.45), edge = hsl((h + 35) % 360, 0.95, 0.62), core = hsl((h + 60) % 360, 0.9, 0.78);
  return palette([[0, 4, 5, 8], [0.35, ...deep], [0.65, ...mid], [0.88, ...edge], [1, ...core]]);
}

/**
 * Where the chemistry runs. The worker keeps the main thread free to draw
 * (and lets the chemistry use a second core); the inline backend is the
 * fallback where workers can't start.
 */
interface Backend {
  reset(w: number, h: number, pattern: string): void;
  /** Start a step; `shade` is handed over and comes back through `onShade`. */
  step(q: StepRequest): void;
  /** Whether a step is still running, so the next one waits. */
  busy: boolean;
  onShade: (shade: Uint8ClampedArray<ArrayBuffer>, steps: number) => void;
  close(): void;
}

class InlineBackend implements Backend {
  private sim: GrayScott | null = null;
  busy = false;
  onShade: Backend["onShade"] = () => {};
  reset(w: number, h: number, pattern: string): void {
    this.sim = new GrayScott(w, h, pattern);
  }
  step(q: StepRequest): void {
    if (!this.sim) return;
    this.sim.run(q);
    this.onShade(q.shade, this.sim.steps);
  }
  close(): void {}
}

class WorkerBackend implements Backend {
  private worker: Worker;
  busy = false;
  onShade: Backend["onShade"] = () => {};
  constructor(onFail: () => void) {
    this.worker = new Worker(new URL("./lib/grayscott.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      this.busy = false;
      this.onShade(e.data.shade, e.data.steps);
    };
    this.worker.onerror = () => {
      this.busy = false;
      onFail();
    };
  }
  reset(w: number, h: number, pattern: string): void {
    this.busy = false;
    const msg: WorkerIn = { type: "reset", w, h, pattern };
    this.worker.postMessage(msg);
  }
  step(q: StepRequest): void {
    this.busy = true;
    const msg: WorkerIn = { type: "step", ...q };
    this.worker.postMessage(msg, [q.shade.buffer]);
  }
  close(): void {
    this.worker.terminate();
  }
}

/**
 * Living ink: Gray–Scott reaction–diffusion, where two diffusing chemicals
 * grow coral, spots, mazes and dividing cells. Here the music tends the
 * garden: loud frequencies feed growth in their column of the screen (bass
 * on the left), notes seed blooms in their colour, kicks seed rings and
 * flash the ink, snares wipe holes, and the whole palette follows the melody.
 *
 * The chemistry itself runs in a Web Worker (see lib/grayscott.ts): each
 * step hands the worker the frame's seeds, strokes and parameters, and the
 * shaded grid comes back when it's done, so a big screen never has to trade
 * growth speed for frame rate on the main thread.
 */
class ReactionSim implements SimulationModel {
  private w = 0;
  private h = 0;
  private cell = 3;
  private raster: Raster | null = null;
  private brush: { x: number; y: number; erase: boolean } | null = null;
  /** Where the last brush stamp landed, in cells, so fast strokes are joined up. */
  private lastStamp: { x: number; y: number } | null = null;
  /** The latest shaded grid from the chemistry, 0..255 per cell, and a spare buffer for the next step. */
  private shade: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(0);
  private spare: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(0);
  /** `shade` stretched along its rows, the first half of the upscale in `render`. */
  private wide = new Float32Array(0);
  private steps = 0;
  private colShift = new Float32Array(0);
  private hue = 200;
  private lutHue = -1;
  private lut: Uint32Array = PALETTES.ice;
  private flash = 0;
  private fb = new Feedback();
  private stepped = false;
  private time = 0;
  private bloomLayer: HTMLCanvasElement | null = null;
  /** Iterations owed: Growth speed is per 60th of a second, and steps can be shorter or longer. */
  private iterDebt = 0;
  /** Seconds and seeds gathered while the chemistry is busy, sent with the next step. */
  private pendingDt = 0;
  private pendingPaints: Paint[] = [];
  private backend: Backend;
  private brushCells = 3;

  constructor() {
    this.backend = this.makeBackend();
  }

  private makeBackend(): Backend {
    let backend: Backend;
    try {
      if (typeof Worker === "undefined") throw new Error("no workers");
      backend = new WorkerBackend(() => {
        // The worker failed to start (or crashed): carry on inline, starting the pattern over.
        this.backend.close();
        this.backend = new InlineBackend();
        this.backend.onShade = (shade, steps) => this.receive(shade, steps);
        this.backend.reset(this.w, this.h, this.pattern);
        this.seed();
      });
    } catch {
      backend = new InlineBackend();
    }
    backend.onShade = (shade, steps) => this.receive(shade, steps);
    return backend;
  }

  private pattern = "coral";

  reset(view: Viewport, p: ParamValues): void {
    this.cell = p.cellSize as number;
    this.w = Math.max(8, Math.ceil(view.width / this.cell));
    this.h = Math.max(8, Math.ceil(view.height / this.cell));
    const n = this.w * this.h;
    this.pattern = p.pattern as string;
    this.shade = new Uint8ClampedArray(n);
    this.spare = new Uint8ClampedArray(n);
    this.raster = null;
    this.steps = 0;
    this.iterDebt = 0;
    this.pendingDt = 0;
    this.pendingPaints = [];
    this.backend.reset(this.w, this.h, this.pattern);
    this.seed();
  }

  /** Seed a scattering of chemical-B blobs to get things started. */
  private seed(): void {
    const seeds = this.pattern === "map" ? 60 : 14;
    for (let s = 0; s < seeds; s++) this.paint(Math.random() * this.w, Math.random() * this.h, 3 + Math.random() * 5, false);
  }

  private receive(shade: Uint8ClampedArray<ArrayBuffer>, steps: number): void {
    // A result from before a reset (the grid changed size) is dropped.
    if (shade.length !== this.w * this.h) return;
    this.spare = this.shade;
    this.shade = shade;
    this.steps = steps;
  }

  /** Seed (or wipe) a disc of cells with the next step. `feed` also marks it as held by the brush. */
  private paint(x: number, y: number, r: number, erase: boolean, feed = false): void {
    this.pendingPaints.push({ x, y, r, erase, feed });
  }

  /** Paint along the stroke from the last stamp, so a fast drag leaves an unbroken line. */
  private stroke(x: number, y: number, r: number, erase: boolean): void {
    const from = this.lastStamp ?? { x, y };
    const steps = Math.max(1, Math.ceil(Math.hypot(x - from.x, y - from.y) / Math.max(0.5, r * 0.5)));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      this.paint(from.x + (x - from.x) * t, from.y + (y - from.y) * t, r, erase, true);
    }
    this.lastStamp = { x, y };
  }

  step(dt: number, p: ParamValues, m: MusicFrame): void {
    this.flash = Math.max(this.flash * Math.exp(-dt * 5), m.kick * 0.5);
    this.hue = hueToward(this.hue, m.hue, dt * 1.5);
    if (this.brush) this.stroke(this.brush.x / this.cell, this.brush.y / this.cell, (p.brush as number) / this.cell, this.brush.erase);
    else this.lastStamp = null;
    this.stepped = true;
    this.time += dt;
    this.pendingDt += dt;
    this.brushCells = (p.brush as number) / this.cell;
    // Growth speed means iterations per nominal step; a step of another length owes proportionally.
    // The debt is capped, so a chemistry that can't keep up grows slower rather than ever further behind.
    this.iterDebt = Math.min((p.speed as number) * 2, this.iterDebt + (p.speed as number) * (dt / NOMINAL_DT));
    if (this.backend.busy || this.spare.length !== this.w * this.h) return;

    // Loud frequencies lower the kill rate in their column, so the pattern blooms where the music is.
    if (this.colShift.length !== this.w) this.colShift = new Float32Array(this.w);
    const grow = (p.spectrumGrowth as number) * 0.0025;
    const spec = m.spectrum;
    for (let x = 0; x < this.w; x++) this.colShift[x] = -spec[Math.min(spec.length - 1, Math.floor((x / this.w) * spec.length))] * grow;
    const iters = Math.floor(this.iterDebt + 1e-6);
    this.iterDebt -= iters;
    // Contrast stretches the a-b difference around the same midpoint as before; kicks flash it brighter.
    const c = (p.contrast as number) || 1.6;
    const off = 0.5 + (1.25 - 0.5) * (c / 1.6) + this.flash * 0.25;
    // Explicit Euler with this 9-point stencil is stable for diffusion up to
    // about 1.25 (less once the reaction terms are added), so cap it at 1.05.
    const diffusion = Math.min(1.05, Math.max(0.05, (p.diffusion as number) || 1));
    const shade = this.spare;
    this.spare = new Uint8ClampedArray(0);
    this.backend.step({
      dt: this.pendingDt,
      iters,
      feedShift: (p.feedShift as number) || 0,
      killShift: (p.killShift as number) || 0,
      diffusion,
      colShift: this.colShift,
      brushHold: p.brushHold as number,
      paints: this.pendingPaints,
      flowMode: p.gravityMode as string,
      flow: ((p.fieldGravity as number) * this.pendingDt) / this.cell,
      cell: this.cell,
      time: this.time,
      contrast: c,
      offset: off,
      shade,
    });
    this.pendingDt = 0;
    this.pendingPaints = [];
  }

  onNote(ev: NoteEvent): void {
    const { w, h } = this;
    if (ev.role === "tone") {
      this.paint(w * (0.05 + ev.x * 0.9), h * (0.1 + noteHash(ev.note) * 0.8), 2 + ev.velocity * 4, false);
    } else if (ev.role === "kick") {
      // A thin ring of chemical B around the centre, which grows outward.
      const r = Math.min(w, h) * (0.15 + Math.random() * 0.2);
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        this.paint(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r, 1.5 + ev.velocity, false);
      }
    } else if (ev.role === "snare") {
      // Snares wipe a hole the pattern has to regrow into.
      this.paint(Math.random() * w, Math.random() * h, 4 + ev.velocity * 6, true);
    } else if (ev.role === "bassline") {
      // A seed low down, placed by pitch.
      this.paint(w * (0.1 + ev.x * 0.8), h * 0.85, 1.5 + ev.velocity * 2.5, false);
    } else if (ev.role === "chord") {
      // One seed per chord note round a circle, at the note's place on the colour wheel.
      const r = Math.min(w, h) * 0.32;
      for (const n of ev.notes ?? [ev.note]) {
        const a = ((((n % 12) + 12) % 12) / 12) * Math.PI * 2 - Math.PI / 2;
        this.paint(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r, 1.5 + ev.velocity * 2, false);
      }
    } else if (ev.role === "hat") {
      // A pinch of tiny seeds.
      for (let k = 0; k < 3; k++) this.paint(Math.random() * w, Math.random() * h, 1 + ev.velocity, false);
    }
  }

  onPointer(input: PointerInput): void {
    const erase = input.button === 2 || input.shift;
    if (input.pressed && input.type !== "up") {
      // Every pointer move is stamped right away (joined to the last one), so
      // nothing between simulation steps is lost.
      if (this.brush && this.brush.erase === erase) this.stroke(input.x / this.cell, input.y / this.cell, this.brushCells, erase);
      else this.lastStamp = null;
      this.brush = { x: input.x, y: input.y, erase };
    } else {
      this.brush = null;
      this.lastStamp = null;
    }
  }

  render(g: CanvasRenderingContext2D, view: Viewport, p: ParamValues, m: MusicFrame): void {
    if (this.shade.length === 0) return;
    applyFeedback(this.fb, g, view, p, this.stepped);
    this.stepped = false;
    const scheme = p.colours as string;
    let lut = PALETTES[scheme];
    if (!lut) {
      // "notes" follows the melody's colour; "rainbow" turns slowly with the beat.
      const h = scheme === "rainbow" ? (m.beats * 12) % 360 : this.hue;
      if (Math.abs(((h - this.lutHue + 540) % 360) - 180) > 2) { this.lut = huePalette(h); this.lutHue = h; }
      lut = this.lut;
    }
    const { w, h, shade } = this;
    // The chemicals are smoothed up to (nearly) screen resolution before they
    // are coloured, so pattern edges come out crisp. Colouring the grid and
    // letting the canvas stretch the colours is what made the ink look blurry.
    const dpr = g.getTransform().a || 1;
    const up = p.sharp === false ? 1 : Math.max(1, Math.min(Math.round(this.cell * dpr), Math.floor(Math.sqrt(RENDER_PIXEL_BUDGET / (w * h)))));
    const RW = w * up, RH = h * up;
    if (!this.raster || this.raster.width !== RW || this.raster.height !== RH) this.raster = new Raster(RW, RH);
    const px = this.raster.pixels;
    if (up === 1) {
      for (let i = 0; i < shade.length; i++) px[i] = lut[shade[i]];
    } else {
      // Bilinear between cell centres, wrapping round the edges like the
      // simulation does: first along each grid row, then between rows.
      if (this.wide.length !== RW * h) this.wide = new Float32Array(RW * h);
      const wide = this.wide;
      for (let X = 0; X < RW; X++) {
        const gx = (X + 0.5) / up - 0.5, x0 = Math.floor(gx), t = gx - x0;
        const i0 = (x0 + w) % w, i1 = (x0 + 1) % w;
        for (let y = 0, o = X; y < h; y++, o += RW) {
          const s0 = shade[y * w + i0];
          wide[o] = s0 + (shade[y * w + i1] - s0) * t;
        }
      }
      let o = 0;
      for (let Y = 0; Y < RH; Y++) {
        const gy = (Y + 0.5) / up - 0.5, y0 = Math.floor(gy), t = gy - y0;
        const r0 = ((y0 + h) % h) * RW, r1 = ((y0 + 1) % h) * RW;
        for (let X = 0; X < RW; X++) {
          const top = wide[r0 + X];
          px[o++] = lut[(top + (wide[r1 + X] - top) * t) | 0];
        }
      }
    }
    const W = this.w * this.cell, H = this.h * this.cell;
    // A soft bloom over the top that swells with the bass. It is layered onto the ink at grid
    // render resolution, so the screen gets one stretched image instead of two full-screen blends.
    const ink = this.raster.update();
    let image = ink;
    const bloom = (p.bloom as number) * (0.25 + Math.min(1.5, m.bass) * 0.75);
    if (bloom > 0.02) {
      if (!this.bloomLayer || this.bloomLayer.width !== RW || this.bloomLayer.height !== RH) {
        this.bloomLayer = document.createElement("canvas");
        this.bloomLayer.width = RW;
        this.bloomLayer.height = RH;
      }
      const bg = this.bloomLayer.getContext("2d")!;
      const s = 1.04 + Math.min(1.5, m.bass) * 0.04;
      bg.globalCompositeOperation = "copy";
      bg.globalAlpha = 1;
      bg.setTransform(1, 0, 0, 1, 0, 0);
      bg.drawImage(ink, 0, 0);
      bg.globalCompositeOperation = "lighter";
      bg.globalAlpha = Math.min(1, bloom * 0.22);
      bg.imageSmoothingEnabled = true;
      bg.setTransform(s, 0, 0, s, (RW * (1 - s)) / 2, (RH * (1 - s)) / 2);
      bg.drawImage(ink, 0, 0);
      image = this.bloomLayer;
    }
    // With afterglow the ink is laid over its own fading echoes instead of replacing them.
    g.globalAlpha = 1 - Math.min(0.9, (p.afterglow as number) * 0.9);
    g.imageSmoothingEnabled = true;
    g.drawImage(image, 0, 0, W, H);
    g.globalAlpha = 1;
  }
  /**
   * The same picture as `render`, drawn on the GPU: the grid of shades goes up
   * as it is and is smoothed and coloured in the shader, so the upscale that
   * costs `render` most of its time is free here.
   */
  renderGL(gfx: Gfx, _view: Viewport, p: ParamValues, m: MusicFrame): void {
    if (this.shade.length === 0) return;
    gfx.feedback(p.afterglow as number, p.zoom as number, p.spin as number, this.stepped);
    this.stepped = false;
    const scheme = p.colours as string;
    let lut = PALETTES[scheme];
    if (!lut) {
      const h = scheme === "rainbow" ? (m.beats * 12) % 360 : this.hue;
      if (Math.abs(((h - this.lutHue + 540) % 360) - 180) > 2) { this.lut = huePalette(h); this.lutHue = h; }
      lut = this.lut;
    }
    const W = this.w * this.cell, H = this.h * this.cell;
    const alpha = 1 - Math.min(0.9, (p.afterglow as number) * 0.9);
    const sharp = p.sharp !== false;
    gfx.ink(this.shade, this.w, this.h, lut, sharp, 0, 0, W, H, alpha);
    const bloom = (p.bloom as number) * (0.25 + Math.min(1.5, m.bass) * 0.75);
    if (bloom > 0.02) {
      gfx.blend("add");
      gfx.ink(this.shade, this.w, this.h, lut, sharp, 0, 0, W, H, alpha * Math.min(1, bloom * 0.22), 1.04 + Math.min(1.5, m.bass) * 0.04);
      gfx.blend("normal");
    }
  }


  stats(): string {
    return `${this.steps.toLocaleString()} reaction steps`;
  }
}

export const reaction: ModelDefinition = {
  id: "reaction",
  name: "Living ink",
  category: "Surfaces",
  description: "Coral, spots and mazes that grow to the music (Gray–Scott chemistry). Loud frequencies make their column bloom, bass on the left and treble on the right; notes seed growth in their colour, kicks seed rings and flash the ink, and the palette follows the melody.",
  hint: "Drag to seed new growth. Right-drag or Shift-drag to wipe an area clean.",
  fixedDt: 1 / 60,
  paintsBackground: true,
  params: [
    {
      kind: "choice", key: "pattern", label: "Pattern", default: "coral", resetOnChange: true,
      description: "Which feed and kill rates to start from. Each grows a different family of shapes.",
      options: [
        { value: "coral", label: "Coral" },
        { value: "mitosis", label: "Cell division" },
        { value: "fingerprints", label: "Fingerprints" },
        { value: "maze", label: "Maze" },
        { value: "bubbles", label: "Bubbles" },
        { value: "waves", label: "Chaotic waves" },
        { value: "map", label: "Map of every pattern" },
      ],
    },
    { kind: "widget", widget: "pad", key: "chemistry", label: "Chemistry", keys: ["feedShift", "killShift"],
      description: "Drag to explore the chemistry: left to right feeds in more fresh chemical (floods with growth), bottom to top kills it off faster (erodes into dots). The cross marks the pattern's own spot." },
    { kind: "number", key: "diffusion", label: "Pattern scale", min: 0.2, max: 1.05, step: 0.01, default: 1, random: [0.4, 1.05],
      description: "How far the chemicals spread. Lower makes finer, tighter patterns." },
    { kind: "number", key: "speed", label: "Growth", min: 1, max: 32, step: 1, default: 10, perf: true, random: [3, 20],
      description: "How many reaction steps run each frame, i.e. how fast patterns grow. The one slider here that costs frame rate." },
    { kind: "number", key: "brush", label: "Brush size", min: 4, max: 150, step: 1, default: 14, curve: curveFor(4, 150, 14), random: [6, 60],
      description: "Size of the area you seed or wipe when dragging." },
    { kind: "number", key: "feedShift", label: "Feed shift", min: -0.02, max: 0.02, step: 0.0005, default: 0, advanced: true, snapZero: true,
      format: (v) => `${v > 0 ? "+" : ""}${Math.round((v / 0.02) * 100)}%`,
      description: "Nudges how fast fresh chemical is fed in. Up floods with growth, down starves it. The pad above moves it too." },
    { kind: "number", key: "killShift", label: "Kill shift", min: -0.008, max: 0.008, step: 0.0002, default: 0, advanced: true, snapZero: true,
      format: (v) => `${v > 0 ? "+" : ""}${Math.round((v / 0.008) * 100)}%`,
      description: "Nudges how fast the pattern dies off. Down spreads blobs, up erodes into dots. The pad above moves it too." },
    { kind: "number", key: "brushHold", label: "Brush hold", min: 0, max: 120, step: 1, default: 40, advanced: true,
      format: (v) => (v >= 120 ? "for good" : `${v} s`),
      description: "How many seconds what you draw keeps being fed, so lines you draw to join shapes stay joined. All the way up keeps them fed for good; zero lets the chemistry take them over at once." },
    { kind: "boolean", key: "sharp", label: "Sharp edges", default: true, advanced: true,
      description: "Smooths the chemistry up to screen resolution before colouring it, so edges are crisp instead of blurry. Turn off for a few more frames per second on very big screens." },
    { kind: "number", key: "cellSize", label: "Cell size", min: 2, max: 8, step: 1, default: 4, resetOnChange: true, perf: true, advanced: true,
      description: "Pixels per simulation cell. Smaller is sharper but slower. Restarts the pattern." },
    // Set by the matrix rows Spectrum growth and Bass bloom.
    { kind: "number", key: "spectrumGrowth", label: "Spectrum growth", min: 0, max: 2, step: 0.05, default: 0.6, hidden: true },
    { kind: "number", key: "bloom", label: "Bass bloom", min: 0, max: 2, step: 0.05, default: 0.7, hidden: true },
    colourParam(),
    ...feedbackParams(0),
    gravityModeParam("off"),
    { kind: "number", key: "fieldGravity", label: "Flow speed", min: 0, max: 400, step: 5, default: 60, global: "gravity", hidden: true,
      description: "How fast the ink flows, pixels per second." },
    // How sharply the pattern's edges stand out. The global Contrast covers it; macros still push it.
    { kind: "number", key: "contrast", label: "Contrast", min: 0.4, max: 5, step: 0.05, default: 1.6, hidden: true },
  ],
  macros: [
    { key: "grow", label: "Overgrowth", description: "Floods the screen with fast, sharp, hungry growth.",
      targets: [{ param: "speed", amount: 0.8 }, { param: "contrast", amount: 0.3 }, { param: "diffusion", amount: -0.25 }, { param: "bloom", amount: 0.3 }] },
    { key: "bloom", label: "Bloom", description: "Blobs swell and merge under a bright bass glow with smoky echoes.",
      targets: [{ param: "killShift", amount: -0.08 }, { param: "bloom", amount: 0.6 }, { param: "contrast", amount: -0.1 }, { param: "afterglow", amount: 0.4 }, { param: "zoom", amount: 0.15 }] },
    { key: "dissolve", label: "Dissolve", description: "Erodes the pattern into fine, crawling dust.",
      targets: [{ param: "killShift", amount: 0.7 }, { param: "feedShift", amount: -0.4 }, { param: "diffusion", amount: -0.6 }] },
    { key: "stir", label: "Stir", description: "Swirls the ink into a whirlpool and spins it down a tunnel.",
      targets: [{ param: "fieldGravity", amount: 0.6 }, { param: "afterglow", amount: 0.6 }, { param: "spin", amount: 0.3 }, { param: "zoom", amount: 0.25 }, { param: "gravityMode", set: "swirl", at: 0.15 }] },
  ],
  modulations: [
    { source: "kick", target: "speed", amount: 0.4 },
    { source: "snare", target: "killShift", amount: 0.25 },
    { source: "tone", target: "feedShift", amount: 0.2 },
    { source: "lfoBar", target: "diffusion", amount: -0.3 },
  ],
  reactions: [
    { source: "tone", label: "Seed a blob", text: "Seeds a blob of growth, placed by pitch, and re-tints the ink" },
    { source: "kick", label: "Seed a ring", text: "Seeds a ring of growth around the centre and flashes the ink" },
    { source: "snare", label: "Wipe a hole", text: "Wipes a random hole for the pattern to regrow into" },
    { source: "hat", label: "Tiny seeds", text: "Sprinkles tiny seeds" },
    { source: "bassline", label: "Seed low down", text: "Seeds growth low down, placed by pitch" },
    { source: "chord", label: "Chord wheel", text: "Seeds one blob per chord note round a circle, like a colour wheel" },
    { source: "spectrum", label: "Spectrum growth", text: "Loud frequencies make their column grow. The strength is how much", param: "spectrumGrowth" },
    { source: "bass", label: "Bass bloom", text: "A glow over the ink swells with the bass. The strength is how bright", param: "bloom" },
  ],
  create: () => new ReactionSim(),
};
