import { hsla, type Gfx } from "../gl/gfx";
import { curveFor, type ModelDefinition, type MusicFrame, type NoteEvent, type ParamValues, type PointerInput, type SimulationModel, type Viewport } from "./types";
import { noteHue } from "./lib/music";
import { Feedback, applyFeedback, colourParam, feedbackParams, glowSprite, hueToward, schemeHue } from "./lib/visual";

/** Lines are drawn in this many hues per depth, one path each on the CPU. */
const HUES = 18;
/** Most tip glows drawn in a frame. */
const MAX_GLOWS = 200;

/** How the tree grows and shrinks. */
const STYLE_OPTIONS = [
  { value: "breathe", label: "Breathe" },
  { value: "wander", label: "Wander" },
  { value: "pulse", label: "Pulse" },
  { value: "seasons", label: "Seasons" },
];

/**
 * A fractal tree, like Plexus's Fractal tree pattern, that is alive: each
 * arm splits in two again and again, and every branch grows out from its
 * parent and dies back tip first. Branches that die back regrow at a slightly
 * different angle and length, so like Living ink the shape keeps changing
 * while the symmetry holds. The Growth style sets the rhythm: the whole tree
 * breathing in and out, branches dying and regrowing at random, a surge of
 * growth on every beat, or full seasons of growth and fall.
 *
 * The tree is stored per arm as a binary heap: node 1 is the trunk and node
 * k's branches are 2k and 2k + 1, so a node's depth is floor(log2 k).
 */
class BranchesSim implements SimulationModel {
  private arms = 6;
  private depth = 8;
  /** Nodes per arm, heap-indexed from 1. */
  private N = 256;
  private mirror = true;
  /** Per state slot (one arm's worth when mirrored, every arm's otherwise): */
  private grown = new Float32Array(0);
  private alive = new Uint8Array(0);
  /** When a dead branch comes back, in seconds of model time. */
  private reviveAt = new Float32Array(0);
  /** This growth's random bend and length, -1..1, picked again each time it regrows. */
  private jitA = new Float32Array(0);
  private jitL = new Float32Array(0);
  /** A note colour soaked into the branch, and how strongly, fading. */
  private dyeHue = new Float32Array(0);
  private dye = new Float32Array(0);
  private spark = new Float32Array(0);
  /** Where each branch of every arm ends this frame, and its direction, for drawing and the pointer. */
  private sx = new Float64Array(0);
  private sy = new Float64Array(0);
  private ex = new Float64Array(0);
  private ey = new Float64Array(0);
  private ang = new Float64Array(0);
  private view: Viewport = { width: 1, height: 1 };
  private time = 0;
  private rotation = 0;
  /** How far out the tree is allowed to grow, in levels. */
  private frontier = 0;
  private boost = 0;
  private flash = 0;
  private bend = 0;
  private bendTarget = 0;
  private changeClock = 0;
  private seasonGen = -1;
  private beats = 0;
  /** The beat clock at the last kick. */
  private lastKick = -100;
  private pointer: { x: number; y: number; cut: boolean; clock: number } | null = null;
  private params: ParamValues = {};
  private fb = new Feedback();
  private stepped = false;

  reset(view: Viewport, p: ParamValues): void {
    this.view = view;
    this.params = p;
    this.arms = Math.round(p.symmetry as number);
    this.depth = Math.round(p.levels as number);
    this.N = 1 << this.depth;
    this.mirror = p.mirror as boolean;
    const slots = (this.mirror ? 1 : this.arms) * this.N;
    this.grown = new Float32Array(slots);
    this.alive = new Uint8Array(slots).fill(1);
    this.reviveAt = new Float32Array(slots);
    this.jitA = new Float32Array(slots);
    this.jitL = new Float32Array(slots);
    for (let i = 0; i < slots; i++) this.rejitter(i);
    this.dyeHue = new Float32Array(slots);
    this.dye = new Float32Array(slots);
    this.spark = new Float32Array(slots);
    this.sx = new Float64Array(this.arms * this.N);
    this.sy = new Float64Array(this.arms * this.N);
    this.ex = new Float64Array(this.arms * this.N);
    this.ey = new Float64Array(this.arms * this.N);
    this.ang = new Float64Array(this.arms * this.N);
    this.time = 0;
    this.frontier = 1;
    this.seasonGen = -1;
  }

