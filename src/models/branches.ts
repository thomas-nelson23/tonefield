import { hsla, type Gfx } from "../gl/gfx";
import { curveFor, type ModelDefinition, type MusicFrame, type NoteEvent, type ParamValues, type PointerInput, type SimulationModel, type Viewport } from "./types";
import { noteHue } from "./lib/music";
import { Feedback, applyFeedback, colourParam, feedbackParams, glowSprite, hueToward, schemeHue } from "./lib/visual";

/** Lines are drawn in this many hues per depth, one path each on the CPU. */
const HUES = 18;
/** Most tip glows drawn in a frame. */
const MAX_GLOWS = 200;

const GROW_OPTIONS = [
  { value: "mix", label: "Mix" },
  { value: "sprout", label: "Sprout" },
  { value: "bloom", label: "Bloom" },
  { value: "creep", label: "Creep" },
];
const DISSOLVE_OPTIONS = [
  { value: "mix", label: "Mix" },
  { value: "retract", label: "Retract" },
  { value: "crumble", label: "Crumble" },
  { value: "fade", label: "Fade" },
];
type Grow = "sprout" | "bloom" | "creep";
type Dissolve = "retract" | "crumble" | "fade";

/**
 * One fractal tree: `arms` trunks leave its root, and every branch splits in
 * two, `depth` times. Each arm is a binary heap: node 1 is the trunk and node
 * k's branches are 2k and 2k + 1, so a node's depth is floor(log2 k).
 */
class Tree {
  readonly n: number;
  /** How much of each branch is grown, 0..1. */
  readonly grown: Float32Array;
  readonly alive: Uint8Array;
  /** Random bend and length per branch, -1..1, so no two trees are alike. */
  readonly jitA: Float32Array;
  readonly jitL: Float32Array;
  readonly spark: Float32Array;
  readonly sx: Float64Array;
  readonly sy: Float64Array;
  readonly ex: Float64Array;
  readonly ey: Float64Array;
  readonly ang: Float64Array;
  /** How far out it may grow, in levels (Sprout, Creep) or as a share of full size (Bloom). */
  frontier = 0;
  phase: "grow" | "hold" | "dissolve" = "grow";
  /** Seconds left to stand fully grown. */
  hold = 0;
  alpha = 1;
  crumbleClock = 0;
  dye = 0;
  dyeHue = 0;

  constructor(
    readonly x: number, readonly y: number, readonly angle: number, readonly arms: number,
    readonly depth: number, readonly scale: number, public hue: number,
    readonly grow: Grow, readonly dissolve: Dissolve,
  ) {
    const N = 1 << depth;
    this.n = arms * N;
    this.grown = new Float32Array(this.n);
    this.alive = new Uint8Array(this.n).fill(1);
    this.jitA = new Float32Array(this.n);
    this.jitL = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) { this.jitA[i] = Math.random() * 2 - 1; this.jitL[i] = Math.random() * 2 - 1; }
    this.spark = new Float32Array(this.n);
    this.sx = new Float64Array(this.n);
    this.sy = new Float64Array(this.n);
    this.ex = new Float64Array(this.n);
    this.ey = new Float64Array(this.n);
    this.ang = new Float64Array(this.n);
  }

  /** Mark node k of arm `arm` and everything growing from it dead, so it shrinks away. */
  kill(arm: number, k: number): void {
    const N = 1 << this.depth, base = arm * N;
    for (let lo = k, hi = k; lo < N; lo = lo * 2, hi = hi * 2 + 1) {
      for (let j = lo; j <= Math.min(hi, N - 1); j++) this.alive[base + j] = 0;
    }
  }

  /** Nothing of it is left on screen. */
  gone(): boolean {
    if (this.alpha <= 0) return true;
    if (this.phase !== "dissolve") return false;
    for (let i = 0; i < this.n; i++) if (this.grown[i] > 0) return false;
    return true;
  }
}

/**
 * Fractal trees that sprout all over the screen, grow out fork by fork, stand
 * for a while and then dissolve, each in its own way, while new ones grow in
 * the gaps and from the tips of the old, so the picture keeps spreading and
 * changing like Living ink. Each tree grows by Sprouting (trunk first, then
 * each level of forks), Blooming (the whole tree swelling out at once) or
 * Creeping (one level at a time, slowly), and dissolves by Retracting (tips
 * first, back into the root), Crumbling (branches breaking off) or Fading.
 */
