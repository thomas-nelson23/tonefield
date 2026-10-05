import type { ModelDefinition, MusicFrame, NoteEvent, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { noteHue } from "./lib/music";
import { gravityAt, gravityModeParam } from "./lib/gravity";
import { Feedback, applyFeedback, colourParam, feedbackParams, glowSprite, schemeHue } from "./lib/visual";

interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Gravitational parameter G*m, in px^3/s^2. */
  gm: number;
  r: number;
  star: boolean;
  hue: number;
  /** Pitch class 0..11: the planet rings out whenever the melody plays this note. */
  pc: number;
  /** Brightness boost from hits, fading back to 0. */
  glow: number;
  trail: Float32Array;
  trailHead: number;
  trailLen: number;
}

const BASE_GM = 4.5e6; // a 200px orbit around a 1x star moves at ~150 px/s
const TRAIL_MAX = 600;
/** Leapfrog substeps per frame at time scale 1; more at higher time scales so each step stays short. */
const SUBSTEPS = 4;
const MAX_SUBSTEPS = 16;
/** Point fields (centre, corners...) fade out within this many pixels of their target so systems settle. */
const FIELD_SOFT = 80;
/** The soft edge cushion stars feel while a field is on: depth (px), spring and damping. */
const EDGE_MARGIN = 60;
const EDGE_K = 60;
const EDGE_C = 6;

/**
 * A planetary system drawn as a light show: planets under Newtonian gravity
 * (leapfrog, so orbits stay closed) trace glowing rings, each planet is tuned
 * to a note and flares whenever the melody plays it, and the sun's corona is
 * the live waveform. Planets that hit a star are swallowed.
 */
class OrbitsSim implements SimulationModel {
  private bodies: Body[] = [];
  private view: Viewport = { width: 1, height: 1 };
  private drag: { x0: number; y0: number; x: number; y: number; star: boolean } | null = null;
  private swallowed = 0;
  private pulse = 0;
  private time = 0;
  private fieldMode = "off";
  private fieldG = 0;
  private fb = new Feedback();
  private stepped = false;
  /** Snare flash for the constellation lines between neighbouring planets. */
  private links = 0;
  private sunSwell = 0;
  private ripples: { x: number; y: number; r: number; life: number }[] = [];

  reset(view: Viewport, p: ParamValues): void {
    this.view = view;
    this.bodies = [];
    this.swallowed = 0;
    const cx = view.width / 2, cy = view.height / 2;
    const starGm = BASE_GM * (p.starMass as number);
    const span = Math.min(view.width, view.height) * 0.45;

    if (p.system === "binary") {
      const a = span * 0.18;
      const v = Math.sqrt(starGm / (4 * a)); // two equal stars orbiting their centre
      this.bodies.push(this.make(cx - a, cy, 0, v, starGm, true), this.make(cx + a, cy, 0, -v, starGm, true));
      // Circumbinary planets far enough out to be (mostly) stable.
      for (let i = 0; i < (p.planets as number); i++) {
        const r = span * (0.55 + Math.random() * 0.45);
        this.addCircular(cx, cy, r, 2 * starGm);
      }
    } else if (p.system === "planets") {
      this.bodies.push(this.make(cx, cy, 0, 0, starGm, true));
      for (let i = 0; i < (p.planets as number); i++) {
        const r = span * (0.15 + Math.random() * 0.85);
        this.addCircular(cx, cy, r, starGm);
      }
    } else {
      this.bodies.push(this.make(cx, cy, 0, 0, starGm, true));
    }
  }

  resize(view: Viewport): void {
    this.view = view;
  }

  private make(x: number, y: number, vx: number, vy: number, gm: number, star: boolean): Body {
    return {
      x, y, vx, vy, gm, star,
      r: star ? 10 + Math.sqrt(gm / BASE_GM) * 6 : 2.5 + Math.random() * 2.5,
      hue: star ? 45 : Math.random() * 360,
      pc: Math.floor(Math.random() * 12),
      glow: 0,
      trail: new Float32Array(TRAIL_MAX * 2),
      trailHead: 0,
      trailLen: 0,
    };
  }