  resize(view: Viewport): void {
    this.view = view;
  }

  private rejitter(i: number): void {
    this.jitA[i] = Math.random() * 2 - 1;
    this.jitL[i] = Math.random() * 2 - 1;
  }

  /** The state slot of node `k` on arm `arm`. */
  private slot(arm: number, k: number): number {
    return this.mirror ? k : arm * this.N + k;
  }

  /** Mark node `k`'s whole branch (it and everything growing from it) dead or alive. */
  private setBranch(base: number, k: number, live: boolean, revive: number): void {
    const N = this.N;
    // Walk the subtree level by level: at each depth its nodes are a contiguous run.
    for (let lo = k, hi = k; lo < N; lo = lo * 2, hi = hi * 2 + 1) {
      for (let j = lo; j <= Math.min(hi, N - 1); j++) {
        const i = base + j;
        if (live) {
          if (!this.alive[i] && this.grown[i] === 0) this.rejitter(i);
          this.alive[i] = 1;
        } else {
          this.alive[i] = 0;
          this.reviveAt[i] = this.time + revive * (0.7 + Math.random() * 0.6);
        }
      }
    }
  }

  /** Clear node `k`'s branch back to nothing so it grows again in a new shape. */
  private regrow(base: number, k: number, hue = -1, dye = 0): void {
    const N = this.N;
    for (let lo = k, hi = k; lo < N; lo = lo * 2, hi = hi * 2 + 1) {
      for (let j = lo; j <= Math.min(hi, N - 1); j++) {
        const i = base + j;
        if (j !== k) this.grown[i] = 0;
        this.alive[i] = 1;
        this.rejitter(i);
        if (hue >= 0) { this.dyeHue[i] = hue; this.dye[i] = Math.max(this.dye[i], dye); }
      }
    }
  }

  /** A random node at least `minDepth` levels out, as a heap index. */
  private randomNode(minDepth: number): number {
    const d = minDepth + Math.floor(Math.random() * Math.max(1, this.depth - minDepth));
    return (1 << d) + Math.floor(Math.random() * (1 << d));
  }

  private bases(): number[] {
    const out: number[] = [];
    for (let a = 0; a < (this.mirror ? 1 : this.arms); a++) out.push(a * this.N);
    return out;
  }