class BranchesSim implements SimulationModel {
  private trees: Tree[] = [];
  private view: Viewport = { width: 1, height: 1 };
  private time = 0;
  private beats = 0;
  private beatRate = 2;
  private birthClock = 0;
  private boost = 0;
  private flash = 0;
  private bend = 0;
  private bendTarget = 0;
  private pointer: { x: number; y: number; cut: boolean; clock: number } | null = null;
  private fb = new Feedback();
  private stepped = false;

  reset(view: Viewport, p: ParamValues): void {
    this.view = view;
    this.trees = [];
    this.time = 0;
    // Start with a scattering of half-grown trees, so the screen isn't empty.
    const n = Math.round((p.trees as number) * 0.6);
    for (let i = 0; i < n; i++) {
      const t = this.plant(p, null, null, null, this.schemeHueNow(p));
      if (t) t.frontier = Math.random() * t.depth;
    }
  }

  resize(view: Viewport): void {
    this.view = view;
  }

  private schemeHueNow(p: ParamValues, hue = 210): number {
    return schemeHue(p.colours as string, Math.random(), hue, this.beats);
  }

  /** The emptiest of a few random spots, a little past the edges so trees also grow in from off screen. */
  private openSpot(): [number, number] {
    const { width: w, height: h } = this.view;
    let bx = w / 2, by = h / 2, best = -1;
    for (let k = 0; k < 12; k++) {
      const x = -w * 0.05 + Math.random() * w * 1.1, y = -h * 0.05 + Math.random() * h * 1.1;
      let near = Infinity;
      for (const t of this.trees) near = Math.min(near, (t.x - x) ** 2 + (t.y - y) ** 2);
      if (near > best) { best = near; bx = x; by = y; }
    }
    return [bx, by];
  }

  /** Start a tree; with no place given, it goes in the emptiest spot. Returns null when the screen is full. */
  private plant(p: ParamValues, x: number | null, y: number | null, angle: number | null, hue: number, force = false): Tree | null {
    if (this.trees.length >= (p.trees as number) * (force ? 1.5 : 1)) return null;
    if (x === null || y === null) [x, y] = this.openSpot();
    const growMode = p.grow as string, dissolveMode = p.dissolve as string;
    const grow = (growMode === "mix" ? ["sprout", "bloom", "creep"][Math.floor(Math.random() * 3)] : growMode) as Grow;
    const dissolve = (dissolveMode === "mix" ? ["retract", "crumble", "fade"][Math.floor(Math.random() * 3)] : dissolveMode) as Dissolve;
    const maxArms = Math.round(p.arms as number);
    // A tree sprouting from another's tip grows one way; a fresh one may star out several.
    const arms = angle === null ? 1 + Math.floor(Math.random() * maxArms) : 1;
    const t = new Tree(x, y, angle ?? Math.random() * Math.PI * 2, arms, Math.round(p.levels as number),
      0.65 + Math.random() * 0.6, hue, grow, dissolve);
    this.trees.push(t);
    return t;
  }

