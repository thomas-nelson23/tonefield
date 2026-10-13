import type { ModelDefinition, MusicFrame, NoteEvent, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { noteHash, noteHue } from "./lib/music";
import { Feedback, applyFeedback, colourParam, feedbackParams, glowSprite, schemeHue } from "./lib/visual";
import { gravityAt, gravityModeParam, isUniform } from "./lib/gravity";

/** Patterns where nodes roam freely and link up by distance; the rest are laid out in shapes. */
const FREE = new Set(["web", "stars"]);
const MAX_EDGES = 20000;
const MAX_PACKETS = 160;
/** Most glow sprites a frame draws; each is a separate draw call, which software canvas pays for. */
const MAX_GLOWS = 60;
/** Most lines one node can grow in the Web pattern, so dense clumps don't stall the frame. */
const MAX_LINKS = 6;
/** Most nearest neighbours a star joins in Constellations. */
const NEAREST_MAX = 5;
const HUES = 24;
const SHADES = 4;
/**
 * Segments per stroke. Software canvas (WebKitGTK) gets superlinearly slow
 * stroking one path with thousands of subpaths, so lines go out in small batches.
 */
const BATCH = 300;
/** Seconds for a signal to cross one line. */
const HOP = 0.22;

/** 0..1 that bounces back and forth instead of wrapping, so a drifting shape never jumps. */
function pingPong(x: number): number {
  const m = ((x % 2) + 2) % 2;
  return m <= 1 ? m : 2 - m;
}

/**
 * Plexus: glowing nodes joined by lines. A Pattern dropdown picks how they
 * connect: a drifting web that links whatever is close, star-chart
 * constellations, counter-rotating rings of star polygons, times-table string
 * art round a circle, fractal branches, or a rolling triangle mesh. Switching
 * pattern springs every node across to its new place. Each melody note sends
 * a signal racing along the lines from node to node, kicks burst the shape
 * outward, snares send a shockwave through it, the bass line bends the shape
 * and the spectrum makes it breathe.
 */
class PlexusSim implements SimulationModel {
  private view: Viewport = { width: 1, height: 1 };
  private n = 0;
  private x = new Float32Array(0);
  private y = new Float32Array(0);
  private vx = new Float32Array(0);
  private vy = new Float32Array(0);
  private tx = new Float32Array(0);
  private ty = new Float32Array(0);
  /** Colour as a unit vector round the hue wheel, so neighbours can average it. */
  private hx = new Float32Array(0);
  private hy = new Float32Array(0);
  private spark = new Float32Array(0);
  /** Fades nodes in and out as a pattern starts or stops using them. */
  private vis = new Float32Array(0);
  private used = new Uint8Array(0);
  /** Free-drift heading and a per-node speed factor. */
  private head = new Float32Array(0);
  private pace = new Float32Array(0);
  /** Scratch: branch angles while laying out a tree, and colour sums while spreading it. */
  private ang = new Float32Array(0);
  private sumX = new Float32Array(0);
  private sumY = new Float32Array(0);
  private hue = new Float32Array(0);

  /** Lines: from node a to node b, or to the point `et` of the way from b to c when c >= 0. */
  private ea = new Int32Array(MAX_EDGES);
  private eb = new Int32Array(MAX_EDGES);
  private ec = new Int32Array(MAX_EDGES);
  private et = new Float32Array(MAX_EDGES);
  private ew = new Float32Array(MAX_EDGES);
  private edges = 0;
  /** Who each node is joined to, rebuilt from the lines every step. */
  private adjStart = new Int32Array(0);
  private adj = new Int32Array(MAX_EDGES * 2);
  /** Spatial grid for linking free nodes. */
  private cellHead = new Int32Array(0);
  private cellNext = new Int32Array(0);
  private links = new Uint8Array(0);
  /** Constellations: each node's chosen nearest neighbours, NEAREST_MAX per node, -1 when unused. */
  private chosen = new Int32Array(0);

  /** Signals travelling along lines. */
  private pkFrom = new Int32Array(MAX_PACKETS);
  private pkTo = new Int32Array(MAX_PACKETS);
  private pkT = new Float32Array(MAX_PACKETS);
  private pkGen = new Int8Array(MAX_PACKETS);
  private pkHue = new Float32Array(MAX_PACKETS);
  private packets = 0;
  /** Scratch for signals that reached their node this step. */
  private arrFrom = new Int32Array(MAX_PACKETS);
  private arrTo = new Int32Array(MAX_PACKETS);
  private arrGen = new Int8Array(MAX_PACKETS);
  private arrHue = new Float32Array(MAX_PACKETS);

  private shocks: { x: number; y: number; r: number; life: number }[] = [];
  private pointer: { x: number; y: number; repel: boolean } | null = null;
  private fb = new Feedback();
  private stepped = false;
  private time = 0;
  private angle = 0;
  private drift = 0;
  private morph = 0;
  private morphTarget = 0;
  private shape = 0;
  /** How far free nodes currently link, so signals between nodes that drifted apart can be dropped. */
  private reachNow = 100;
  private flash = 0;
  private pattern = "web";
  private generations = 4;
  private kickPush = 260;

  reset(view: Viewport, p: ParamValues): void {
    this.view = view;
    const n = (this.n = p.count as number);
    const f = () => new Float32Array(n);
    this.x = f(); this.y = f(); this.vx = f(); this.vy = f(); this.tx = f(); this.ty = f();
    this.hx = f(); this.hy = f(); this.spark = f(); this.vis = f(); this.head = f(); this.pace = f();
    this.ang = f(); this.sumX = f(); this.sumY = f(); this.hue = f();
    this.used = new Uint8Array(n);
    this.links = new Uint8Array(n);
    this.chosen = new Int32Array(n * NEAREST_MAX);
    this.cellNext = new Int32Array(n);
    this.adjStart = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) {
      this.x[i] = Math.random() * view.width;
      this.y[i] = Math.random() * view.height;
      this.head[i] = Math.random() * Math.PI * 2;
      this.pace[i] = 0.5 + Math.random();
      const h = ((200 + Math.random() * 60) * Math.PI) / 180;
      this.hx[i] = Math.cos(h); this.hy[i] = Math.sin(h);
    }
    this.edges = this.packets = 0;
    this.shocks = [];
  }

  resize(view: Viewport): void {
    this.view = view;
  }

  // ---- Lines ---------------------------------------------------------------

  private edge(a: number, b: number, w = 1, c = -1, t = 0): void {
    if (this.edges >= MAX_EDGES) return;
    const k = this.edges++;
    this.ea[k] = a; this.eb[k] = b; this.ec[k] = c; this.et[k] = t; this.ew[k] = w;
  }

  /** Web and Constellations: link nodes that are near each other, using a grid so it stays fast. */
  private linkFree(p: ParamValues, m: MusicFrame, stars: boolean): void {
    const { width, height } = this.view;
    const n = this.n, x = this.x, y = this.y;
    let reach = (p.reach as number) * (1 + Math.min(1.5, m.bass) * 0.4);
    if (!stars) reach *= 0.4 + this.shape * 1.2;
    else reach *= 1.4;
    this.reachNow = reach;
    const cell = Math.max(reach, Math.sqrt((width * height) / 40000), 8);
    const cols = Math.ceil(width / cell) + 1, rows = Math.ceil(height / cell) + 1;
    if (this.cellHead.length < cols * rows) this.cellHead = new Int32Array(cols * rows);
    const headCell = this.cellHead, next = this.cellNext;
    headCell.fill(-1, 0, cols * rows);
    for (let i = 0; i < n; i++) {
      this.used[i] = 1;
      const cx = Math.min(cols - 1, Math.max(0, Math.floor(x[i] / cell)));
      const cy = Math.min(rows - 1, Math.max(0, Math.floor(y[i] / cell)));
      const k = cy * cols + cx;
      next[i] = headCell[k];
      headCell[k] = i;
    }
    const r2 = reach * reach;
    if (!stars) {
      const links = this.links;
      links.fill(0);
      for (let i = 0; i < n; i++) {
        const gx = Math.min(cols - 1, Math.max(0, Math.floor(x[i] / cell)));
        const gy = Math.min(rows - 1, Math.max(0, Math.floor(y[i] / cell)));
        for (let oy = -1; oy <= 1; oy++) {
          const cy = gy + oy;
          if (cy < 0 || cy >= rows) continue;
          for (let ox = -1; ox <= 1; ox++) {
            const cx = gx + ox;
            if (cx < 0 || cx >= cols) continue;
            for (let j = headCell[cy * cols + cx]; j !== -1; j = next[j]) {
              if (j <= i || links[i] >= MAX_LINKS) continue;
              const dx = x[j] - x[i], dy = y[j] - y[i];
              const d2 = dx * dx + dy * dy;
              if (d2 > r2 || links[j] >= MAX_LINKS) continue;
              links[i]++; links[j]++;
              this.edge(i, j, 1 - Math.sqrt(d2) / reach);
            }
          }
        }
      }
      return;
    }
    // Constellations: each star joins its few nearest neighbours.
    const k = 1 + Math.round(this.shape * (NEAREST_MAX - 1));
    const bestJ = [0, 0, 0, 0, 0], bestD = [0, 0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      let found = 0;
      const gx = Math.min(cols - 1, Math.max(0, Math.floor(x[i] / cell)));
      const gy = Math.min(rows - 1, Math.max(0, Math.floor(y[i] / cell)));
      for (let oy = -1; oy <= 1; oy++) {
        const cy = gy + oy;
        if (cy < 0 || cy >= rows) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const cx = gx + ox;
          if (cx < 0 || cx >= cols) continue;
          for (let j = headCell[cy * cols + cx]; j !== -1; j = next[j]) {
            if (j === i) continue;
            const dx = x[j] - x[i], dy = y[j] - y[i];
            const d2 = dx * dx + dy * dy;
            if (d2 > r2 || (found === k && d2 >= bestD[k - 1])) continue;
            // Insertion into the short sorted list of nearest.
            let s = found < k ? found++ : k - 1;
            while (s > 0 && bestD[s - 1] > d2) { bestD[s] = bestD[s - 1]; bestJ[s] = bestJ[s - 1]; s--; }
            bestD[s] = d2; bestJ[s] = j;
          }
        }
      }
      // A pair that picked each other is drawn once.
      const chosen = this.chosen;
      for (let s = 0; s < NEAREST_MAX; s++) chosen[i * NEAREST_MAX + s] = s < found ? bestJ[s] : -1;
      for (let s = 0; s < found; s++) {
        const j = bestJ[s];
        if (j < i) {
          let mutual = false;
          for (let t = 0; t < NEAREST_MAX; t++) if (chosen[j * NEAREST_MAX + t] === i) mutual = true;
          if (mutual) continue;
        }
        this.edge(i, j, Math.max(0.3, 1 - Math.sqrt(bestD[s]) / reach));
      }
    }
  }

  /** How far the spectrum pushes a shape out at angle `theta`, mirrored so both halves match. */
  private bulge(theta: number, m: MusicFrame, warp: number): number {
    if (warp <= 0) return 1;
    const u = Math.abs((((theta / Math.PI) % 2) + 2) % 2 - 1);
    const spec = m.spectrum;
    const bin = Math.min(spec.length - 1, Math.floor(u * spec.length * 0.7));
    return 1 + warp * spec[bin] * 0.6;
  }

  /** The shaped patterns: set each node's target spot and the lines between them. */
  private layout(pat: string, p: ParamValues, m: MusicFrame): void {
    const { width, height } = this.view;
    const cx = width / 2, cy = height / 2;
    const R = Math.min(width, height) * 0.5 * (p.scale as number);
    const warp = p.warp as number;
    const n = this.n, s = this.shape, tx = this.tx, ty = this.ty;
    const S = Math.round(p.symmetry as number);
    this.used.fill(0);
    if (pat === "rings") {
      let rings = Math.round(p.rings as number);
      while (rings > 1 && (S * rings * (rings + 1)) / 2 > n) rings--;
      let start = 0, prevStart = 0, prevN = 0, prevOff = 0;
      for (let r = 0; r < rings; r++) {
        const count = S * (r + 1);
        const off = this.angle * (r % 2 ? -1 : 1) * (1 + r * 0.25);
        const rad = (R * (r + 1)) / rings;
        const half = Math.floor(count / 2);
        const skip = count <= 4 ? 1 : 1 + Math.round(s * (half - 1));
        for (let j = 0; j < count; j++) {
          const i = start + j;
          const th = off + (j * Math.PI * 2) / count;
          const rr = rad * this.bulge(th, m, warp);
          tx[i] = cx + Math.cos(th) * rr;
          ty[i] = cy + Math.sin(th) * rr;
          this.used[i] = 1;
          this.edge(i, start + ((j + skip) % count));
          if (r > 0) {
            // A spoke to the nearest node on the ring inside; the rings turn opposite ways, so the spokes weave.
            const k = Math.round((th - prevOff) / ((Math.PI * 2) / prevN));
            this.edge(i, prevStart + (((k % prevN) + prevN) % prevN), 0.45);
          }
        }
        prevStart = start; prevN = count; prevOff = off;
        start += count;
      }
    } else if (pat === "string") {
      // Times-table string art: node i joins the point i × multiplier round the circle.
      const mult = 2 + s * 46;
      for (let i = 0; i < n; i++) {
        const th = this.angle + (i * Math.PI * 2) / n - Math.PI / 2;
        const rr = R * this.bulge(th, m, warp);
        tx[i] = cx + Math.cos(th) * rr;
        ty[i] = cy + Math.sin(th) * rr;
        this.used[i] = 1;
      }
      for (let i = 0; i < n; i++) {
        const j = (i * mult) % n;
        const b = Math.floor(j);
        this.edge(i, b, 1, (b + 1) % n, j - b);
      }
    } else if (pat === "branches") {
      // A fractal tree per arm: every node splits in two, each branch shorter than the last.
      const per = Math.floor(n / S);
      const L0 = R / 3.1;
      const spread = ((15 + s * 150) * Math.PI) / 180;
      const spec = m.spectrum;
      for (let l = 0; l < per; l++) {
        for (let arm = 0; arm < S; arm++) {
          const i = l * S + arm;
          this.used[i] = 1;
          if (l === 0) {
            const a = this.angle + (arm * Math.PI * 2) / S;
            this.ang[i] = a;
            tx[i] = cx + Math.cos(a) * L0 * 0.5;
            ty[i] = cy + Math.sin(a) * L0 * 0.5;
            this.edge(i, ((arm + 1) % S), 0.6);
            continue;
          }
          const pi = ((l - 1) >> 1) * S + arm;
          const depth = Math.floor(Math.log2(l + 1));
          const side = l & 1 ? -1 : 1;
          const a = this.ang[pi] + side * spread * 0.5 + 0.18 * Math.sin(this.time * 0.8 + depth * 1.3 + arm);
          const len = L0 * 0.72 ** depth * (1 + warp * spec[Math.min(spec.length - 1, depth * 5)] * 0.8);
          this.ang[i] = a;
          tx[i] = tx[pi] + Math.cos(a) * len;
          ty[i] = ty[pi] + Math.sin(a) * len;
          this.edge(pi, i, 1 - depth * 0.08);
        }
      }
    } else {
      // Mesh: a triangle lattice over the whole screen that rolls and rises with the spectrum.
      const cols = Math.max(3, Math.round(Math.sqrt((n * width) / height)));
      const rows = Math.max(3, Math.floor(n / cols));
      const sx = (width * 1.1) / (cols - 1), sy = (height * 1.1) / (rows - 1);
      const amp = s * sy * 1.2;
      const spec = m.spectrum;
      const t = this.time;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          if (i >= n) break;
          const bx = -width * 0.05 + c * sx + (r & 1 ? sx / 2 : 0);
          const by = -height * 0.05 + r * sy;
          const bin = Math.min(spec.length - 1, Math.floor(Math.abs(c / (cols - 1) - 0.5) * 2 * spec.length * 0.7));
          tx[i] = bx + amp * 0.5 * Math.cos(by * 0.011 + t * 1.1);
          ty[i] = by + amp * Math.sin(bx * 0.012 + t * 1.6) * Math.cos(by * 0.01 - t * 0.9) - warp * spec[bin] * sy * 2;
          this.used[i] = 1;
          if (c + 1 < cols) this.edge(i, i + 1);
          if (r + 1 < rows) {
            const left = r & 1 ? c : c - 1;
            if (left >= 0) this.edge(i, i + cols - c + left, 0.8);
            if (left + 1 < cols) this.edge(i, i + cols - c + left + 1, 0.8);
          }
        }
      }
    }
  }

  private buildAdjacency(): void {
    const n = this.n, start = this.adjStart, adj = this.adj;
    start.fill(0);
    for (let e = 0; e < this.edges; e++) { start[this.ea[e] + 1]++; start[this.eb[e] + 1]++; }
    for (let i = 0; i < n; i++) start[i + 1] += start[i];
    const fill = this.sumX; // reused as a write cursor
    for (let i = 0; i < n; i++) fill[i] = start[i];
    for (let e = 0; e < this.edges; e++) {
      const a = this.ea[e], b = this.eb[e];
      adj[fill[a]++] = b;
      adj[fill[b]++] = a;
    }
  }

  // ---- Signals -------------------------------------------------------------

  /** Send signals out from `node` along up to `max` of its lines, not back to `from`. */
  private launch(node: number, gen: number, hue: number, max: number, from = -1): void {
    const s = this.adjStart[node], e = this.adjStart[node + 1];
    const deg = e - s;
    if (deg === 0) return;
    const first = Math.floor(Math.random() * deg);
    let sent = 0;
    for (let k = 0; k < deg && sent < max && this.packets < MAX_PACKETS; k++) {
      const to = this.adj[s + ((first + k) % deg)];
      if (to === from || to === node) continue;
      const q = this.packets++;
      this.pkFrom[q] = node; this.pkTo[q] = to; this.pkT[q] = 0; this.pkGen[q] = gen; this.pkHue[q] = hue;
      sent++;
    }
  }

  private paint(i: number, hue: number, amount: number): void {
    const h = (hue * Math.PI) / 180;
    this.hx[i] += (Math.cos(h) - this.hx[i]) * amount;
    this.hy[i] += (Math.sin(h) - this.hy[i]) * amount;
  }

  // ---- Simulation ----------------------------------------------------------

  private move(dt: number, p: ParamValues, m: MusicFrame, free: boolean): void {
    const { width, height } = this.view;
    const n = this.n, x = this.x, y = this.y, vx = this.vx, vy = this.vy;
    // Motion: shaped patterns spring each node to its spot, free ones drift and wrap round the edges.
    const omega = p.snap as number;
    const k = omega * omega, damp = 2 * omega * (1 - (p.bounce as number) * 0.9);
    const speed = (p.drift as number) * (1 + (p.warp as number) * Math.min(1.5, m.level) * 1.5);
    const gMode = p.gravityMode as string, gStrength = p.fieldGravity as number;
    const uniform = isUniform(gMode);
    const [ugx, ugy] = uniform ? gravityAt(gMode, gStrength, 0, 0, width, height, this.time) : [0, 0];
    const fade = Math.min(1, dt * 3);
    const pr = Math.min(width, height) * 0.25;
    const ease = Math.min(1, dt * 1.2);
    // Free nodes wrap round a band just off screen, so they slip out of view instead of piling up on the edges.
    const margin = Math.min(width, height) * 0.05;
    for (let i = 0; i < n; i++) {
      this.vis[i] += (this.used[i] - this.vis[i]) * fade;
      this.spark[i] *= Math.exp(-dt * 4);
      let fx = ugx, fy = ugy;
      if (!uniform) [fx, fy] = gravityAt(gMode, gStrength, x[i], y[i], width, height, this.time, 60);
      if (this.pointer) {
        const dx = this.pointer.x - x[i], dy = this.pointer.y - y[i];
        const d = Math.hypot(dx, dy) + 1;
        if (d < pr) {
          const f = (this.pointer.repel ? -1 : 1) * (1 - d / pr) * 3000;
          fx += (dx / d) * f; fy += (dy / d) * f;
        }
      }
      for (const sh of this.shocks) {
        const dx = x[i] - sh.x, dy = y[i] - sh.y;
        const d = Math.hypot(dx, dy) + 1;
        const band = Math.abs(d - sh.r);
        if (band > 40) continue;
        const f = (1 - band / 40) * sh.life;
        fx += (dx / d) * f * 2500; fy += (dy / d) * f * 2500;
        this.spark[i] = Math.max(this.spark[i], f * 0.8);
      }
      if (free || !this.used[i]) {
        this.head[i] += (Math.random() - 0.5) * dt * 3;
        const sp = speed * this.pace[i];
        vx[i] += (Math.cos(this.head[i]) * sp - vx[i]) * ease + fx * dt;
        vy[i] += (Math.sin(this.head[i]) * sp - vy[i]) * ease + fy * dt;
      } else {
        vx[i] += ((this.tx[i] - x[i]) * k - vx[i] * damp + fx) * dt;
        vy[i] += ((this.ty[i] - y[i]) * k - vy[i] * damp + fy) * dt;
      }
      x[i] += vx[i] * dt;
      y[i] += vy[i] * dt;
      if (free || !this.used[i]) {
        if (x[i] < -margin) x[i] += width + 2 * margin; else if (x[i] > width + margin) x[i] -= width + 2 * margin;
        if (y[i] < -margin) y[i] += height + 2 * margin; else if (y[i] > height + margin) y[i] -= height + 2 * margin;
      }
    }
  }

  step(dt: number, p: ParamValues, m: MusicFrame): void {
    this.stepped = true;
    this.time += dt;
    const pat = (this.pattern = p.pattern as string);
    this.generations = Math.round((p.signal as number) * 10);
    this.kickPush = p.kickPush as number;
    this.angle += ((p.rotation as number) * Math.PI / 180) * dt;
    this.drift += dt * (p.shapeDrift as number);
    this.morph += (this.morphTarget - this.morph) * Math.min(1, dt * 4);
    this.shape = pingPong((p.shape as number) + this.drift + this.morph);

    // Shaped patterns lay out their targets before moving; free ones link up after, so a node
    // that just wrapped round the screen never keeps a line stretched across it.
    this.edges = 0;
    const free = FREE.has(pat);
    if (!free) this.layout(pat, p, m);
    this.move(dt, p, m, free);
    if (free) this.linkFree(p, m, pat === "stars");
    this.buildAdjacency();

    const { width, height } = this.view;
    const n = this.n, x = this.x, y = this.y;
    const cx = width / 2, cy = height / 2;

    // Colour runs along the lines from node to node; outside "follow the melody" the scheme tints by distance from the centre.
    const scheme = p.colours as string;
    const spread = Math.min(1, (p.colourSpread as number) * dt);
    const sumX = this.sumX, sumY = this.sumY;
    if (spread > 0) {
      sumX.fill(0); sumY.fill(0);
      for (let e = 0; e < this.edges; e++) {
        const a = this.ea[e], b = this.eb[e];
        sumX[a] += this.hx[b]; sumY[a] += this.hy[b];
        sumX[b] += this.hx[a]; sumY[b] += this.hy[a];
      }
    }
    const tint = scheme === "notes" ? dt * 0.08 : dt * 0.8;
    const far = 0.5 * Math.hypot(width, height);
    for (let i = 0; i < n; i++) {
      const deg = this.adjStart[i + 1] - this.adjStart[i];
      if (spread > 0 && deg > 0) {
        this.hx[i] += (sumX[i] / deg - this.hx[i]) * spread;
        this.hy[i] += (sumY[i] / deg - this.hy[i]) * spread;
      }
      const th = (schemeHue(scheme, Math.hypot(x[i] - cx, y[i] - cy) / far, m.hue, m.beats) * Math.PI) / 180;
      this.hx[i] += (Math.cos(th) - this.hx[i]) * tint;
      this.hy[i] += (Math.sin(th) - this.hy[i]) * tint;
      const l = Math.hypot(this.hx[i], this.hy[i]) || 1;
      this.hx[i] /= l; this.hy[i] /= l;
    }

    for (const sh of this.shocks) { sh.r += dt * Math.max(width, height) * 0.7; sh.life -= dt * 1.2; }
    this.shocks = this.shocks.filter((sh) => sh.life > 0);

    // Signals hop along the lines; each arrival lights the node and, while it has generations left, forks on.
    let q = 0, arrived = 0;
    const count = this.packets;
    const arrFrom = this.arrFrom, arrTo = this.arrTo, arrGen = this.arrGen, arrHue = this.arrHue;
    const tooFar = free ? (this.reachNow * 1.6) ** 2 : Infinity;
    for (let i = 0; i < count; i++) {
      const t = this.pkT[i] + dt / HOP;
      const a = this.pkFrom[i], b = this.pkTo[i];
      if ((x[a] - x[b]) ** 2 + (y[a] - y[b]) ** 2 > tooFar) continue;
      if (t < 1) {
        this.pkFrom[q] = this.pkFrom[i]; this.pkTo[q] = this.pkTo[i]; this.pkT[q] = t;
        this.pkGen[q] = this.pkGen[i]; this.pkHue[q] = this.pkHue[i];
        q++;
        continue;
      }
      arrFrom[arrived] = this.pkFrom[i]; arrTo[arrived] = this.pkTo[i];
      arrGen[arrived] = this.pkGen[i]; arrHue[arrived] = this.pkHue[i];
      arrived++;
    }
    this.packets = q;
    for (let k = 0; k < arrived; k++) {
      const to = arrTo[k];
      this.spark[to] = Math.max(this.spark[to], 0.35 + arrGen[k] * 0.06);
      this.paint(to, arrHue[k], 0.5);
      // Usually one onward signal, sometimes a fork, so it spreads without lighting up everything.
      if (arrGen[k] > 0 && this.used[to]) this.launch(to, arrGen[k] - 1, arrHue[k], Math.random() < 0.35 ? 2 : 1, arrFrom[k]);
    }
    this.flash *= Math.exp(-dt * 5);
  }

  onPointer(input: PointerInput): void {
    this.pointer = input.pressed && input.type !== "up"
      ? { x: input.x, y: input.y, repel: input.button === 2 || input.shift }
      : null;
  }

  /** The used node nearest (px, py). */
  private nearest(px: number, py: number): number {
    let best = -1, bd = Infinity;
    for (let i = 0; i < this.n; i++) {
      if (!this.used[i]) continue;
      const d = (this.x[i] - px) ** 2 + (this.y[i] - py) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  private randomUsed(): number {
    for (let tries = 0; tries < 20; tries++) {
      const i = Math.floor(Math.random() * this.n);
      if (this.used[i]) return i;
    }
    return this.nearest(this.view.width / 2, this.view.height / 2);
  }

  onNote(ev: NoteEvent, p: ParamValues): void {
    const { width, height } = this.view;
    if (this.n === 0) return;
    if (ev.role === "tone") {
      // The node nearest the note, placed left to right by pitch, lights up and fires a signal along its lines.
      const i = this.nearest(width * (0.1 + ev.x * 0.8), height * (0.2 + noteHash(ev.note) * 0.6));
      if (i < 0) return;
      const hue = noteHue(ev.note);
      this.paint(i, hue, 1);
      this.spark[i] = 1;
      this.launch(i, this.generations, hue, 4);
      if (this.pattern === "mesh") this.shocks.push({ x: this.x[i], y: this.y[i], r: 0, life: ev.velocity * 0.4 });
    } else if (ev.role === "kick") {
      // Burst every node outward from the centre; springs pull the shape back together.
      // Free-roaming nodes have no spring to pull them back, so instead of outward they lunge
      // along their own heading: the web jolts without piling up against the edges.
      const push = this.kickPush * ev.velocity;
      const free = FREE.has(this.pattern);
      for (let i = 0; i < this.n; i++) {
        if (free) {
          this.vx[i] += Math.cos(this.head[i]) * push * 0.6;
          this.vy[i] += Math.sin(this.head[i]) * push * 0.6;
          continue;
        }
        const dx = this.x[i] - width / 2, dy = this.y[i] - height / 2;
        const d = Math.hypot(dx, dy) + 1;
        this.vx[i] += (dx / d) * push;
        this.vy[i] += (dy / d) * push;
      }
      this.flash = Math.max(this.flash, ev.velocity);
    } else if (ev.role === "snare") {
      this.shocks.push({ x: width * (0.25 + Math.random() * 0.5), y: height * (0.25 + Math.random() * 0.5), r: 0, life: ev.velocity * 0.6 });
      if (this.shocks.length > 4) this.shocks.shift();
      this.flash = Math.max(this.flash, ev.velocity * 0.4);
    } else if (ev.role === "bassline") {
      // The bass line bends the shape: its pitch sets how far the Shape slider is pushed.
      this.morphTarget = (ev.x - 0.5) * 2 * (p.bassMorph as number);
    } else if (ev.role === "chord") {
      const notes = ev.notes ?? [ev.note];
      for (let k = 0; k < this.n * 0.3 * ev.velocity; k++) {
        const i = Math.floor(Math.random() * this.n);
        this.paint(i, noteHue(notes[k % notes.length]), 1);
      }
      // Each chord note fires its own signal from somewhere in the network.
      for (const note of notes) {
        const i = this.randomUsed();
        if (i >= 0) this.launch(i, Math.max(0, this.generations - 1), noteHue(note), 3);
      }
    } else {
      for (let k = 0; k < Math.max(2, this.n * 0.04); k++) this.spark[this.randomUsed()] = ev.velocity * 0.7;
    }
  }

  // ---- Drawing -------------------------------------------------------------

  render(g: CanvasRenderingContext2D, view: Viewport, p: ParamValues, m: MusicFrame): void {
    applyFeedback(this.fb, g, view, p, this.stepped);
    this.stepped = false;
    const n = this.n, x = this.x, y = this.y, vis = this.vis, hue = this.hue;
    for (let i = 0; i < n; i++) hue[i] = ((Math.atan2(this.hy[i], this.hx[i]) * 180) / Math.PI + 360) % 360;

    g.globalCompositeOperation = "lighter";
    g.lineCap = "round";
    g.lineWidth = (p.lineWidth as number) * (1 + Math.min(1.5, m.bass) * 0.6);
    const light = 55 + this.flash * 20 + Math.min(1, m.level) * 10;
    const bright = (p.lineBright as number) * (0.7 + Math.min(1, m.level) * 0.5 + this.flash * 0.4);

    // Lines, bucketed by hue and brightness so each bucket is one stroke style, flushed in small batches.
    const paths: (Path2D | null)[] = new Array(HUES * SHADES).fill(null);
    const counts = new Int32Array(HUES * SHADES);
    const style = (b: number) => `hsla(${((b % HUES) + 0.5) * (360 / HUES)} 85% ${light}% / ${Math.min(1, ((Math.floor(b / HUES) + 0.6) / SHADES) * bright)})`;
    for (let e = 0; e < this.edges; e++) {
      const a = this.ea[e], b = this.eb[e], c = this.ec[e];
      const w = this.ew[e] * Math.min(vis[a], vis[b]);
      if (w < 0.12) continue;
      let bx = x[b], by = y[b];
      if (c >= 0) { const t = this.et[e]; bx += (x[c] - bx) * t; by += (y[c] - by) * t; }
      const hxm = this.hx[a] + this.hx[b], hym = this.hy[a] + this.hy[b];
      const h = ((Math.atan2(hym, hxm) * 180) / Math.PI + 360) % 360;
      const bucket = (Math.min(SHADES - 1, Math.floor(w * SHADES))) * HUES + (Math.floor(h / (360 / HUES)) % HUES);
      let path = paths[bucket];
      if (!path) path = paths[bucket] = new Path2D();
      path.moveTo(x[a], y[a]);
      path.lineTo(bx, by);
      if (++counts[bucket] === BATCH) {
        g.strokeStyle = style(bucket);
        g.stroke(path);
        paths[bucket] = null;
        counts[bucket] = 0;
      }
    }
    for (let b = 0; b < paths.length; b++) {
      const path = paths[b];
      if (!path) continue;
      g.strokeStyle = style(b);
      g.stroke(path);
    }

    // Nodes: small dots by hue, glowing sprites on the ones that just lit up.
    const size = (p.nodeSize as number) * (this.pattern === "stars" ? 1.5 : 1) * (1 + m.pulse * 0.35);
    if (size > 0.05) {
      const dots: (Path2D | null)[] = new Array(HUES).fill(null);
      const dotCounts = new Int32Array(HUES);
      for (let i = 0; i < n; i++) {
        if (vis[i] < 0.1) continue;
        const b = Math.floor(hue[i] / (360 / HUES)) % HUES;
        let path = dots[b];
        if (!path) path = dots[b] = new Path2D();
        const r = size * vis[i] * (1 + this.spark[i]);
        path.moveTo(x[i] + r, y[i]);
        path.arc(x[i], y[i], r, 0, Math.PI * 2);
        if (++dotCounts[b] === BATCH) {
          g.fillStyle = `hsl(${(b + 0.5) * (360 / HUES)} 80% ${light + 15}%)`;
          g.fill(path);
          dots[b] = null;
          dotCounts[b] = 0;
        }
      }
      for (let b = 0; b < HUES; b++) {
        const path = dots[b];
        if (!path) continue;
        g.fillStyle = `hsl(${(b + 0.5) * (360 / HUES)} 80% ${light + 15}%)`;
        g.fill(path);
      }
    }
    const dpr = window.devicePixelRatio || 1;
    const glow = Math.max(1, p.nodeSize as number) * (1 + Math.min(1, m.treble) * 0.6);
    for (let i = 0, drawn = 0; i < n && drawn < MAX_GLOWS; i++) {
      const sp = this.spark[i] * vis[i];
      if (sp < 0.3) continue;
      const s = glow * 14 * sp;
      g.drawImage(glowSprite(hue[i], 90, s * dpr), x[i] - s / 2, y[i] - s / 2, s, s);
      drawn++;
    }
    // Signals in flight: short bright comets running along the lines, one stroke per hue.
    if (this.packets > 0) {
      const comets: (Path2D | null)[] = new Array(HUES).fill(null);
      for (let q = 0; q < this.packets; q++) {
        const a = this.pkFrom[q], b = this.pkTo[q], t = this.pkT[q];
        const t0 = Math.max(0, t - 0.25);
        const bucket = Math.floor(this.pkHue[q] / (360 / HUES)) % HUES;
        const path = comets[bucket] ?? (comets[bucket] = new Path2D());
        path.moveTo(x[a] + (x[b] - x[a]) * t0, y[a] + (y[b] - y[a]) * t0);
        path.lineTo(x[a] + (x[b] - x[a]) * t, y[a] + (y[b] - y[a]) * t);
      }
      g.lineWidth = (p.lineWidth as number) * 1.8 + 0.5;
      for (let b = 0; b < HUES; b++) {
        const path = comets[b];
        if (!path) continue;
        g.strokeStyle = `hsl(${(b + 0.5) * (360 / HUES)} 95% 72%)`;
        g.stroke(path);
      }
    }
    g.lineCap = "butt";
    g.lineWidth = 1;
    g.globalCompositeOperation = "source-over";
  }

  stats(): string {
    let shown = 0;
    for (let i = 0; i < this.n; i++) if (this.used[i]) shown++;
    return `${shown} nodes · ${this.edges} lines`;
  }
}

export const plexus: ModelDefinition = {
  id: "plexus",
  name: "Plexus",
  category: "Particles",
  description: "Glowing nodes joined by lines, connecting in the pattern you pick: a drifting web, star-chart constellations, counter-rotating star rings, string art, fractal branches or a rolling mesh. Each melody note fires a signal racing along the lines, kicks burst the shape outward, snares send a shockwave through it, the bass line bends the shape and the spectrum makes it breathe.",
  hint: "Hold the mouse to pull nodes in. Right-click or Shift to push them away.",
  fixedDt: 1 / 60,
  paintsBackground: true,
  params: [
    { kind: "choice", key: "pattern", label: "Pattern", default: "web", group: "Pattern",
      description: "How the nodes connect. Switching springs every node across to its new place.",
      options: [
        { value: "web", label: "Web: links whatever is close" },
        { value: "stars", label: "Constellations: nearest neighbours" },
        { value: "rings", label: "Star rings" },
        { value: "string", label: "String art" },
        { value: "branches", label: "Branches" },
        { value: "mesh", label: "Wave mesh" },
      ] },
    { kind: "number", key: "shape", label: "Shape", min: 0, max: 1, step: 0.01, default: 0.35, group: "Pattern",
      description: "Bends the pattern: how far the web reaches, how many stars each joins, the star points, the string-art multiplier, the branch angle, or how much the mesh rolls." },
    { kind: "number", key: "shapeDrift", label: "Shape drift", min: 0, max: 0.2, step: 0.002, default: 0.01, group: "Pattern",
      description: "Slowly sweeps the Shape back and forth on its own, so the pattern keeps evolving." },
    { kind: "number", key: "symmetry", label: "Symmetry", min: 3, max: 12, step: 1, default: 6, group: "Pattern",
      description: "How many-fold the Star rings and Branches are." },
    { kind: "number", key: "rings", label: "Rings", min: 1, max: 8, step: 1, default: 4, group: "Pattern",
      description: "How many rings of stars, as far as there are nodes to fill them." },
    { kind: "number", key: "scale", label: "Shape size", min: 0.2, max: 1.6, step: 0.01, default: 0.85, group: "Pattern",
      description: "How big the shaped patterns are, as a share of the screen." },
    { kind: "number", key: "reach", label: "Link reach", min: 30, max: 500, step: 5, default: 130, group: "Lines",
      description: "How close nodes in the Web and Constellations must be to join up. The bass stretches it." },
    { kind: "number", key: "lineWidth", label: "Line width", min: 0.3, max: 5, step: 0.1, default: 1.1, group: "Lines", global: "size",
      description: "How thick the lines are. The bass thickens them." },
    { kind: "number", key: "lineBright", label: "Line brightness", min: 0.05, max: 1.5, step: 0.01, default: 0.55, group: "Lines",
      description: "How bright the lines glow. Where lines cross they add up toward white." },
    { kind: "number", key: "nodeSize", label: "Node size", min: 0, max: 8, step: 0.1, default: 1.8, group: "Lines", global: "size",
      description: "How big the dots are. Zero leaves only the lines and the signals." },
    { kind: "number", key: "drift", label: "Drift speed", min: 0, max: 400, step: 5, default: 45, group: "Motion", global: "energy",
      description: "How fast nodes wander in the Web and Constellations." },
    { kind: "number", key: "rotation", label: "Rotation", min: -120, max: 120, step: 1, default: 10, group: "Motion",
      description: "How fast the shaped patterns turn, degrees per second. Star rings turn alternate ways." },
    { kind: "number", key: "snap", label: "Snap", min: 1, max: 30, step: 0.5, default: 7, group: "Motion",
      description: "How quickly nodes spring back into the shape after being knocked out of it." },
    { kind: "number", key: "bounce", label: "Bounce", min: 0, max: 1, step: 0.01, default: 0.55, group: "Motion",
      description: "How much nodes overshoot and wobble as they spring back. High values ring like jelly." },
    { kind: "number", key: "kickPush", label: "Kick burst", min: 0, max: 1200, step: 10, default: 280, group: "Music", global: "energy",
      description: "How hard a kick drum bursts the shape outward from the centre, or makes the web's nodes lunge forward." },
    { kind: "number", key: "signal", label: "Signal travel", min: 0, max: 1, step: 0.01, default: 0.6, group: "Music",
      description: "How far each note's signal races along the lines, forking at every node. Zero turns signals off." },
    { kind: "number", key: "bassMorph", label: "Bass bend", min: 0, max: 0.5, step: 0.01, default: 0.12, group: "Music",
      description: "How far the bass line's pitch pushes the Shape, so the pattern bends with the bass." },
    { kind: "number", key: "warp", label: "Spectrum warp", min: 0, max: 2, step: 0.01, default: 0.5, group: "Music",
      description: "How much the spectrum bulges the shape and loudness speeds up the drifting nodes." },
    { kind: "number", key: "colourSpread", label: "Colour spread", min: 0, max: 10, step: 0.1, default: 1.5, group: "Music",
      description: "How fast a colour flows along the lines into neighbouring nodes." },
    gravityModeParam("off", undefined, { description: "A pull on every node. Shaped patterns sag against it; the web pours that way." }),
    { kind: "number", key: "fieldGravity", label: "Field strength", min: 0, max: 1500, step: 10, default: 200, group: "Gravity", global: "gravity",
      description: "How hard the gravity field pulls the nodes." },
    colourParam("notes"),
    ...feedbackParams(0.55, 0, 0),
    { kind: "number", key: "count", label: "Nodes", min: 20, max: 600, step: 10, default: 180, resetOnChange: true, group: "Setup",
      description: "How many nodes. Rebuilds the network." },
  ],
  macros: [
    { key: "morph", label: "Morph", description: "Sweeps the Shape and lets it drift faster, so the pattern folds through its forms.",
      targets: [{ param: "shape", amount: 0.6 }, { param: "shapeDrift", amount: 0.25 }, { param: "bassMorph", amount: 0.3 }] },
    { key: "burst", label: "Burst", description: "Bouncier springs and harder kicks, so every beat explodes the shape.",
      targets: [{ param: "kickPush", amount: 0.5 }, { param: "bounce", amount: 0.4 }, { param: "warp", amount: 0.4 }, { param: "snap", amount: -0.1 }, { param: "lineWidth", amount: 0.15 }] },
    { key: "kaleido", label: "Kaleidoscope", description: "Snaps into spinning star rings in rainbow colours.",
      targets: [{ param: "rotation", amount: 0.3 }, { param: "symmetry", amount: 0.4 }, { param: "spin", amount: 0.2 }, { param: "pattern", set: "rings", at: 0.15 }, { param: "colours", set: "rainbow", at: 0.6 }] },
    { key: "hyper", label: "Hyperspace", description: "Long glowing trails that fly outward into a spiral tunnel.",
      targets: [{ param: "afterglow", amount: 0.4 }, { param: "zoom", amount: 0.5 }, { param: "spin", amount: 0.25 }, { param: "lineBright", amount: -0.1 }] },
  ],
  modulations: [
    { source: "kick", target: "lineWidth", amount: 0.2 },
    { source: "lfoBar", target: "shape", amount: 0.12 },
    { source: "bass", target: "reach", amount: 0.15 },
    { source: "treble", target: "nodeSize", amount: 0.15 },
  ],
  reactions: [
    { source: "tone", text: "The nearest node, placed by pitch, lights up and fires a signal that races along the lines" },
    { source: "kick", text: "Bursts the shape outward from the centre (in the Web and Constellations, every node lunges forward) and flashes the lines" },
    { source: "snare", text: "Sends a shockwave rippling through the nodes" },
    { source: "hat", text: "A few nodes twinkle" },
    { source: "bassline", text: "The bass line's pitch bends the shape" },
    { source: "chord", text: "Part of the network takes the chord's colours, and each chord note fires a signal" },
    { source: "bass", text: "Thickens the lines and stretches the web's reach" },
    { source: "level", text: "Lines glow brighter and drifting nodes speed up as the music gets louder" },
    { source: "treble", text: "Lit nodes glow bigger" },
    { source: "spectrum", text: "The spectrum bulges the shape outward" },
    { source: "beat", text: "Nodes pulse on the beat" },
  ],
  create: () => new PlexusSim(),
};