  private addCircular(cx: number, cy: number, r: number, centralGm: number): void {
    const a = Math.random() * Math.PI * 2;
    const v = Math.sqrt(centralGm / r) * (0.95 + Math.random() * 0.1);
    const dir = Math.random() < 0.85 ? 1 : -1;
    this.bodies.push(
      this.make(cx + Math.cos(a) * r, cy + Math.sin(a) * r, -Math.sin(a) * v * dir, Math.cos(a) * v * dir, BASE_GM * 0.002, false),
    );
  }

  /**
   * The outside field's pull on a star: the gravity-direction field, plus a soft, damped cushion
   * near the edges so a dragged star eases to a stop instead of leaving the screen.
   */
  private starField(s: Body): [number, number] {
    const { width: w, height: h } = this.view;
    let [ax, ay] = gravityAt(this.fieldMode, this.fieldG, s.x, s.y, w, h, this.time, FIELD_SOFT);
    const m = s.r + EDGE_MARGIN;
    if (s.x < m) ax += EDGE_K * (m - s.x) - EDGE_C * Math.min(0, s.vx);
    if (s.x > w - m) ax -= EDGE_K * (s.x - (w - m)) + EDGE_C * Math.max(0, s.vx);
    if (s.y < m) ay += EDGE_K * (m - s.y) - EDGE_C * Math.min(0, s.vy);
    if (s.y > h - m) ay -= EDGE_K * (s.y - (h - m)) + EDGE_C * Math.max(0, s.vy);
    return [ax, ay];
  }

  private accelerate(dt: number, mutual: boolean): void {
    const bs = this.bodies;
    const fieldOn = this.fieldMode !== "off" && this.fieldG > 0;
    // The outside field moves each star; every planet gets exactly its host star's pull, so a
    // dragged system keeps its orbits instead of being torn apart against the edges.
    const ext = new Map<Body, [number, number]>();
    if (fieldOn) for (const b of bs) if (b.star) ext.set(b, this.starField(b));
    for (let i = 0; i < bs.length; i++) {
      const a = bs[i];
      let ax = 0, ay = 0;
      let host: Body | null = null, hostPull = 0;
      for (let j = 0; j < bs.length; j++) {
        if (i === j) continue;
        const b = bs[j];
        if (!b.star && !mutual) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy + 16;
        const inv = b.gm / (d2 * Math.sqrt(d2));
        ax += dx * inv;
        ay += dy * inv;
        if (fieldOn && b.star && b.gm / d2 > hostPull) { hostPull = b.gm / d2; host = b; }
      }
      if (fieldOn) {
        const f = a.star ? ext.get(a) : host ? ext.get(host) : undefined;
        if (f) { ax += f[0]; ay += f[1]; }
        else if (!a.star) {
          const [fx, fy] = gravityAt(this.fieldMode, this.fieldG, a.x, a.y, this.view.width, this.view.height, this.time, FIELD_SOFT);
          ax += fx; ay += fy;
        }
      }
      a.vx += ax * dt;
      a.vy += ay * dt;
    }
  }

  step(dt: number, p: ParamValues, m: MusicFrame): void {
    this.stepped = true;
    for (const b of this.bodies) b.glow *= Math.exp(-dt * 3);
    this.links *= Math.exp(-dt * 4);
    for (const r of this.ripples) { r.r += dt * 500; r.life -= dt * 1.1; }
    this.ripples = this.ripples.filter((r) => r.life > 0);
    // The sun swells with the bass.
    this.sunSwell = Math.min(1.5, m.bass);
    const ts = p.timeScale as number;
    // Keep the substep no longer than at time scale 1 (up to a cap), so fast-forward stays accurate.
    const substeps = Math.min(MAX_SUBSTEPS, Math.max(SUBSTEPS, Math.ceil(SUBSTEPS * ts)));
    const h = (dt * ts) / substeps;
    const mutual = Boolean(p.mutual);
    this.fieldMode = p.gravityMode as string;
    this.fieldG = p.fieldGravity as number;
    const fieldOn = this.fieldMode !== "off" && this.fieldG > 0;
    for (let s = 0; s < substeps; s++) {
      this.time += h;
      // Kick-drift-kick leapfrog.
      this.accelerate(h / 2, mutual);
      for (const b of this.bodies) { b.x += b.vx * h; b.y += b.vy * h; }
      this.accelerate(h / 2, mutual);
      this.absorb();
    }

    const { width: w, height: hgt } = this.view;
    // Backstop for the edge cushion: a star rammed past it is stopped at the edge.
    if (fieldOn) {
      for (const b of this.bodies) {
        if (!b.star) continue;
        if (b.x < b.r) { b.x = b.r; b.vx = Math.max(0, b.vx); }
        if (b.x > w - b.r) { b.x = w - b.r; b.vx = Math.min(0, b.vx); }
        if (b.y < b.r) { b.y = b.r; b.vy = Math.max(0, b.vy); }
        if (b.y > hgt - b.r) { b.y = hgt - b.r; b.vy = Math.min(0, b.vy); }
      }
    }
    this.bodies = this.bodies.filter((b) => b.star || (b.x > -w && b.x < 2 * w && b.y > -hgt && b.y < 2 * hgt));
    const trailLen = Math.min(TRAIL_MAX, p.trail as number);
    for (const b of this.bodies) {
      b.trail[b.trailHead * 2] = b.x;
      b.trail[b.trailHead * 2 + 1] = b.y;
      b.trailHead = (b.trailHead + 1) % TRAIL_MAX;
      b.trailLen = Math.min(b.trailLen + 1, trailLen);
    }
  }