  step(dt: number, p: ParamValues, m: MusicFrame): void {
    this.stepped = true;
    this.time += dt;
    // Beats per second, smoothed, so lifetimes follow the tempo.
    if (m.beats > this.beats) this.beatRate += ((m.beats - this.beats) / dt - this.beatRate) * Math.min(1, dt * 2);
    this.beats = m.beats;
    const speed = (p.speed as number) * (1 + this.boost * (p.kickGrow as number)) * (1 + Math.min(1, m.level) * 0.3);
    this.boost *= Math.exp(-dt * 3);
    this.flash *= Math.exp(-dt * 5);
    this.bend += (this.bendTarget - this.bend) * Math.min(1, dt * 4);
    this.bendTarget *= Math.exp(-dt * 0.7);
    const life = Math.max(0.5, (p.lifetime as number) / Math.max(0.5, this.beatRate));
    const spread = p.spread as number;
    const sparkFade = Math.exp(-dt * 6);

    for (const t of this.trees) {
      const D = t.depth, N = 1 << D;
      t.dye *= Math.exp(-dt * 0.4);
      if (t.phase === "grow") {
        const rate = t.grow === "creep" ? 0.45 : t.grow === "bloom" ? 0.7 : 1;
        t.frontier = Math.min(D + 0.5, t.frontier + speed * rate * dt);
        if (t.frontier >= D + 0.5 && this.grownAll(t)) {
          t.phase = "hold";
          t.hold = life * (0.6 + Math.random() * 0.8);
          // Like ink spreading, new trees may sprout from this one's tips.
          if (Math.random() < spread) this.sproutFrom(t, p);
        }
      } else if (t.phase === "hold") {
        t.hold -= dt;
        if (t.hold <= 0) t.phase = "dissolve";
      } else {
        if (t.dissolve === "retract") t.frontier = Math.max(0, t.frontier - speed * 1.2 * dt);
        else if (t.dissolve === "fade") t.alpha -= dt / Math.max(0.6, life * 0.35);
        else {
          // Crumble: branches break off at random and fall back quickly.
          t.crumbleClock += dt * (6 + speed * 3);
          while (t.crumbleClock >= 1) {
            t.crumbleClock -= 1;
            const d = 1 + Math.floor(Math.random() * Math.max(1, D - 1));
            t.kill(Math.floor(Math.random() * t.arms), (1 << d) + Math.floor(Math.random() * (1 << d)));
          }
          t.frontier = Math.max(0, t.frontier - speed * 0.4 * dt);
        }
      }

      const grow = speed * dt * (t.phase === "dissolve" && t.dissolve === "crumble" ? 2.5 : 1);
      for (let a = 0; a < t.arms; a++) {
        const base = a * N;
        for (let k = 1; k < N; k++) {
          const i = base + k;
          t.spark[i] *= sparkFade;
          if (t.grow === "bloom") {
            // Every level swells out together.
            const target = t.alive[i] ? Math.min(1, t.frontier / (D + 0.5)) : 0;
            if (t.grown[i] < target) t.grown[i] = target;
            continue;
          }
          const d = 31 - Math.clz32(k);
          const target = t.alive[i] ? Math.min(1, Math.max(0, t.frontier - d)) : 0;
          if (t.grown[i] < target && (k === 1 || t.grown[base + (k >> 1)] >= 1)) {
            t.grown[i] = Math.min(target, t.grown[i] + grow);
            if (t.grown[i] < 1) t.spark[i] = Math.max(t.spark[i], 0.35);
          }
        }
        // Shrink from the tips in: a branch only shrinks once everything growing from it is gone.
        for (let k = N - 1; k >= 1; k--) {
          const i = base + k;
          const d = 31 - Math.clz32(k);
          const target = !t.alive[i] ? 0 : t.grow === "bloom" ? Math.min(1, t.frontier / (D + 0.5)) : Math.min(1, Math.max(0, t.frontier - d));
          if (t.grown[i] > target) {
            const c = 2 * k;
            if (c < N && (t.grown[base + c] > 0 || t.grown[base + c + 1] > 0)) continue;
            t.grown[i] = Math.max(target, t.grown[i] - grow * 1.3);
          }
        }
      }
    }
    this.trees = this.trees.filter((t) => !t.gone());

    // Keep the screen filled: a new tree in the emptiest gap every so often.
    this.birthClock += dt * (p.births as number) * (1 + Math.min(1, m.level));
    while (this.birthClock >= 1) {
      this.birthClock -= 1;
      this.plant(p, null, null, null, this.schemeHueNow(p, m.hue));
    }

    if (this.pointer) {
      this.pointer.clock -= dt;
      if (this.pointer.clock <= 0) {
        this.pointer.clock = 0.15;
        if (this.pointer.cut) this.dissolveNear(this.pointer.x, this.pointer.y, 120);
        else this.plant(p, this.pointer.x, this.pointer.y, null, this.schemeHueNow(p, m.hue), true);
      }
    }
  }

  private grownAll(t: Tree): boolean {
    for (let i = 0; i < t.n; i++) if (t.alive[i] && (i & ((1 << t.depth) - 1)) !== 0 && t.grown[i] < 1) return false;
    return true;
  }

  /** New trees from one or two of `t`'s outer tips, carrying on the way the branch was growing. */
  private sproutFrom(t: Tree, p: ParamValues): void {
    const N = 1 << t.depth;
    const count = 1 + (Math.random() < 0.4 ? 1 : 0);
    for (let c = 0; c < count; c++) {
      const a = Math.floor(Math.random() * t.arms);
      const k = (N >> 1) + Math.floor(Math.random() * (N >> 1));
      const o = a * N + k;
      if (!t.alive[o] || t.grown[o] < 1) continue;
      const { width: w, height: h } = this.view;
      if (t.ex[o] < -w * 0.1 || t.ey[o] < -h * 0.1 || t.ex[o] > w * 1.1 || t.ey[o] > h * 1.1) continue;
      this.plant(p, t.ex[o], t.ey[o], t.ang[o], (t.hue + (Math.random() - 0.5) * 30 + 360) % 360);
    }
  }