  step(dt: number, p: ParamValues, m: MusicFrame): void {
    this.params = p;
    this.stepped = true;
    this.time += dt;
    this.rotation += ((p.rotation as number) * Math.PI / 180) * dt;
    const D = this.depth, N = this.N;
    const style = p.style as string;
    const cycle = Math.max(1, p.cycle as number);
    const change = p.change as number;

    // How far out the tree may grow, by style.
    if (style === "breathe") {
      const t = 0.5 - 0.5 * Math.cos((m.beats / cycle) * Math.PI * 2);
      this.frontier = 1.5 + (D - 1.5) * (0.25 + 0.75 * t) + Math.min(1, m.level) * 0.8;
    } else if (style === "pulse") {
      // Each kick throws the tree out to full size (without drums, each bar does); it sinks back over a cycle.
      const beatsPerSecond = Math.max(0.5, (m.beats - this.beats) / dt);
      this.frontier = Math.max(1.5, this.frontier - dt * beatsPerSecond * (D / cycle));
      if (Math.floor(m.beats / 4) !== Math.floor(this.beats / 4) && m.beats - this.lastKick > 4) this.frontier = D + 0.5;
    } else if (style === "seasons") {
      // Grow out and hold for a cycle, then fall back to the trunk; each new year grows a new shape.
      const year = Math.floor(m.beats / (cycle * 2));
      const phase = (m.beats / (cycle * 2)) - year;
      this.frontier = phase < 0.62 ? D + 0.5 : 0.6;
      if (year !== this.seasonGen) {
        if (this.seasonGen >= 0) for (let i = 0; i < this.grown.length; i++) if (this.grown[i] === 0) this.rejitter(i);
        this.seasonGen = year;
      }
    } else {
      this.frontier = D + 0.5;
    }

    this.beats = m.beats;

    // Branches die back now and then and come back later in a new shape; Wander does it far more.
    const rate = change * (style === "wander" ? 4 : 1);
    this.changeClock += dt * rate;
    while (this.changeClock >= 1) {
      this.changeClock -= 1;
      for (const base of this.bases()) {
        const k = this.randomNode(Math.min(2, D - 1));
        if (this.alive[base + k]) this.setBranch(base, k, false, 1.2 + 2.5 / Math.max(0.2, rate));
      }
    }

    const speed = (p.speed as number) * (1 + this.boost * (p.kickGrow as number)) * (1 + Math.min(1, m.level) * 0.3);
    const grow = speed * dt;
    this.boost *= Math.exp(-dt * 3);
    this.flash *= Math.exp(-dt * 5);
    this.bend += (this.bendTarget - this.bend) * Math.min(1, dt * 4);
    this.bendTarget *= Math.exp(-dt * 0.7);
    const fade = Math.exp(-dt * 0.35), sparkFade = Math.exp(-dt * 6);
    const { grown, alive, reviveAt } = this;
    for (const base of this.bases()) {
      // Grow from the trunk out: a branch only grows once the one it leaves is complete.
      for (let k = 1; k < N; k++) {
        const i = base + k;
        if (!alive[i] && this.time >= reviveAt[i]) { alive[i] = 1; if (grown[i] === 0) this.rejitter(i); }
        this.dye[i] *= fade;
        this.spark[i] *= sparkFade;
        const d = 31 - Math.clz32(k);
        const target = alive[i] ? Math.min(1, Math.max(0, this.frontier - d)) : 0;
        if (grown[i] < target && (k === 1 || grown[base + (k >> 1)] >= 1)) {
          // Each level grows in about the same time, so the tree spreads outward at a steady pace.
          grown[i] = Math.min(target, grown[i] + grow);
          if (grown[i] < 1) this.spark[i] = Math.max(this.spark[i], 0.35);
        }
      }
      // Shrink from the tips in: a branch only shrinks once everything growing from it is gone.
      for (let k = N - 1; k >= 1; k--) {
        const i = base + k;
        const d = 31 - Math.clz32(k);
        const target = alive[i] ? Math.min(1, Math.max(0, this.frontier - d)) : 0;
        if (grown[i] > target) {
          const c = 2 * k;
          if (c < N && (grown[base + c] > 0 || grown[base + c + 1] > 0)) continue;
          grown[i] = Math.max(target, grown[i] - grow * 1.3);
        }
      }
    }

    if (this.pointer) {
      this.pointer.clock -= dt;
      if (this.pointer.clock <= 0) {
        this.pointer.clock = 0.12;
        this.touch(this.pointer.x, this.pointer.y, this.pointer.cut);
      }
    }
  }

  /** Lay the tree out for this frame: every arm, every branch, ends in `ex`/`ey`. */
  private layout(p: ParamValues, m: MusicFrame): void {
    const { width: w, height: h } = this.view;
    const cx = w / 2, cy = h / 2;
    const S = this.arms, N = this.N, D = this.depth;
    const taper = p.taper as number;
    const R = Math.min(w, h) * 0.5 * (p.size as number);
    // The trunk length that makes the whole tree reach about R.
    const L0 = (R * (1 - taper)) / (1 - taper ** (D + 1)) * 1.05;
    const spread = ((p.spread as number) * Math.PI) / 180 * (1 + this.bend);
    const asym = p.asymmetry as number;
    const sway = p.sway as number;
    const warp = p.warp as number;
    const spec = m.spectrum;
    const t = this.time;
    const { grown, ex, ey, ang } = this;
    for (let a = 0; a < S; a++) {
      const base = a * N, sb = this.mirror ? 0 : base;
      for (let k = 1; k < N; k++) {
        const i = sb + k, o = base + k;
        const d = 31 - Math.clz32(k);
        let px: number, py: number, pa: number;
        if (k === 1) {
          pa = this.rotation + (a * Math.PI * 2) / S;
          px = cx + Math.cos(pa) * L0 * 0.25;
          py = cy + Math.sin(pa) * L0 * 0.25;
        } else {
          const q = base + (k >> 1);
          px = ex[q]; py = ey[q];
          pa = ang[q] + ((k & 1) ? -1 : 1) * spread * 0.5;
        }
        const angle = pa + this.jitA[i] * asym * 0.55 + sway * 0.25 * Math.sin(t * 0.8 + d * 1.3 + (this.mirror ? 0 : a));
        const band = spec[Math.min(spec.length - 1, Math.floor((d / D) * spec.length))];
        const len = L0 * taper ** d * (1 + this.jitL[i] * asym * 0.4) * (1 + warp * band * 0.8) * grown[i];
        ang[o] = angle;
        this.sx[o] = px;
        this.sy[o] = py;
        ex[o] = px + Math.cos(angle) * len;
        ey[o] = py + Math.sin(angle) * len;
      }
    }
  }