  /** Planets that fall into a star are removed; colliding stars merge. */
  private absorb(): void {
    const bs = this.bodies;
    for (const s of bs) {
      if (!s.star || s.gm === 0) continue;
      for (const b of bs) {
        if (b === s || b.gm === 0) continue;
        if ((b.x - s.x) ** 2 + (b.y - s.y) ** 2 > (s.r + b.r * 0.5) ** 2) continue;
        if (b.star && b.gm > s.gm) continue;
        // Merge with momentum conservation.
        const m = s.gm + b.gm;
        s.vx = (s.vx * s.gm + b.vx * b.gm) / m;
        s.vy = (s.vy * s.gm + b.vy * b.gm) / m;
        s.gm = m;
        s.r = 10 + Math.sqrt(m / BASE_GM) * 6;
        if (!b.star) this.swallowed++;
        b.gm = 0;
      }
    }
    if (bs.some((b) => b.gm === 0)) this.bodies = bs.filter((b) => b.gm !== 0);
  }

  onPointer(input: PointerInput): void {
    if (input.type === "down") {
      this.drag = { x0: input.x, y0: input.y, x: input.x, y: input.y, star: input.button === 2 || input.shift };
    } else if (input.type === "move" && this.drag) {
      this.drag.x = input.x;
      this.drag.y = input.y;
    } else if (input.type === "up" && this.drag) {
      const { x0, y0, x, y, star } = this.drag;
      this.bodies.push(this.make(x0, y0, (x0 - x) * 1.5, (y0 - y) * 1.5, star ? BASE_GM * 0.5 : BASE_GM * 0.002, star));
      this.drag = null;
    }
  }

  onNote(ev: NoteEvent): void {
    if (ev.role === "kick") {
      this.pulse = Math.max(this.pulse, ev.velocity);
      for (const b of this.bodies) if (b.star) this.ripples.push({ x: b.x, y: b.y, r: b.r, life: ev.velocity });
      return;
    }
    if (ev.role === "snare") {
      this.links = Math.max(this.links, ev.velocity);
      return;
    }
    if (ev.role === "bassline") {
      this.pulse = Math.max(this.pulse, ev.velocity * 0.5);
      for (const b of this.bodies) if (b.star) this.ripples.push({ x: b.x, y: b.y, r: b.r, life: ev.velocity * 0.45 });
      return;
    }
    if (ev.role === "chord") {
      // Every planet tuned to a note of the chord glows.
      const pcs = new Set((ev.notes ?? [ev.note]).map((n) => ((n % 12) + 12) % 12));
      for (const b of this.bodies) if (!b.star && pcs.has(b.pc)) b.glow = Math.max(b.glow, ev.velocity * 0.8);
      return;
    }
    if (ev.role === "hat") {
      const planets = this.bodies.filter((b) => !b.star);
      for (let k = 0; k < 4 && planets.length; k++) planets[Math.floor(Math.random() * planets.length)].glow = ev.velocity * 0.8;
      return;
    }
    // Every planet tuned to this note rings out...
    const pc = ((ev.note % 12) + 12) % 12;
    for (const b of this.bodies) if (!b.star && b.pc === pc) b.glow = Math.max(b.glow, ev.velocity);
    // ...and a new one is born: low notes far out, high notes close in.
    const star = this.bodies.find((b) => b.star);
    if (!star) return;
    const span = Math.min(this.view.width, this.view.height) * 0.45;
    const r = span * (0.95 - ev.x * 0.75);
    const before = this.bodies.length;
    this.addCircular(star.x, star.y, r, star.gm);
    const planet = this.bodies[before];
    planet.vx += star.vx;
    planet.vy += star.vy;
    planet.hue = noteHue(ev.note);
    planet.pc = pc;
    planet.glow = ev.velocity;
    planet.r = 2.5 + ev.velocity * 3;
    const planets = this.bodies.filter((b) => !b.star);
    if (planets.length > 260) this.bodies.splice(this.bodies.indexOf(planets[0]), 1);
  }