  private dissolveNear(x: number, y: number, r: number): void {
    for (const t of this.trees) {
      if ((t.x - x) ** 2 + (t.y - y) ** 2 < r * r || this.touches(t, x, y, r * 0.5)) t.phase = "dissolve";
    }
  }

  private touches(t: Tree, x: number, y: number, r: number): boolean {
    for (let i = 0; i < t.n; i++) if (t.grown[i] > 0 && (t.ex[i] - x) ** 2 + (t.ey[i] - y) ** 2 < r * r) return true;
    return false;
  }

  /** Lay every tree out for this frame. */
  private layout(p: ParamValues, m: MusicFrame): void {
    const { width: w, height: h } = this.view;
    const taper = p.taper as number;
    const spread = ((p.forkAngle as number) * Math.PI) / 180 * (1 + this.bend);
    const asym = p.asymmetry as number;
    const sway = p.sway as number;
    const warp = p.warp as number;
    const spec = m.spectrum;
    const time = this.time;
    const R = Math.min(w, h) * (p.treeSize as number);
    for (const t of this.trees) {
      const D = t.depth, N = 1 << D;
      // The trunk length that makes the whole tree reach about R.
      const L0 = (R * t.scale * (1 - taper)) / (1 - taper ** (D + 1));
      for (let a = 0; a < t.arms; a++) {
        const base = a * N;
        for (let k = 1; k < N; k++) {
          const o = base + k;
          const d = 31 - Math.clz32(k);
          let px: number, py: number, pa: number;
          if (k === 1) {
            pa = t.angle + (a * Math.PI * 2) / t.arms;
            px = t.x; py = t.y;
          } else {
            const q = base + (k >> 1);
            px = t.ex[q]; py = t.ey[q];
            pa = t.ang[q] + ((k & 1) ? -1 : 1) * spread * 0.5;
          }
          const angle = pa + t.jitA[o] * asym * 0.6 + sway * 0.25 * Math.sin(time * 0.8 + d * 1.3 + t.x * 0.01);
          const band = spec[Math.min(spec.length - 1, Math.floor((d / D) * spec.length))];
          const len = L0 * taper ** d * (1 + t.jitL[o] * asym * 0.45) * (1 + warp * band * 0.8) * t.grown[o];
          t.ang[o] = angle;
          t.sx[o] = px; t.sy[o] = py;
          t.ex[o] = px + Math.cos(angle) * len;
          t.ey[o] = py + Math.sin(angle) * len;
        }
      }
    }
  }

  onNote(ev: NoteEvent, p: ParamValues): void {
    const { width: w, height: h } = this.view;
    if (ev.role === "kick") {
      // A surge of growth and a new tree in a gap.
      this.boost = Math.min(3, this.boost + ev.velocity * 1.5);
      this.flash = Math.min(1, this.flash + ev.velocity * 0.7);
      const n = Math.round((p.kickBirth as number) * ev.velocity);
      for (let i = 0; i < n; i++) this.plant(p, null, null, null, this.schemeHueNow(p), true);
    } else if (ev.role === "snare") {
      // A few grown trees start to crumble away.
      const n = Math.round((p.snareCrumble as number) * ev.velocity * 2);
      const standing = this.trees.filter((t) => t.phase === "hold");
      for (let i = 0; i < n && standing.length; i++) {
        const t = standing.splice(Math.floor(Math.random() * standing.length), 1)[0];
        t.phase = "dissolve";
        for (let j = 0; j < 3; j++) {
          const d = 1 + Math.floor(Math.random() * Math.max(1, t.depth - 1));
          t.kill(Math.floor(Math.random() * t.arms), (1 << d) + Math.floor(Math.random() * (1 << d)));
        }
      }
    } else if (ev.role === "hat") {
      for (let j = 0; j < 8 && this.trees.length; j++) {
        const t = this.trees[Math.floor(Math.random() * this.trees.length)];
        const i = Math.floor(Math.random() * t.n);
        if (t.grown[i] > 0) t.spark[i] = Math.max(t.spark[i], ev.velocity);
      }
    } else if (ev.role === "tone") {
      // A tree sprouts where the note lands, low notes left and high notes right, in the note's colour.
      if (ev.velocity <= 0.02) return;
      const hue = p.colours === "notes" ? noteHue(ev.note) : this.schemeHueNow(p);
      const t = this.plant(p, w * (0.05 + ev.x * 0.9), h * (0.1 + Math.random() * 0.8), null, hue, true);
      if (t) { t.dye = 1; t.dyeHue = hue; }
    } else if (ev.role === "bassline") {
      // High bass notes open the forks wider and low ones close them.
      this.bendTarget = (p.bassBend as number) * (ev.x - 0.5) * 2 * ev.velocity;
    } else if (ev.role === "chord") {
      // Each tree takes one of the chord's notes.
      const notes = ev.notes ?? [ev.note];
      this.trees.forEach((t, i) => {
        t.dyeHue = noteHue(notes[i % notes.length]);
        t.dye = Math.max(t.dye, 0.6 * ev.velocity);
      });
    }
  }