  /** The branch end nearest (x, y) within `r`, as [arm, node], or null. */
  private nearest(x: number, y: number, r: number): [number, number] | null {
    let best: [number, number] | null = null, bestD = r * r;
    for (let a = 0; a < this.arms; a++) {
      for (let k = 2; k < this.N; k++) {
        if (this.grown[this.slot(a, k)] <= 0) continue;
        const d = (this.ex[a * this.N + k] - x) ** 2 + (this.ey[a * this.N + k] - y) ** 2;
        if (d < bestD) { bestD = d; best = [a, k]; }
      }
    }
    return best;
  }

  /** Clicking regrows the branch under the pointer in a new shape; right-click prunes it for a while. */
  private touch(x: number, y: number, cut: boolean): void {
    const hit = this.nearest(x, y, 60);
    if (!hit) return;
    const [a, k] = hit;
    const base = this.mirror ? 0 : a * this.N;
    // Act a level or two in, so a click moves a visible chunk of the tree.
    const node = k >= 8 ? k >> 1 : k;
    if (cut) this.setBranch(base, node, false, 3);
    else this.regrow(base, node, this.seedHue(), 0.8);
  }

  private seedHue(): number {
    return schemeHue(this.params.colours as string, Math.random(), 210, this.beats);
  }

  onNote(ev: NoteEvent, p: ParamValues): void {
    const D = this.depth;
    if (ev.role === "kick") {
      // A surge of growth, and in Pulse the tree throws itself out to full size.
      this.boost = Math.min(3, this.boost + ev.velocity * 1.5);
      this.lastKick = this.beats;
      this.flash = Math.min(1, this.flash + ev.velocity * 0.7);
      if (p.style === "pulse") this.frontier = D + 0.5;
    } else if (ev.role === "snare") {
      // Prunes a few outer branches; they grow back later in a new shape.
      const n = Math.round((p.snarePrune as number) * ev.velocity * 4);
      for (const base of this.bases()) {
        for (let j = 0; j < n; j++) {
          const k = this.randomNode(Math.max(2, D - 3));
          this.setBranch(base, k, false, 0.8);
        }
      }
    } else if (ev.role === "hat") {
      for (let j = 0; j < 6; j++) {
        const i = (this.mirror ? 0 : Math.floor(Math.random() * this.arms) * this.N) + this.randomNode(D - 1);
        if (this.grown[i] > 0) this.spark[i] = Math.max(this.spark[i], ev.velocity);
      }
    } else if (ev.role === "tone") {
      // The branch the note points at (low notes one side, high the other) regrows in the note's colour.
      if (ev.velocity <= 0.02) return;
      const d = Math.min(3, D - 1);
      const k = (1 << d) + Math.min((1 << d) - 1, Math.floor(ev.x * (1 << d)));
      const hue = p.colours === "notes" ? noteHue(ev.note) : this.seedHue();
      const arm = this.mirror ? 0 : Math.floor(Math.random() * this.arms);
      if (p.noteRegrow as boolean) this.regrow(arm * (this.mirror ? 0 : this.N), k, hue, Math.min(1, ev.velocity));
      else this.dyeBranch(arm * (this.mirror ? 0 : this.N), k, hue, Math.min(1, ev.velocity));
    } else if (ev.role === "bassline") {
      // The bass line opens and closes the forks: low notes close them, high notes open them.
      this.bendTarget = (p.bassBend as number) * (ev.x - 0.5) * 2 * ev.velocity;
    } else if (ev.role === "chord") {
      // Each level of the tree takes one of the chord's notes.
      const notes = ev.notes ?? [ev.note];
      for (let i = 0; i < this.grown.length; i++) {
        const k = i % this.N;
        if (k === 0) continue;
        const d = 31 - Math.clz32(k);
        this.dyeHue[i] = this.dye[i] > 0.1 ? hueToward(this.dyeHue[i], noteHue(notes[d % notes.length]), 0.5) : noteHue(notes[d % notes.length]);
        this.dye[i] = Math.max(this.dye[i], 0.55 * ev.velocity);
      }
    }
  }