  /** Where a body launched from the current drag would go (stars held fixed). */
  private predict(): number[] {
    if (!this.drag) return [];
    const { x0, y0, x, y } = this.drag;
    let px = x0, py = y0, vx = (x0 - x) * 1.5, vy = (y0 - y) * 1.5;
    const stars = this.bodies.filter((b) => b.star);
    const pts = [px, py];
    const h = 1 / 240;
    // Planets share their host star's outside pull, so the field drops out of the relative motion.
    for (let i = 0; i < 1200; i++) {
      for (const s of stars) {
        const dx = s.x - px, dy = s.y - py;
        const d2 = dx * dx + dy * dy + 16;
        if (d2 < s.r * s.r) return pts;
        const inv = s.gm / (d2 * Math.sqrt(d2));
        vx += dx * inv * h;
        vy += dy * inv * h;
      }
      px += vx * h;
      py += vy * h;
      if (i % 3 === 0) pts.push(px, py);
    }
    return pts;
  }

  render(g: CanvasRenderingContext2D, view: Viewport, p: ParamValues, m: MusicFrame): void {
    applyFeedback(this.fb, g, view, p, this.stepped);
    this.stepped = false;
    this.pulse *= 0.9;
    g.globalCompositeOperation = "lighter";
    const span = Math.min(view.width, view.height) * 0.45;
    const star0 = this.bodies.find((b) => b.star);
    const spec = m.spectrum;
    const bright = 0.35 + Math.min(1, m.level) * 0.4;
    // Each planet keeps its note's colour, unless another scheme is picked.
    const scheme = p.colours as string;
    const hueOf = (b: Body) => (scheme === "notes" ? b.hue : schemeHue(scheme, b.hue / 360, m.hue, m.beats));

    // Trails fade from transparent (oldest) to solid (newest) in a few bands.
    const bands = 4;
    g.lineWidth = p.trailWidth as number;
    for (const b of this.bodies) {
      const n = b.trailLen;
      if (n < 2) continue;
      const lift = Math.min(1, b.glow);
      for (let k = 0; k < bands; k++) {
        const from = Math.floor((k * (n - 1)) / bands), to = Math.floor(((k + 1) * (n - 1)) / bands);
        g.beginPath();
        for (let i = from; i <= to; i++) {
          const idx = ((b.trailHead - n + i + TRAIL_MAX) % TRAIL_MAX) * 2;
          if (i === from) g.moveTo(b.trail[idx], b.trail[idx + 1]);
          else g.lineTo(b.trail[idx], b.trail[idx + 1]);
        }
        g.strokeStyle = `hsla(${hueOf(b)} 85% ${60 + lift * 25}% / ${((k + 1) / bands) * (bright + lift * 0.5)})`;
        g.stroke();
      }
    }
    g.lineWidth = 1;

    // Snares flash constellation lines between each planet and its nearest neighbour.
    if (this.links > 0.03) {
      const planets = this.bodies.filter((b) => !b.star);
      g.beginPath();
      for (const a of planets) {
        let best: Body | null = null, bd = Infinity;
        for (const b of planets) {
          if (a === b) continue;
          const d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
          if (d < bd) { bd = d; best = b; }
        }
        if (best && bd < (span * 0.5) ** 2) { g.moveTo(a.x, a.y); g.lineTo(best.x, best.y); }
      }
      g.strokeStyle = `rgba(200,220,255,${this.links * 0.7})`;
      g.stroke();
    }

    for (const r of this.ripples) {
      g.beginPath();
      g.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      g.lineWidth = 1 + r.life * 4;
      g.strokeStyle = `rgba(255,190,110,${r.life * 0.5})`;
      g.stroke();
    }
    g.lineWidth = 1;

    for (const b of this.bodies) {
      if (b.star) {
        this.drawSun(g, b, m);
        continue;
      }
      // Planets light up with the part of the spectrum their orbit stands for: outer orbits are bass, inner are treble.
      let level = 0;
      if (star0) {
        const t = 1 - Math.min(1, Math.hypot(b.x - star0.x, b.y - star0.y) / span);
        level = spec[Math.min(spec.length - 1, Math.floor(t * spec.length))];
      }
      const s = b.r * (2.2 + level * 3 + b.glow * 5) * (p.planetGlow as number);
      g.globalAlpha = Math.min(1, 0.55 + level * 0.5 + b.glow);
      g.drawImage(glowSprite(hueOf(b)), b.x - s, b.y - s, s * 2, s * 2);
      g.globalAlpha = 1;
    }
    g.globalCompositeOperation = "source-over";

    const path = this.predict();
    if (path.length > 2) {
      g.beginPath();
      g.moveTo(path[0], path[1]);
      for (let i = 2; i < path.length; i += 2) g.lineTo(path[i], path[i + 1]);
      g.setLineDash([3, 5]);
      g.strokeStyle = "rgba(255,255,255,0.5)";
      g.stroke();
      g.setLineDash([]);
    }
  }