  onPointer(input: PointerInput): void {
    if (input.type === "up") { this.pointer = null; return; }
    if (input.type === "down") this.pointer = { x: input.x, y: input.y, cut: input.button === 2 || input.shift, clock: 0 };
    else if (this.pointer) { this.pointer.x = input.x; this.pointer.y = input.y; }
  }

  private hueOf(t: Tree, d: number, scheme: string, m: MusicFrame): number {
    // Each tree keeps its own colour, shifting a little along its branches.
    // Rainbow keeps cycling with the beat; the other schemes hold the colour the tree was born with.
    const h = (t.hue + d * 6 + (scheme === "rainbow" ? m.beats * 15 : 0)) % 360;
    return t.dye > 0.03 ? hueToward(h, t.dyeHue, Math.min(1, t.dye * 1.4)) : h;
  }

  private widthAt(d: number, D: number, p: ParamValues, m: MusicFrame): number {
    return (p.lineWidth as number) * (1 - (d / (D + 1)) * 0.65) * (1 + Math.min(1.5, m.bass) * 0.4 + this.flash * 0.3);
  }

  private brightness(p: ParamValues, m: MusicFrame): number {
    return (p.glow as number) * (0.75 + Math.min(1, m.level) * 0.35 + this.flash * 0.35);
  }

  private readonly cpuPaths: (Path2D | null)[] = [];

  render(g: CanvasRenderingContext2D, view: Viewport, p: ParamValues, m: MusicFrame): void {
    applyFeedback(this.fb, g, view, p, this.stepped);
    this.stepped = false;
    this.layout(p, m);
    const scheme = p.colours as string;
    const bright = this.brightness(p, m);
    const D = Math.round(p.levels as number);
    const node = (p.nodeSize as number) * (1 + m.pulse * 0.4);
    g.globalCompositeOperation = "lighter";
    g.lineCap = "round";
    // Trees that are fading draw on their own; the rest share one path per depth and hue.
    const paths = this.cpuPaths;
    paths.length = (D + 1) * HUES;
    const used: number[] = [];
    const flush = (alpha: number) => {
      for (const bucket of used) {
        const d = Math.floor(bucket / HUES), hb = bucket % HUES;
        g.lineWidth = this.widthAt(d, D, p, m);
        g.strokeStyle = `hsla(${(hb + 0.5) * (360 / HUES)} 85% 62% / ${Math.min(1, alpha * bright * (1 - d / (D + 2) * 0.4))})`;
        g.stroke(paths[bucket]!);
        paths[bucket] = null;
      }
      used.length = 0;
    };
    const drawTree = (t: Tree) => {
      const N = 1 << t.depth;
      for (let i = 0; i < t.n; i++) {
        const k = i & (N - 1);
        if (k === 0 || t.grown[i] <= 0) continue;
        const d = 31 - Math.clz32(k);
        const bucket = d * HUES + Math.floor(this.hueOf(t, d, scheme, m) / (360 / HUES)) % HUES;
        let path = paths[bucket];
        if (!path) { path = paths[bucket] = new Path2D(); used.push(bucket); }
        path.moveTo(t.sx[i], t.sy[i]);
        path.lineTo(t.ex[i], t.ey[i]);
      }
    };
    for (const t of this.trees) if (t.alpha >= 1) drawTree(t);
    flush(1);
    for (const t of this.trees) if (t.alpha < 1) { drawTree(t); flush(Math.max(0, t.alpha)); }
    if (node > 0.05) {
      for (const t of this.trees) {
        const N = 1 << t.depth;
        g.fillStyle = `hsla(${t.hue} 80% 75% / ${Math.max(0, t.alpha)})`;
        g.beginPath();
        for (let i = 0; i < t.n; i++) {
          if ((i & (N - 1)) === 0 || t.grown[i] < 1) continue;
          g.moveTo(t.ex[i] + node, t.ey[i]);
          g.arc(t.ex[i], t.ey[i], node, 0, Math.PI * 2);
        }
        g.fill();
      }
    }
    if (p.tipGlow) {
      const dpr = window.devicePixelRatio || 1;
      const size = Math.max(1, p.lineWidth as number) * 10 * (1 + Math.min(1, m.treble) * 0.6);
      let drawn = 0;
      for (const t of this.trees) {
        const N = 1 << t.depth;
        for (let i = 0; i < t.n && drawn < MAX_GLOWS; i++) {
          const sp = t.spark[i] * Math.min(1, t.grown[i] * 4) * t.alpha;
          if (sp < 0.15 || (i & (N - 1)) === 0) continue;
          const s = size * sp;
          g.drawImage(glowSprite(this.hueOf(t, 31 - Math.clz32(i & (N - 1)), scheme, m), 90, s * dpr), t.ex[i] - s / 2, t.ey[i] - s / 2, s, s);
          drawn++;
        }
      }
    }
    g.lineCap = "butt";
    g.lineWidth = 1;
    g.globalCompositeOperation = "source-over";
  }