  private dyeBranch(base: number, k: number, hue: number, amount: number): void {
    for (let lo = k, hi = k; lo < this.N; lo = lo * 2, hi = hi * 2 + 1) {
      for (let j = lo; j <= Math.min(hi, this.N - 1); j++) {
        this.dyeHue[base + j] = hue;
        this.dye[base + j] = Math.max(this.dye[base + j], amount);
        this.spark[base + j] = Math.max(this.spark[base + j], amount * 0.6);
      }
    }
  }

  onPointer(input: PointerInput): void {
    if (input.type === "up") { this.pointer = null; return; }
    if (input.type === "down") this.pointer = { x: input.x, y: input.y, cut: input.button === 2 || input.shift, clock: 0 };
    else if (this.pointer) { this.pointer.x = input.x; this.pointer.y = input.y; }
  }

  /** The colour of a branch: its scheme colour by depth, pulled toward any note colour soaked into it. */
  private hueOf(i: number, d: number, scheme: string, m: MusicFrame): number {
    const h = schemeHue(scheme, d / this.depth, m.hue, m.beats);
    return this.dye[i] > 0.03 ? hueToward(h, this.dyeHue[i], Math.min(1, this.dye[i] * 1.4)) : h;
  }

  private widthAt(d: number, p: ParamValues, m: MusicFrame): number {
    return (p.lineWidth as number) * (1 - (d / (this.depth + 1)) * 0.65) * (1 + Math.min(1.5, m.bass) * 0.4 + this.flash * 0.3);
  }

  private brightness(p: ParamValues, m: MusicFrame): number {
    return (p.glow as number) * (0.75 + Math.min(1, m.level) * 0.35 + this.flash * 0.35);
  }

  private readonly cpuPaths: (Path2D | null)[] = [];