  /** A sun whose corona traces the live waveform and swells with the bass and kicks. */
  private drawSun(g: CanvasRenderingContext2D, b: Body, m: MusicFrame): void {
    const swell = 1 + this.sunSwell * 0.6 + this.pulse * 0.8;
    const R = b.r * 3 * swell;
    const glow = g.createRadialGradient(b.x, b.y, 0, b.x, b.y, R * 1.6);
    glow.addColorStop(0, "rgba(255,230,160,0.95)");
    glow.addColorStop(0.3, "rgba(255,170,60,0.4)");
    glow.addColorStop(1, "rgba(255,120,40,0)");
    g.fillStyle = glow;
    g.beginPath();
    g.arc(b.x, b.y, R * 1.6, 0, Math.PI * 2);
    g.fill();
    // The corona: the waveform wrapped round the sun.
    const wave = m.wave;
    const n = wave.length;
    const cr = b.r * 2.2 * swell;
    g.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = cr * (1 + wave[i % n] * 0.9);
      const px = b.x + Math.cos(a) * r, py = b.y + Math.sin(a) * r;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.lineWidth = 1.5;
    g.strokeStyle = `rgba(255,200,120,${0.35 + Math.min(1, m.level) * 0.5})`;
    g.stroke();
    g.lineWidth = 1;
    g.beginPath();
    g.arc(b.x, b.y, b.r * (1 + this.pulse * 0.3), 0, Math.PI * 2);
    g.fillStyle = "hsl(45 100% 85%)";
    g.fill();
  }

  stats(): string {
    const stars = this.bodies.filter((b) => b.star).length;
    return `${stars} star${stars === 1 ? "" : "s"} · ${this.bodies.length - stars} planets · ${this.swallowed} swallowed`;
  }
}