  /** The same picture as `render`, drawn on the GPU. */
  renderGL(gfx: Gfx, _view: Viewport, p: ParamValues, m: MusicFrame): void {
    gfx.feedback(p.afterglow as number, p.zoom as number, p.spin as number, this.stepped);
    this.stepped = false;
    this.layout(p, m);
    const scheme = p.colours as string;
    const bright = this.brightness(p, m);
    const node = (p.nodeSize as number) * (1 + m.pulse * 0.4);
    const size = Math.max(1, p.lineWidth as number) * 10 * (1 + Math.min(1, m.treble) * 0.6);
    gfx.blend("add");
    let drawn = 0;
    for (const t of this.trees) {
      const D = t.depth, N = 1 << D, alpha = Math.max(0, t.alpha);
      for (let i = 0; i < t.n; i++) {
        const k = i & (N - 1);
        if (k === 0 || t.grown[i] <= 0) continue;
        const d = 31 - Math.clz32(k);
        const hue = this.hueOf(t, d, scheme, m);
        gfx.line(t.sx[i], t.sy[i], t.ex[i], t.ey[i], this.widthAt(d, D, p, m), hsla(hue, 0.85, 0.62, Math.min(1, alpha * bright * (1 - d / (D + 2) * 0.4))));
        if (node > 0.05 && t.grown[i] >= 1) gfx.disc(t.ex[i], t.ey[i], node, hsla(hue, 0.8, 0.75, alpha));
        if (p.tipGlow && drawn < MAX_GLOWS) {
          const sp = t.spark[i] * Math.min(1, t.grown[i] * 4) * alpha;
          if (sp >= 0.15) { gfx.glow(t.ex[i], t.ey[i], size * sp, Math.round(hue / 10) * 10, 90); drawn++; }
        }
      }
    }
    gfx.blend("normal");
  }

  stats(): string {
    let lines = 0;
    for (const t of this.trees) for (let i = 0; i < t.n; i++) if (t.grown[i] > 0) lines++;
    return `${this.trees.length} trees · ${lines} branches`;
  }
}

