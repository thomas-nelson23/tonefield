import type { ModelDefinition, MusicFrame, NoteEvent, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { noteHash } from "./lib/music";
import { Raster, hsl, palette } from "./lib/raster";
import { Feedback, applyFeedback, feedbackParams, hueToward } from "./lib/visual";
import { gravityAt, gravityModeParam, isUniform } from "./lib/gravity";

/** Feed and kill rates for well-known Gray–Scott regimes. */
const PRESETS: Record<string, [number, number]> = {
  coral: [0.0545, 0.062],
  mitosis: [0.0367, 0.0649],
  fingerprints: [0.037, 0.06],
  maze: [0.029, 0.057],
  bubbles: [0.098, 0.0555],
  waves: [0.014, 0.045],
};

const PALETTES: Record<string, Uint32Array> = {
  ocean: palette([[0, 8, 12, 22], [0.25, 10, 60, 110], [0.5, 40, 170, 200], [0.75, 210, 240, 230], [1, 255, 255, 255]]),
  ember: palette([[0, 10, 6, 6], [0.3, 120, 20, 10], [0.6, 240, 120, 30], [1, 255, 240, 180]]),
  bio: palette([[0, 6, 10, 8], [0.35, 30, 90, 40], [0.65, 150, 220, 80], [1, 240, 255, 200]]),
};

/** A palette built round one hue: black, deep hue, bright hue, then a lighter neighbouring hue at the core. */
function huePalette(h: number): Uint32Array {
  const deep = hsl(h, 0.85, 0.16), mid = hsl(h, 0.95, 0.45), edge = hsl((h + 35) % 360, 0.95, 0.62), core = hsl((h + 60) % 360, 0.9, 0.78);
  return palette([[0, 4, 5, 8], [0.35, ...deep], [0.65, ...mid], [0.88, ...edge], [1, ...core]]);
}

/**
 * Living ink: Gray–Scott reaction–diffusion, where two diffusing chemicals
 * grow coral, spots, mazes and dividing cells. Here the music tends the
 * garden: loud frequencies feed growth in their column of the screen (bass
 * on the left), notes seed blooms in their colour, kicks seed rings and
 * flash the ink, snares wipe holes, and the whole palette follows the melody.
 */
class ReactionSim implements SimulationModel {
  private w = 0;
  private h = 0;
  private cell = 3;
  private a = new Float32Array(0);
  private b = new Float32Array(0);
  private na = new Float32Array(0);
  private nb = new Float32Array(0);
  private feed = new Float32Array(0);
  private kill = new Float32Array(0);
  private raster: Raster | null = null;
  private brush: { x: number; y: number; erase: boolean } | null = null;
  private steps = 0;
  private colShift = new Float32Array(0);
  private hue = 200;
  private lutHue = -1;
  private lut: Uint32Array = PALETTES.ocean;
  private flash = 0;
  private fb = new Feedback();
  private stepped = false;
  private time = 0;

  reset(view: Viewport, p: ParamValues): void {
    this.cell = p.cellSize as number;
    this.w = Math.max(8, Math.ceil(view.width / this.cell));
    this.h = Math.max(8, Math.ceil(view.height / this.cell));
    const n = this.w * this.h;
    this.a = new Float32Array(n).fill(1);
    this.b = new Float32Array(n);
    this.na = new Float32Array(n);
    this.nb = new Float32Array(n);
    this.feed = new Float32Array(n);
    this.kill = new Float32Array(n);
    this.raster = new Raster(this.w, this.h);
    this.steps = 0;
    this.applyPattern(p.pattern as string);
    // Seed a scattering of chemical-B blobs to get things started.
    const seeds = p.pattern === "map" ? 60 : 14;
    for (let s = 0; s < seeds; s++) {
      this.paint(Math.random() * this.w, Math.random() * this.h, 3 + Math.random() * 5, false);
    }
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

  private paint(cx: number, cy: number, r: number, erase: boolean): void {
    const { w, h } = this;
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
        const i = ((y + h) % h) * w + ((x + w) % w);
        if (erase) { this.a[i] = 1; this.b[i] = 0; }
        else { this.a[i] = 0.5; this.b[i] = 0.25 + Math.random() * 0.05; }
      }
    }
  }

  step(dt: number, p: ParamValues, m: MusicFrame): void {
    // Loud frequencies lower the kill rate in their column, so the pattern blooms where the music is.
    if (this.colShift.length !== this.w) this.colShift = new Float32Array(this.w);
    const grow = (p.spectrumGrowth as number) * 0.0025;
    const spec = m.spectrum;
    for (let x = 0; x < this.w; x++) this.colShift[x] = -spec[Math.min(spec.length - 1, Math.floor((x / this.w) * spec.length))] * grow;
    this.flash = Math.max(this.flash * Math.exp(-dt * 5), m.kick * 0.5);
    this.hue = hueToward(this.hue, m.hue, dt * 1.5);
    if (this.brush) this.paint(this.brush.x / this.cell, this.brush.y / this.cell, (p.brush as number) / this.cell, this.brush.erase);
    this.stepped = true;
    this.time += dt;
    const flow = ((p.fieldGravity as number) * dt) / this.cell;
    if (p.gravityMode !== "off" && flow > 0) this.advect(p.gravityMode as string, flow);
    const iters = p.speed as number;
    const { w, h, feed, kill } = this;
    const df = (p.feedShift as number) || 0;
    const dk = (p.killShift as number) || 0;
    // Explicit Euler with this 9-point stencil is stable for diffusion up to
    // about 1.25 (less once the reaction terms are added), so cap it at 1.05.
    const scale = Math.min(1.05, Math.max(0.05, (p.diffusion as number) || 1));
    const dA = 1.0 * scale, dB = 0.5 * scale;
    for (let it = 0; it < iters; it++) {
      const a = this.a, b = this.b, na = this.na, nb = this.nb;
      for (let y = 0; y < h; y++) {
        const up = ((y - 1 + h) % h) * w, mid = y * w, down = ((y + 1) % h) * w;
        for (let x = 0; x < w; x++) {
          const l = x === 0 ? w - 1 : x - 1, r = x === w - 1 ? 0 : x + 1;
          const i = mid + x;
          // 9-point Laplacian: 0.2 for edges, 0.05 for corners.
          const lapA = 0.2 * (a[up + x] + a[down + x] + a[mid + l] + a[mid + r])
            + 0.05 * (a[up + l] + a[up + r] + a[down + l] + a[down + r]) - a[i];
          const lapB = 0.2 * (b[up + x] + b[down + x] + b[mid + l] + b[mid + r])
            + 0.05 * (b[up + l] + b[up + r] + b[down + l] + b[down + r]) - b[i];
          const abb = a[i] * b[i] * b[i];
          const f = Math.max(0, feed[i] + df), k = Math.max(0, kill[i] + dk + this.colShift[x]);
          na[i] = a[i] + dA * lapA - abb + f * (1 - a[i]);
          nb[i] = b[i] + dB * lapB + abb - (k + f) * b[i];
        }
      }
      this.a = na; this.na = a;
      this.b = nb; this.nb = b;
    }
    this.steps += iters;
  }

  /**
   * Carry the ink along the gravity field by `flow` cells: each cell takes
   * its value from upstream, blended between the four nearest cells.
   */
  private advect(mode: string, flow: number): void {
    const { w, h, cell } = this;
    const a = this.a, b = this.b, na = this.na, nb = this.nb;
    const uniform = isUniform(mode);
    let [dx, dy] = uniform ? gravityAt(mode, flow, 0, 0, w, h, this.time) : [0, 0];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!uniform) [dx, dy] = gravityAt(mode, flow, x * cell, y * cell, w * cell, h * cell, this.time, 40);
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
    this.brush = input.pressed && input.type !== "up"
      ? { x: input.x, y: input.y, erase: input.button === 2 || input.shift }
      : null;
  }

  render(g: CanvasRenderingContext2D, view: Viewport, p: ParamValues, m: MusicFrame): void {
    if (!this.raster) return;
    applyFeedback(this.fb, g, view, p, this.stepped);
    this.stepped = false;
    const scheme = p.palette as string;
    let lut = PALETTES[scheme];
    if (!lut) {
      // "notes" follows the melody's colour; "rainbow" turns slowly with the beat.
      const h = scheme === "rainbow" ? (m.beats * 12) % 360 : this.hue;
      if (Math.abs(((h - this.lutHue + 540) % 360) - 180) > 2) { this.lut = huePalette(h); this.lutHue = h; }
      lut = this.lut;
    }
    const px = this.raster.pixels, { a, b } = this;
    // Contrast stretches the a-b difference around the same midpoint as before; kicks flash it brighter.
    const c = (p.contrast as number) || 1.6;
    const off = 0.5 + (1.25 - 0.5) * (c / 1.6) + this.flash * 0.25;
    for (let i = 0; i < px.length; i++) {
      const v = Math.max(0, Math.min(1, (a[i] - b[i]) * -c + off));
      px[i] = lut[(v * 255) | 0];
    }
    const W = this.w * this.cell, H = this.h * this.cell;
    // With afterglow the ink is laid over its own fading echoes instead of replacing them.
    g.globalAlpha = 1 - Math.min(0.9, (p.afterglow as number) * 0.9);
    this.raster.draw(g, W, H, true);
    g.globalAlpha = 1;
    // A soft bloom over the top that swells with the bass.
    const bloom = (p.bloom as number) * (0.25 + Math.min(1.5, m.bass) * 0.75);
    if (bloom > 0.02) {
      const s = 1.04 + Math.min(1.5, m.bass) * 0.04;
      g.globalCompositeOperation = "lighter";
      g.globalAlpha = Math.min(1, bloom * 0.22);
      g.save();
      g.translate(W / 2, H / 2);
      g.scale(s, s);
      this.raster.draw(g, W, H, true, -W / 2, -H / 2);
      g.restore();
      g.globalAlpha = 1;
      g.globalCompositeOperation = "source-over";
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
    { kind: "number", key: "spectrumGrowth", label: "Spectrum growth", min: 0, max: 2, step: 0.05, default: 0.6, group: "Music", global: "energy",
      description: "How much loud frequencies make their part of the screen grow. High values paint a living spectrogram." },
    { kind: "number", key: "bloom", label: "Bass bloom", min: 0, max: 2, step: 0.05, default: 0.7, group: "Music", global: "size",
      description: "A soft glow over the ink that swells with the bass." },
    { kind: "number", key: "feedShift", label: "Feed shift", min: -0.02, max: 0.02, step: 0.0005, default: 0, group: "Behaviour",
      description: "Nudges how fast fresh chemical is fed in. Up floods with growth, down starves it." },
    { kind: "number", key: "killShift", label: "Kill shift", min: -0.008, max: 0.008, step: 0.0002, default: 0, group: "Behaviour",
      description: "Nudges how fast the pattern dies off. Down spreads blobs, up erodes into dots." },
    { kind: "number", key: "diffusion", label: "Pattern scale", min: 0.2, max: 1.05, step: 0.01, default: 1, group: "Behaviour",
      description: "How far the chemicals spread. Lower makes finer, tighter patterns." },
    { kind: "number", key: "speed", label: "Growth speed", min: 1, max: 32, step: 1, default: 10, group: "Behaviour",
      description: "How many reaction steps run each frame, i.e. how fast patterns grow." },
    {
      kind: "choice", key: "palette", label: "Colours", default: "notes", group: "Look",
      description: "Colour scheme for the ink. Follow the melody re-tints it with every note.",
      options: [
        { value: "notes", label: "Follow the melody" },
        { value: "rainbow", label: "Rainbow, cycling with the beat" },
        { value: "ocean", label: "Ocean" },
        { value: "ember", label: "Ember" },
        { value: "bio", label: "Bioluminescent" },
      ],
    },
    ...feedbackParams(0, 0, 0),
    gravityModeParam("off", undefined, { label: "Flow direction", description: "Makes the ink flow, as if the dish were tilted. Point modes pour it toward a spot; Swirl stirs it." }),
    { kind: "number", key: "fieldGravity", label: "Flow speed", min: 0, max: 400, step: 5, default: 60, group: "Gravity", global: "gravity",
      description: "How fast the ink flows, pixels per second." },
    { kind: "number", key: "contrast", label: "Contrast", min: 0.4, max: 5, step: 0.05, default: 1.6, group: "Look",
      description: "How sharply the pattern's edges stand out. High values glow and saturate." },
    { kind: "number", key: "brush", label: "Brush size", min: 4, max: 150, step: 1, default: 14, group: "Brush",
      description: "Size of the area you seed or wipe when dragging." },
    {
      kind: "choice", key: "pattern", label: "Pattern", default: "coral", resetOnChange: true, group: "Setup",
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
    { kind: "number", key: "cellSize", label: "Cell size", min: 2, max: 8, step: 1, default: 4, resetOnChange: true, group: "Setup",
      description: "Pixels per simulation cell. Smaller is sharper but slower. Restarts the pattern." },
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
    { source: "tone", text: "Seeds a blob of growth, placed by pitch, and re-tints the ink" },
    { source: "kick", text: "Seeds a ring of growth around the centre and flashes the ink" },
    { source: "snare", text: "Wipes a random hole for the pattern to regrow into" },
    { source: "hat", text: "Sprinkles tiny seeds" },
    { source: "bassline", text: "Seeds growth low down, placed by pitch" },
    { source: "chord", text: "Seeds one blob per chord note round a circle, like a colour wheel" },
    { source: "spectrum", text: "Loud frequencies make their column grow (Spectrum growth)" },
    { source: "bass", text: "A glow over the ink swells (Bass bloom)" },
  ],
  create: () => new ReactionSim(),
};