export const orbits: ModelDefinition = {
  id: "orbits",
  name: "Orbit rings",
  category: "Particles",
  description: "Planets trace glowing rings round a sun whose corona is the live waveform. Each planet is tuned to a note and flares when the melody plays it, and orbits light up with their slice of the spectrum: outer rings are bass, inner rings treble.",
  hint: "Drag to launch a planet (the drag sets its velocity). Right-drag or Shift-drag launches a new star. Each melody note adds a planet in its colour, low notes on outer orbits.",
  fixedDt: 1 / 60,
  paintsBackground: true,
  params: [
    {
      kind: "number", key: "timeScale", label: "Time scale", min: 0.05, max: 6, step: 0.05, default: 1, group: "Motion", global: "energy",
      description: "How fast the planets go round. High values whip them into spirograph blurs.",
    },
    {
      kind: "boolean", key: "mutual", label: "Planets attract each other", default: false, group: "Gravity",
      description: "Planets tug on each other as well as the stars, so the rings wobble and drift.",
    },
    gravityModeParam("off", undefined, {
      description: "Drags whole systems around: stars and their planets move together, cushioned at the edges.",
    }),
    {
      kind: "number", key: "fieldGravity", label: "Field strength", min: 0, max: 600, step: 5, default: 120, group: "Gravity", global: "gravity",
      description: "How hard the outside field drags the systems. Strong fields sling stars across the screen.",
    },
    {
      kind: "number", key: "trail", label: "Trail length", min: 0, max: TRAIL_MAX, step: 10, default: 260, group: "Look",
      description: "How long a glowing tail each planet leaves. Long trails draw whole rings.",
    },
    {
      kind: "number", key: "trailWidth", label: "Trail width", min: 0.5, max: 8, step: 0.1, default: 1.4, group: "Look", global: "size",
      description: "How thick the trails are. Thick trails overlap into bands of light.",
    },
    {
      kind: "number", key: "planetGlow", label: "Planet glow", min: 0.3, max: 4, step: 0.05, default: 1, group: "Look", global: "size",
      description: "How big each planet's glow is.",
    },
    colourParam("notes"),
    ...feedbackParams(0.6, 0, 0),
    {
      kind: "choice", key: "system", label: "System", default: "planets", resetOnChange: true, group: "Setup",
      description: "Which system to start with. Changing it restarts the scene.",
      options: [
        { value: "planets", label: "Star with planets" },
        { value: "binary", label: "Binary star" },
        { value: "empty", label: "Lone star" },
      ],
    },
    {
      kind: "number", key: "planets", label: "Planets", min: 0, max: 300, step: 1, default: 60, resetOnChange: true, group: "Setup",
      description: "How many planets the system starts with.",
    },
    {
      kind: "number", key: "starMass", label: "Star mass", min: 0.1, max: 8, step: 0.1, default: 1, resetOnChange: true, group: "Setup",
      description: "How heavy the starting stars are. Heavier stars make faster, tighter orbits.",
    },
  ],
  macros: [
    { key: "warp", label: "Time warp", description: "Fast-forwards the system into whirling rings and dives through them.",
      targets: [{ param: "timeScale", amount: 0.7 }, { param: "trail", amount: 0.4 }, { param: "zoom", amount: 0.6 }, { param: "spin", amount: 0.2 }] },
    { key: "nebula", label: "Nebula", description: "Thick glowing trails smear into a turning cloud of gas.",
      targets: [{ param: "afterglow", amount: 0.4 }, { param: "trailWidth", amount: 0.6 }, { param: "planetGlow", amount: 0.6 }, { param: "spin", amount: 0.35 }] },
    { key: "chaos", label: "Chaos", description: "Planets pull on each other and a swirling field flings whole systems around.",
      targets: [{ param: "fieldGravity", amount: 0.35 }, { param: "timeScale", amount: 0.2 }, { param: "trail", amount: 0.3 }, { param: "mutual", set: true, at: 0.3 }, { param: "gravityMode", set: "swirl", at: 0.5 }] },
    { key: "spiro", label: "Spirograph", description: "Full-length rainbow trails trace every orbit into a spirograph.",
      targets: [{ param: "trail", amount: 1 }, { param: "timeScale", amount: 0.5 }, { param: "afterglow", amount: -0.4 }, { param: "colours", set: "rainbow", at: 0.5 }] },
  ],
  modulations: [
    { source: "kick", target: "timeScale", amount: 0.2 },
    { source: "bass", target: "trailWidth", amount: 0.2 },
    { source: "lfoBar", target: "trail", amount: 0.3 },
    { source: "treble", target: "planetGlow", amount: 0.2 },
  ],
  reactions: [
    { source: "kick", text: "The sun flares and sends a ripple outward" },
    { source: "snare", text: "Flashes constellation lines between neighbouring planets" },
    { source: "hat", text: "A few planets twinkle" },
    { source: "tone", text: "Planets tuned to the note flare, and a new one is born in its colour; low notes on outer orbits" },
    { source: "bassline", text: "The sun throbs and sends a faint ripple" },
    { source: "chord", text: "Every planet tuned to a note of the chord glows" },
    { source: "bass", text: "The sun swells" },
    { source: "spectrum", text: "Planets glow with their orbit's frequency; the sun's corona traces the waveform" },
    { source: "level", text: "Trails brighten as the music gets louder" },
  ],
  create: () => new OrbitsSim(),
};