export const branches: ModelDefinition = {
  id: "branches",
  name: "Branches",
  category: "Surfaces",
  description: "Fractal trees sprout all over the screen, grow out fork by fork, stand for a while and dissolve, while new ones grow in the gaps and from the tips of the old, so the picture keeps spreading and changing like Living ink. Each tree sprouts, blooms or creeps as it grows, and retracts, crumbles or fades as it goes. Kicks surge the growth and sprout new trees, snares crumble trees away, melody notes sprout trees where they land, the bass line opens and closes the forks and chords colour the trees.",
  hint: "Click or drag to plant trees. Right-drag or Shift-drag to dissolve them.",
  fixedDt: 1 / 60,
  paintsBackground: true,
  params: [
    { kind: "choice", key: "grow", label: "Grow", default: "mix", segmented: true, options: GROW_OPTIONS,
      description: "How a tree grows. Sprout grows the trunk, then each level of forks; Bloom swells the whole tree out at once; Creep grows it slowly, a level at a time. Mix gives each tree one at random." },
    { kind: "choice", key: "dissolve", label: "Dissolve", default: "mix", segmented: true, options: DISSOLVE_OPTIONS,
      description: "How a tree goes. Retract pulls it back, tips first, into its root; Crumble breaks its branches off; Fade lets it fade away. Mix gives each tree one at random." },
    { kind: "number", key: "trees", label: "Trees", min: 3, max: 60, step: 1, default: 22, curve: curveFor(3, 60, 22), perf: true, random: [8, 40],
      description: "The most trees on screen at once. More fills the screen more densely and is heavier to draw." },
    { kind: "number", key: "treeSize", label: "Tree size", min: 0.05, max: 0.6, step: 0.01, default: 0.2, curve: curveFor(0.05, 0.6, 0.2), random: [0.1, 0.4],
      description: "How far a full tree reaches, as a share of the screen. Trees vary a little around it." },
    { kind: "number", key: "forkAngle", label: "Fork angle", min: 5, max: 170, step: 1, default: 55, random: [20, 130],
      description: "How wide each fork opens, in degrees. Narrow grows tall and spiky; wide curls back into lace." },
    { kind: "number", key: "speed", label: "Growth speed", min: 0.2, max: 12, step: 0.1, default: 2.5, curve: curveFor(0.2, 12, 2.5), random: [1, 7], global: "energy",
      description: "How fast trees grow and dissolve, in branch lengths a second. Kicks surge it." },
    { kind: "number", key: "lifetime", label: "Lifetime", min: 1, max: 64, step: 1, default: 8, curve: curveFor(1, 64, 8), random: [2, 24],
      format: (v) => (v % 4 === 0 ? `${v / 4} bar${v === 4 ? "" : "s"}` : `${v} beats`),
      description: "How long a full-grown tree stands before it dissolves, following the tempo." },
    { kind: "number", key: "spread", label: "Spreading", min: 0, max: 1, step: 0.01, default: 0.6, random: [0.2, 1],
      description: "How likely a full-grown tree is to sprout new trees from its tips, so growth spreads across the screen like ink." },
    { kind: "number", key: "asymmetry", label: "Wildness", min: 0, max: 1, step: 0.01, default: 0.35, random: [0, 0.8],
      description: "How far each branch strays from a perfect fractal in angle and length. Zero is crisp and geometric; high grows like a real tree." },
    { kind: "number", key: "births", label: "New trees", min: 0, max: 6, step: 0.05, default: 1.2, curve: curveFor(0, 6, 1.2), advanced: true, random: [0.3, 3],
      description: "How many fresh trees start in the emptiest gaps each second (louder music, more), as long as there is room." },
    { kind: "number", key: "arms", label: "Arms", min: 1, max: 8, step: 1, default: 3, advanced: true, random: [1, 6],
      description: "The most trunks a fresh tree stars out with; each gets one to this many. Trees sprouting from tips grow one way." },
    { kind: "number", key: "levels", label: "Levels", min: 3, max: 9, step: 1, default: 6, resetOnChange: true, perf: true, advanced: true,
      description: "How many times the branches split. Each level doubles the branches, so high is heavy to draw. Rebuilds the scene." },
    { kind: "number", key: "taper", label: "Taper", min: 0.5, max: 0.9, step: 0.01, default: 0.72, advanced: true, random: [0.6, 0.85],
      description: "How much shorter each branch is than the one it grows from." },
    { kind: "number", key: "sway", label: "Sway", min: 0, max: 2, step: 0.01, default: 0.4, advanced: true, random: [0, 1.2],
      description: "How much the branches sway as if in a breeze." },
    { kind: "number", key: "lineWidth", label: "Line width", min: 0.3, max: 6, step: 0.1, default: 1.8, advanced: true, random: [0.6, 3.5],
      description: "How thick the trunks are; branches thin toward the tips. The bass thickens them." },
    { kind: "number", key: "nodeSize", label: "Joint dots", min: 0, max: 6, step: 0.1, default: 1.1, advanced: true, random: [0, 3],
      description: "Size of the dot at each fork. Zero leaves only the lines." },
    { kind: "number", key: "glow", label: "Line glow", min: 0.1, max: 1.5, step: 0.01, default: 0.85, advanced: true, random: [0.4, 1.2],
      description: "How bright the lines are. Where they cross they add up toward white." },
    { kind: "boolean", key: "tipGlow", label: "Glowing tips", default: true, advanced: true,
      description: "A small light on each growing tip; it sparks on the hi-hats." },
    // Set by the matrix rows Growth surge, Crumble, Open the forks and Spectrum reach.
    { kind: "number", key: "kickGrow", label: "Kick surge", min: 0, max: 4, step: 0.05, default: 1.5, hidden: true },
    { kind: "number", key: "kickBirth", label: "Kick sprouts", min: 0, max: 6, step: 0.1, default: 1, hidden: true },
    { kind: "number", key: "snareCrumble", label: "Snare crumble", min: 0, max: 4, step: 0.05, default: 1, hidden: true },
    { kind: "number", key: "bassBend", label: "Bass bend", min: 0, max: 1, step: 0.01, default: 0.25, hidden: true },
    { kind: "number", key: "warp", label: "Spectrum reach", min: 0, max: 2, step: 0.01, default: 0.5, hidden: true },
    colourParam(),
    ...feedbackParams(0.4),
  ],
  macros: [
    { key: "bloom", label: "Overgrowth", description: "Big, wild, crowded trees that spread from every tip.",
      targets: [{ param: "treeSize", amount: 0.15 }, { param: "spread", amount: 0.4 }, { param: "asymmetry", amount: 0.35 }, { param: "trees", amount: 0.25 }, { param: "births", amount: 0.2 }] },
    { key: "frost", label: "Frost", description: "Crisp, still snowflake trees with narrow forks.",
      targets: [{ param: "asymmetry", amount: -0.5 }, { param: "sway", amount: -0.4 }, { param: "forkAngle", amount: -0.15 }, { param: "colours", set: "ice", at: 0.5 }, { param: "grow", set: "bloom", at: 0.3 }] },
    { key: "storm", label: "Storm", description: "Short lives: trees flash up fast and crumble away on every beat.",
      targets: [{ param: "lifetime", amount: -0.25 }, { param: "speed", amount: 0.3 }, { param: "sway", amount: 0.4 }, { param: "kickGrow", amount: 0.3 }, { param: "dissolve", set: "crumble", at: 0.4 }] },
    { key: "hyper", label: "Hyperspace", description: "Long glowing trails that fly outward into a turning tunnel.",
      targets: [{ param: "afterglow", amount: 0.45 }, { param: "zoom", amount: 0.45 }, { param: "spin", amount: 0.2 }, { param: "glow", amount: -0.15 }] },
  ],
  modulations: [
    { source: "lfoBar", target: "forkAngle", amount: 0.08 },
    { source: "kick", target: "lineWidth", amount: 0.15 },
    { source: "treble", target: "nodeSize", amount: 0.15 },
  ],
  reactions: [
    { source: "kick", label: "Growth surge", text: "Growth surges, the lines flash and a new tree sprouts in a gap. The strength is how hard", param: ["kickGrow", "kickBirth"] },
    { source: "snare", label: "Crumble", text: "A few full-grown trees start to crumble away. The strength is how many", param: "snareCrumble" },
    { source: "hat", label: "Tip sparks", text: "A few branch tips spark" },
    { source: "tone", label: "Sprout on notes", text: "A tree sprouts where the note lands (low notes left, high notes right) in the note's colour" },
    { source: "bassline", label: "Open the forks", text: "High bass notes open the forks wider and low ones close them. The strength is how far", param: "bassBend" },
    { source: "chord", label: "Chord colours", text: "Each tree takes one of the chord's notes" },
    { source: "bass", label: "Thicker lines", text: "The bass thickens the branches" },
    { source: "level", label: "Grow and glow", text: "Louder music grows trees faster, starts more of them and makes them brighter" },
    { source: "treble", label: "Bigger tip glow", text: "The glows at the tips grow bigger" },
    { source: "spectrum", label: "Spectrum reach", text: "Each level of branches stretches with its part of the spectrum, trunks with the bass and twigs with the treble. The strength is how much", param: "warp" },
    { source: "beat", label: "Beat pulse", text: "The joint dots pulse on the beat" },
  ],
  create: () => new BranchesSim(),
};