  render(g: CanvasRenderingContext2D, view: Viewport, p: ParamValues, m: MusicFrame): void {
    applyFeedback(this.fb, g, view, p, this.stepped);
    this.stepped = false;
    this.layout(p, m);
    const S = this.arms, N = this.N, D = this.depth;
    const scheme = p.colours as string;
    const bright = this.brightness(p, m);
    // One path per depth and hue: a few dozen strokes a frame.
    const paths = this.cpuPaths;
    paths.length = (D + 1) * HUES;
    const used: number[] = [];
    const node = (p.nodeSize as number) * (1 + m.pulse * 0.4);
    const dots: number[] = [];
    for (let a = 0; a < S; a++) {
      for (let k = 1; k < N; k++) {
        const i = this.slot(a, k), o = a * N + k;
        if (this.grown[i] <= 0) continue;
        const d = 31 - Math.clz32(k);
        const hb = Math.floor(this.hueOf(i, d, scheme, m) / (360 / HUES)) % HUES;
        const bucket = d * HUES + hb;
        let path = paths[bucket];
        if (!path) { path = paths[bucket] = new Path2D(); used.push(bucket); }
        path.moveTo(this.sx[o], this.sy[o]);
        path.lineTo(this.ex[o], this.ey[o]);
        if (node > 0.05 && this.grown[i] >= 1) dots.push(o, hb);
      }
    }
    g.globalCompositeOperation = "lighter";
    g.lineCap = "round";
    for (const bucket of used) {
      const d = Math.floor(bucket / HUES), hb = bucket % HUES;
      g.lineWidth = this.widthAt(d, p, m);
      g.strokeStyle = `hsla(${(hb + 0.5) * (360 / HUES)} 85% 62% / ${Math.min(1, bright * (1 - d / (D + 2) * 0.4))})`;
      g.stroke(paths[bucket]!);
      paths[bucket] = null;
    }
    for (let j = 0; j < dots.length; j += 2) {
      const o = dots[j];
      g.fillStyle = `hsl(${(dots[j + 1] + 0.5) * (360 / HUES)} 80% 75%)`;
      g.beginPath();
      g.arc(this.ex[o], this.ey[o], node, 0, Math.PI * 2);
      g.fill();
    }
    if (p.tipGlow) {
      const dpr = window.devicePixelRatio || 1;
      const size = Math.max(1, p.lineWidth as number) * 10 * (1 + Math.min(1, m.treble) * 0.6);
      let drawn = 0;
      for (let a = 0; a < S && drawn < MAX_GLOWS; a++) {
        for (let k = 1; k < N && drawn < MAX_GLOWS; k++) {
          const i = this.slot(a, k);
          const sp = this.spark[i] * Math.min(1, this.grown[i] * 4);
          if (sp < 0.15) continue;
          const s = size * sp, o = a * N + k;
          g.drawImage(glowSprite(this.hueOf(i, 31 - Math.clz32(k), scheme, m), 90, s * dpr), this.ex[o] - s / 2, this.ey[o] - s / 2, s, s);
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
    const S = this.arms, N = this.N, D = this.depth;
    const scheme = p.colours as string;
    const bright = this.brightness(p, m);
    const node = (p.nodeSize as number) * (1 + m.pulse * 0.4);
    const size = Math.max(1, p.lineWidth as number) * 10 * (1 + Math.min(1, m.treble) * 0.6);
    gfx.blend("add");
    let drawn = 0;
    for (let a = 0; a < S; a++) {
      for (let k = 1; k < N; k++) {
        const i = this.slot(a, k), o = a * N + k;
        if (this.grown[i] <= 0) continue;
        const d = 31 - Math.clz32(k);
        const hue = this.hueOf(i, d, scheme, m);
        gfx.line(this.sx[o], this.sy[o], this.ex[o], this.ey[o], this.widthAt(d, p, m), hsla(hue, 0.85, 0.62, Math.min(1, bright * (1 - d / (D + 2) * 0.4))));
        if (node > 0.05 && this.grown[i] >= 1) gfx.disc(this.ex[o], this.ey[o], node, hsla(hue, 0.8, 0.75));
        if (p.tipGlow && drawn < MAX_GLOWS) {
          const sp = this.spark[i] * Math.min(1, this.grown[i] * 4);
          if (sp >= 0.15) { gfx.glow(this.ex[o], this.ey[o], size * sp, Math.round(hue / 10) * 10, 90); drawn++; }
        }
      }
    }
    gfx.blend("normal");
  }

  stats(): string {
    let shown = 0;
    for (let a = 0; a < this.arms; a++) for (let k = 1; k < this.N; k++) if (this.grown[this.slot(a, k)] > 0) shown++;
    return `${shown} of ${this.arms * (this.N - 1)} branches grown`;
  }
}

export const branches: ModelDefinition = {
  id: "branches",
  name: "Branches",
  category: "Surfaces",
  description: "A living fractal tree: every arm splits in two again and again, and each branch grows out from the one before and dies back tip first. Branches that die regrow at a new angle and length, so like Living ink the shape keeps changing while the symmetry holds. Kicks surge the growth, snares prune the outer branches, each melody note regrows a branch in its colour, the bass line opens and closes the forks and chords colour each level.",
  hint: "Click or drag over branches to regrow them in a new shape. Right-drag or Shift-drag to prune them for a while.",
  fixedDt: 1 / 60,
  paintsBackground: true,
  params: [
    { kind: "choice", key: "style", label: "Growth style", default: "breathe", segmented: true, options: STYLE_OPTIONS,
      description: "How the tree grows and shrinks. Breathe swells out and sinks back with the music's clock; Wander lets branches die and regrow at random; Pulse throws the tree out on every kick and lets it sink between; Seasons grows a full tree, holds it, lets it fall to the trunk, then grows a new one." },
    { kind: "number", key: "symmetry", label: "Arms", min: 1, max: 12, step: 1, default: 6, resetOnChange: true, random: [3, 10],
      description: "How many trees grow out from the centre, evenly spaced. Rebuilds the tree." },
    { kind: "number", key: "spread", label: "Fork angle", min: 5, max: 170, step: 1, default: 60, random: [20, 140],
      description: "How wide each fork opens, in degrees. Narrow grows tall and spiky; wide curls back into lace." },
    { kind: "number", key: "speed", label: "Growth speed", min: 0.2, max: 12, step: 0.1, default: 2.5, curve: curveFor(0.2, 12, 2.5), random: [1, 7], global: "energy",
      description: "How fast branches grow and die back, in branch lengths a second. Kicks surge it." },
    { kind: "number", key: "change", label: "Change", min: 0, max: 6, step: 0.05, default: 0.8, curve: curveFor(0, 6, 0.8), random: [0.2, 3],
      description: "How often a branch dies back and regrows in a new shape, times a second. Zero keeps the tree's shape fixed; Wander does it four times as often." },
    { kind: "number", key: "asymmetry", label: "Wildness", min: 0, max: 1, step: 0.01, default: 0.35, random: [0, 0.8],
      description: "How far each branch strays from a perfect fractal in angle and length. Zero is crisp and geometric; high grows like a real tree." },
    { kind: "number", key: "cycle", label: "Cycle", min: 1, max: 64, step: 1, default: 16, curve: curveFor(1, 64, 16), random: [4, 32],
      showWhen: (p) => p.style !== "wander",
      format: (v) => (v % 4 === 0 ? `${v / 4} bar${v === 4 ? "" : "s"}` : `${v} beats`),
      description: "How long one breath, pulse or season lasts, following the tempo." },
    { kind: "number", key: "size", label: "Size", min: 0.2, max: 1.8, step: 0.01, default: 0.85, random: [0.5, 1.4],
      description: "How far the full tree reaches, as a share of the screen." },
    { kind: "number", key: "levels", label: "Levels", min: 3, max: 10, step: 1, default: 8, resetOnChange: true, perf: true, advanced: true,
      description: "How many times the branches split. Each level doubles the branches, so 10 is heavy to draw. Rebuilds the tree." },
    { kind: "number", key: "taper", label: "Taper", min: 0.5, max: 0.9, step: 0.01, default: 0.72, advanced: true, random: [0.6, 0.85],
      description: "How much shorter each branch is than the one it grows from. High reaches far with long twigs; low stays compact." },
    { kind: "number", key: "rotation", label: "Rotation", min: -90, max: 90, step: 1, default: 6, snapZero: true, advanced: true, random: [-30, 30],
      description: "How fast the whole tree turns, in degrees a second." },
    { kind: "number", key: "sway", label: "Sway", min: 0, max: 2, step: 0.01, default: 0.5, advanced: true, random: [0, 1.2],
      description: "How much the branches sway as if in a breeze." },
    { kind: "number", key: "lineWidth", label: "Line width", min: 0.3, max: 6, step: 0.1, default: 2.2, advanced: true, random: [0.6, 3.5],
      description: "How thick the trunks are; branches thin toward the tips. The bass thickens them." },
    { kind: "number", key: "nodeSize", label: "Joint dots", min: 0, max: 6, step: 0.1, default: 1.4, advanced: true, random: [0, 3],
      description: "Size of the dot at each fork. Zero leaves only the lines." },
    { kind: "number", key: "glow", label: "Line glow", min: 0.1, max: 1.5, step: 0.01, default: 0.9, advanced: true, random: [0.4, 1.2],
      description: "How bright the lines are. Where they cross they add up toward white." },
    { kind: "boolean", key: "mirror", label: "Mirror arms", default: true, resetOnChange: true, advanced: true,
      description: "Every arm grows and dies back the same, like a snowflake. Off lets each arm live its own life." },
    { kind: "boolean", key: "noteRegrow", label: "Notes regrow branches", default: true, advanced: true,
      description: "Each melody note makes its branch regrow in a new shape. Off only colours it." },
    { kind: "boolean", key: "tipGlow", label: "Glowing tips", default: true, advanced: true,
      description: "A small light on each growing tip; it sparks on the hi-hats." },
    // Set by the matrix rows Growth surge, Prune, Open the forks and Spectrum reach.
    { kind: "number", key: "kickGrow", label: "Kick surge", min: 0, max: 4, step: 0.05, default: 1.5, hidden: true },
    { kind: "number", key: "snarePrune", label: "Snare prune", min: 0, max: 4, step: 0.05, default: 1, hidden: true },
    { kind: "number", key: "bassBend", label: "Bass bend", min: 0, max: 1, step: 0.01, default: 0.25, hidden: true },
    { kind: "number", key: "warp", label: "Spectrum reach", min: 0, max: 2, step: 0.01, default: 0.5, hidden: true },
    colourParam(),
    ...feedbackParams(0.4),
  ],
  macros: [
    { key: "bloom", label: "Bloom", description: "Opens the forks wide and grows the tree big and wild.",
      targets: [{ param: "spread", amount: 0.35 }, { param: "size", amount: 0.15 }, { param: "asymmetry", amount: 0.35 }, { param: "glow", amount: 0.15 }] },
    { key: "frost", label: "Frost", description: "A crisp, still snowflake: perfect symmetry, narrow forks, no sway.",
      targets: [{ param: "asymmetry", amount: -0.5 }, { param: "sway", amount: -0.4 }, { param: "spread", amount: -0.15 }, { param: "rotation", amount: -0.05 }, { param: "colours", set: "ice", at: 0.5 }] },
    { key: "storm", label: "Storm", description: "Branches die and regrow fast, sway hard and surge on every kick.",
      targets: [{ param: "change", amount: 0.35 }, { param: "speed", amount: 0.3 }, { param: "sway", amount: 0.4 }, { param: "kickGrow", amount: 0.3 }] },
    { key: "hyper", label: "Hyperspace", description: "Long glowing trails that fly outward into a turning tunnel.",
      targets: [{ param: "afterglow", amount: 0.45 }, { param: "zoom", amount: 0.45 }, { param: "spin", amount: 0.2 }, { param: "glow", amount: -0.15 }] },
  ],
  modulations: [
    { source: "lfoBar", target: "spread", amount: 0.08 },
    { source: "kick", target: "lineWidth", amount: 0.15 },
    { source: "treble", target: "nodeSize", amount: 0.15 },
  ],
  reactions: [
    { source: "kick", label: "Growth surge", text: "Growth surges (in Pulse the tree throws itself out to full size) and the lines flash. The strength is how hard", param: "kickGrow" },
    { source: "snare", label: "Prune", text: "Prunes a few outer branches; they grow back later in a new shape. The strength is how many", param: "snarePrune" },
    { source: "hat", label: "Tip sparks", text: "A few branch tips spark" },
    { source: "tone", label: "Regrow a branch", text: "The branch the note points at (low notes one side, high notes the other) regrows in the note's colour" },
    { source: "bassline", label: "Open the forks", text: "High bass notes open the forks wider and low ones close them. The strength is how far", param: "bassBend" },
    { source: "chord", label: "Chord colours", text: "Each level of the tree takes one of the chord's notes" },
    { source: "bass", label: "Thicker lines", text: "The bass thickens the branches" },
    { source: "level", label: "Grow and glow", text: "Louder music grows the tree faster and further and makes it brighter" },
    { source: "treble", label: "Bigger tip glow", text: "The glows at the tips grow bigger" },
    { source: "spectrum", label: "Spectrum reach", text: "Each level of branches stretches with its part of the spectrum, trunks with the bass and twigs with the treble. The strength is how much", param: "warp" },
    { source: "beat", label: "Beat pulse", text: "The joint dots pulse on the beat" },
  ],
  create: () => new BranchesSim(),
};
