import type { ModelDefinition, MusicFrame, NoteEvent, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { noteHue } from "./lib/music";
import { gravityAt, gravityModeParam, isUniform, uniformDir } from "./lib/gravity";
import { Feedback, applyFeedback, colourParam, feedbackParams, glowSprite, hueToward, schemeHue } from "./lib/visual";

/** Sparks thrown off by notes live this long, in seconds, at most. */
const SPARK_LIFE = 2.2;
const MAX_SPARKS = 2500;
/** Coarse grid for mutual gravity: each particle feels every cell's mass instead of every other particle. */
const MESH = 12;

interface Shock {
  x: number;
  y: number;
  r: number;
  speed: number;
  life: number;
  hue: number;
  /** Velocity added per step to particles inside the front. */
  punch: number;
}

/**
 * A cloud of glowing particles held on a ring that breathes with the bass
 * and bulges into the shape of the spectrum, so the ring reads as a radial
 * equaliser made of light. Kicks blast shockwaves through it, snares and
 * notes throw off coloured sparks.
 */
class ParticleBloom implements SimulationModel {
  private n = 0;
  private x = new Float32Array(0);
  private y = new Float32Array(0);
  private vx = new Float32Array(0);
  private vy = new Float32Array(0);
  private hue = new Float32Array(0);
  /** Seconds left for sparks; -1 for the permanent cloud. */
  private life = new Float32Array(0);
  /** Brief extra brightness from hi-hats. */
  private flare = new Float32Array(0);
  private base = 0;
  private view: Viewport = { width: 1, height: 1 };
  private shocks: Shock[] = [];
  private pointer: { x: number; y: number; repel: boolean } | null = null;
  private time = 0;
  private stepped = false;
  private fb = new Feedback();
  private scheme = "notes";
  private beats = 0;
  private noteHueNow = 210;

  reset(view: Viewport, p: ParamValues): void {
    this.view = view;
    this.base = p.count as number;
    const cap = this.base + MAX_SPARKS;
    this.x = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.vx = new Float32Array(cap);
    this.vy = new Float32Array(cap);
    this.hue = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.flare = new Float32Array(cap);
    this.n = this.base;
    const cx = view.width / 2, cy = view.height / 2, R = this.ringRadius(p, 0);
    for (let i = 0; i < this.base; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = R * (0.6 + Math.random() * 0.8);
      this.x[i] = cx + Math.cos(a) * r;
      this.y[i] = cy + Math.sin(a) * r;
      this.vx[i] = -Math.sin(a) * 60;
      this.vy[i] = Math.cos(a) * 60;
      this.hue[i] = 200 + Math.random() * 60;
      this.life[i] = -1;
    }
    this.shocks = [];
  }

  resize(view: Viewport): void {
    this.view = view;
  }

  private ringRadius(p: ParamValues, bass: number): number {
    return Math.min(this.view.width, this.view.height) * (p.ringSize as number) * (1 + bass * (p.breath as number));
  }

  private spark(x: number, y: number, vx: number, vy: number, hue: number): void {
    let i = this.n;
    if (i >= this.x.length) {
      // Full: recycle the oldest-looking spark (the one with least life left).
      let best = this.base, low = Infinity;
      for (let k = this.base; k < this.n; k += 7) if (this.life[k] < low) { low = this.life[k]; best = k; }
      i = best;
    } else {
      this.n++;
    }
    this.x[i] = x; this.y[i] = y; this.vx[i] = vx; this.vy[i] = vy;
    this.hue[i] = hue;
    this.life[i] = SPARK_LIFE * (0.5 + Math.random() * 0.5);
    this.flare[i] = 1;
  }

  private burst(x: number, y: number, count: number, speed: number, hue: number, spread = 40): void {
    for (let k = 0; k < count; k++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.7);
      this.spark(x, y, Math.cos(a) * s, Math.sin(a) * s, hue + (Math.random() - 0.5) * spread);
    }
  }

  step(dt: number, p: ParamValues, m: MusicFrame): void {
    this.stepped = true;
    this.time += dt;
    this.scheme = p.colours as string;
    this.beats = m.beats;
    this.noteHueNow = m.hue;
    const { width: w, height: h } = this.view;
    const cx = w / 2, cy = h / 2;
    const R = this.ringRadius(p, Math.min(1.5, m.bass));
    const ringK = (p.ringPull as number) * 4;
    const shape = (p.spectrumPush as number) * R * 0.5;
    const spec = m.spectrum;
    const bins = spec.length;
    const mode = p.gravityMode as string;
    const fg = p.fieldGravity as number;
    const uniform = isUniform(mode);
    const [ux, uy] = uniformDir(mode, this.time);
    const damping = Math.max(0, 1 - (p.damping as number) * dt);
    const G = p.gravity as number;

    // Mutual gravity on a coarse mesh: total mass and centroid per cell.
    let mass: Float32Array | null = null, mx: Float32Array | null = null, my: Float32Array | null = null;
    if (G > 0) {
      mass = new Float32Array(MESH * MESH); mx = new Float32Array(MESH * MESH); my = new Float32Array(MESH * MESH);
      for (let i = 0; i < this.n; i++) {
        const gx = Math.min(MESH - 1, Math.max(0, Math.floor((this.x[i] / w) * MESH)));
        const gy = Math.min(MESH - 1, Math.max(0, Math.floor((this.y[i] / h) * MESH)));
        const c = gy * MESH + gx;
        mass[c]++; mx[c] += this.x[i]; my[c] += this.y[i];
      }
      for (let c = 0; c < mass.length; c++) if (mass[c] > 0) { mx[c] /= mass[c]; my[c] /= mass[c]; }
    }

    const { x, y, vx, vy, life, flare, hue } = this;
    for (let i = 0; i < this.n; i++) {
      let ax = 0, ay = 0;
      const dx = x[i] - cx, dy = y[i] - cy;
      const r = Math.hypot(dx, dy) || 1;
      if (life[i] < 0) {
        // Spring toward the ring, pushed out where the spectrum is loud. Low notes sit at the
        // bottom, mirrored left and right, so the ring reads like a round equaliser.
        const ang = Math.atan2(dx, dy); // 0 pointing down
        const t = Math.abs(ang) / Math.PI;
        const target = R + spec[Math.min(bins - 1, Math.floor(t * bins))] * shape;
        const pull = -ringK * (r - target);
        ax += (dx / r) * pull;
        ay += (dy / r) * pull;
      }
      if (fg > 0) {
        if (uniform) { ax += ux * fg; ay += uy * fg; }
        else {
          const [gx, gy] = gravityAt(mode, fg, x[i], y[i], w, h, this.time, 60);
          ax += gx; ay += gy;
        }
      }
      if (mass) {
        for (let c = 0; c < mass.length; c++) {
          if (mass[c] === 0) continue;
          const ex = mx![c] - x[i], ey = my![c] - y[i];
          const d2 = ex * ex + ey * ey + 2500;
          const f = (G * 500 * mass[c]) / (d2 * Math.sqrt(d2));
          ax += ex * f; ay += ey * f;
        }
      }
      if (this.pointer) {
        const ex = this.pointer.x - x[i], ey = this.pointer.y - y[i];
        const d = Math.hypot(ex, ey) + 20;
        const f = (this.pointer.repel ? -1 : 1) * 90000 / d;
        ax += (ex / d) * f; ay += (ey / d) * f;
      }
      vx[i] = (vx[i] + ax * dt) * damping;
      vy[i] = (vy[i] + ay * dt) * damping;
      x[i] += vx[i] * dt;
      y[i] += vy[i] * dt;
      flare[i] *= Math.exp(-dt * 6);
      if (life[i] < 0) {
        // The cloud slowly takes on the colour scheme, by angle round the ring.
        const t = (Math.atan2(dy, dx) / Math.PI + 1) / 2;
        hue[i] = hueToward(hue[i], schemeHue(this.scheme, t, m.hue, m.beats), dt * 1.5);
        // Anything flung far off screen comes back onto the ring.
        if (x[i] < -w * 0.5 || x[i] > w * 1.5 || y[i] < -h * 0.5 || y[i] > h * 1.5) {
          const a = Math.random() * Math.PI * 2;
          x[i] = cx + Math.cos(a) * R; y[i] = cy + Math.sin(a) * R;
          vx[i] = 0; vy[i] = 0;
        }
      } else {
        life[i] -= dt;
      }
    }

    // Drop dead sparks by swapping the last one in.
    for (let i = this.base; i < this.n; i++) {
      if (life[i] > 0) continue;
      const j = --this.n;
      x[i] = x[j]; y[i] = y[j]; vx[i] = vx[j]; vy[i] = vy[j]; hue[i] = hue[j]; life[i] = life[j]; flare[i] = flare[j];
      i--;
    }

    // Shockwaves expand and fade, pushing whatever they pass.
    for (const s of this.shocks) {
      const prev = s.r;
      s.r += s.speed * dt;
      s.life -= dt * 1.2;
      // Applied each step the front passes a particle, so it stays small per step.
      const push = s.punch * s.life;
      for (let i = 0; i < this.n; i++) {
        const dx = x[i] - s.x, dy = y[i] - s.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d < prev || d > s.r) continue;
        vx[i] += (dx / d) * push;
        vy[i] += (dy / d) * push;
      }
    }
    this.shocks = this.shocks.filter((s) => s.life > 0);
  }

  onNote(ev: NoteEvent, p: ParamValues): void {
    const { width: w, height: h } = this.view;
    const cx = w / 2, cy = h / 2;
    const sparks = p.sparks as number;
    const punch = p.punch as number;
    if (ev.role === "kick") {
      this.shocks.push({ x: cx, y: cy, r: 0, speed: 900, punch: 90 * punch * ev.velocity, life: 1, hue: schemeHue(this.scheme, 0.2, this.noteHueNow, this.beats) });
      if (this.shocks.length > 4) this.shocks.shift();
    } else if (ev.role === "snare") {
      const a = Math.random() * Math.PI * 2;
      const R = this.ringRadius(p, 0);
      const hue = schemeHue(this.scheme, Math.random(), this.noteHueNow, this.beats) + 180;
      this.burst(cx + Math.cos(a) * R, cy + Math.sin(a) * R, Math.round(sparks * 1.5 * ev.velocity), 500 * punch, hue, 60);
    } else if (ev.role === "hat") {
      for (let k = 0; k < this.base * 0.08; k++) this.flare[Math.floor(Math.random() * this.base)] = ev.velocity;
    } else if (ev.role === "bassline") {
      // A slow, soft shockwave in the bass note's colour.
      this.shocks.push({ x: cx, y: cy, r: 0, speed: 420, punch: 30 * punch * ev.velocity, life: 0.8, hue: noteHue(ev.note) });
      if (this.shocks.length > 4) this.shocks.shift();
    } else if (ev.role === "chord") {
      // The chord dyes a share of the ring in its notes' colours, which then drift back.
      const notes = ev.notes ?? [ev.note];
      for (let k = 0; k < this.base * 0.3 * ev.velocity; k++) {
        const i = Math.floor(Math.random() * this.base);
        this.hue[i] = noteHue(notes[k % notes.length]);
        this.flare[i] = Math.max(this.flare[i], ev.velocity * 0.5);
      }
    } else {
      // A fountain from the ring, at an angle set by pitch: low notes at the bottom, rising round both sides.
      const R = this.ringRadius(p, 0);
      const side = Math.random() < 0.5 ? -1 : 1;
      const a = Math.PI / 2 - side * ev.x * Math.PI;
      const ox = cx + Math.cos(a) * R, oy = cy + Math.sin(a) * R;
      const hue = noteHue(ev.note);
      const count = Math.round(sparks * (0.4 + ev.velocity));
      for (let k = 0; k < count; k++) {
        const spread = a + (Math.random() - 0.5) * 0.7;
        const s = (200 + Math.random() * 350) * punch;
        this.spark(ox, oy, Math.cos(spread) * s, Math.sin(spread) * s, hue + (Math.random() - 0.5) * 20);
      }
    }
  }

  onPointer(input: PointerInput, p: ParamValues): void {
    if (input.type === "down" && input.button === 0 && !input.shift) {
      this.burst(input.x, input.y, Math.max(10, p.sparks as number), 450, schemeHue(this.scheme, Math.random(), this.noteHueNow, this.beats));
    }
    this.pointer = input.pressed && input.type !== "up"
      ? { x: input.x, y: input.y, repel: input.button === 2 || input.shift }
      : null;
  }

  render(g: CanvasRenderingContext2D, view: Viewport, p: ParamValues, m: MusicFrame): void {
    applyFeedback(this.fb, g, view, p, this.stepped);
    this.stepped = false;
    g.globalCompositeOperation = "lighter";
    const size = (p.size as number) * (1 + Math.min(1.5, m.energy) * 0.35 + m.pulse * 0.15);
    const { x, y, hue, life, flare } = this;
    for (let i = 0; i < this.n; i++) {
      const fade = life[i] < 0 ? 0.55 : Math.min(1, life[i] / (SPARK_LIFE * 0.4));
      const s = size * (6 + flare[i] * 10) * (life[i] < 0 ? 1 : 0.8 + fade * 0.4);
      g.globalAlpha = Math.min(1, fade + flare[i] * 0.5);
      g.drawImage(glowSprite(hue[i]), x[i] - s, y[i] - s, s * 2, s * 2);
    }
    g.globalAlpha = 1;
    for (const s of this.shocks) {
      g.beginPath();
      g.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      g.lineWidth = 2 + s.life * 6;
      g.strokeStyle = `hsla(${s.hue} 90% 65% / ${s.life * 0.6})`;
      g.stroke();
    }
    g.lineWidth = 1;
    g.globalCompositeOperation = "source-over";
  }

  stats(): string {
    return `${this.base} particles · ${this.n - this.base} sparks`;
  }
}

export const particles: ModelDefinition = {
  id: "particles",
  name: "Particle bloom",
  category: "Particles",
  description: "A ring of glowing particles that breathes with the bass and bulges into the shape of the spectrum, like a round equaliser made of light. Kicks send shockwaves through it; notes and snares throw off coloured sparks.",
  hint: "Click to throw sparks; hold to pull the particles in. Right-drag or Shift-drag pushes them away. Start the sequencer or play a song to bring it to life.",
  fixedDt: 1 / 60,
  paintsBackground: true,
  params: [
    { kind: "number", key: "ringSize", label: "Ring size", min: 0, max: 0.6, step: 0.01, default: 0.2, group: "Shape",
      description: "How big the ring is, as a share of the screen. Zero gathers everything into one bright core." },
    { kind: "number", key: "breath", label: "Bass breathing", min: 0, max: 3, step: 0.05, default: 0.5, group: "Shape", global: "energy",
      description: "How much the ring swells with the bass. High values make it pump hard on every bass note." },
    { kind: "number", key: "spectrumPush", label: "Spectrum shape", min: 0, max: 3, step: 0.05, default: 1, group: "Shape",
      description: "How far loud frequencies push the ring out. Bass at the bottom, treble at the top." },
    { kind: "number", key: "ringPull", label: "Ring pull", min: 0, max: 40, step: 0.5, default: 6, group: "Shape",
      description: "How tightly particles cling to the ring. Low lets them drift into a loose cloud." },
    gravityModeParam("swirl", undefined, { description: "An extra pull on every particle. Swirl spins the ring; Down pours it like a waterfall." }),
    { kind: "number", key: "fieldGravity", label: "Field strength", min: 0, max: 1500, step: 10, default: 120, group: "Gravity", global: "gravity",
      description: "How hard the gravity field pulls. Strong swirl makes the ring race round." },
    { kind: "number", key: "gravity", label: "Mutual gravity", min: 0, max: 3000, step: 10, default: 0, group: "Gravity",
      description: "How strongly the particles pull on each other, clumping the ring into beads." },
    { kind: "number", key: "punch", label: "Hit punch", min: 0, max: 4, step: 0.05, default: 1, group: "Music", global: "energy",
      description: "How hard kicks blast the shockwave and how fast sparks fly." },
    { kind: "number", key: "sparks", label: "Sparks per note", min: 0, max: 300, step: 5, default: 50, group: "Music",
      description: "How many sparks each melody note or snare throws off." },
    { kind: "number", key: "damping", label: "Air drag", min: 0, max: 6, step: 0.05, default: 1.2, group: "Motion",
      description: "Slows everything down. Low keeps sparks flying across the whole screen." },
    colourParam("notes"),
    { kind: "number", key: "size", label: "Glow size", min: 0.2, max: 5, step: 0.05, default: 1, group: "Look", global: "size",
      description: "How big each particle's glow is. Big glows melt together into clouds of light." },
    ...feedbackParams(0.82, 0, 0),
    { kind: "number", key: "count", label: "Particles", min: 0, max: 5000, step: 50, default: 1400, resetOnChange: true, group: "Setup",
      description: "How many particles make up the ring. Changing it restarts the scene." },
  ],
  macros: [
    { key: "hyper", label: "Hyperspace", description: "Flies through a spiralling tunnel of light while the ring races round.",
      targets: [{ param: "zoom", amount: 0.9 }, { param: "spin", amount: 0.3 }, { param: "afterglow", amount: 0.15 }, { param: "fieldGravity", amount: 0.6 }, { param: "gravityMode", set: "swirl", at: 0.2 }] },
    { key: "implode", label: "Implode", description: "Crushes the ring into one blazing core that clumps and pulses.",
      targets: [{ param: "ringSize", amount: -1 }, { param: "gravity", amount: 0.6 }, { param: "size", amount: 0.4 }, { param: "breath", amount: 0.4 }, { param: "gravityMode", set: "center", at: 0.4 }] },
    { key: "nova", label: "Supernova", description: "Every hit explodes: huge shockwaves and showers of sparks that fly across the screen.",
      targets: [{ param: "punch", amount: 0.8 }, { param: "sparks", amount: 0.8 }, { param: "breath", amount: 0.6 }, { param: "spectrumPush", amount: 0.6 }, { param: "damping", amount: -0.2 }, { param: "afterglow", amount: 0.1 }] },
    { key: "fall", label: "Waterfall", description: "Lets go of the ring and pours the light down the screen in long smoky streams.",
      targets: [{ param: "ringPull", amount: -0.9 }, { param: "fieldGravity", amount: 0.5 }, { param: "damping", amount: -0.15 }, { param: "afterglow", amount: 0.15 }, { param: "gravityMode", set: "down", at: 0.15 }] },
  ],
  modulations: [
    { source: "kick", target: "zoom", amount: 0.15 },
    { source: "lfoBar", target: "spin", amount: 0.1 },
    { source: "treble", target: "size", amount: 0.15 },
    { source: "snare", target: "fieldGravity", amount: 0.25 },
  ],
  reactions: [
    { source: "kick", text: "A glowing shockwave from the centre that blasts the ring outward" },
    { source: "snare", text: "A burst of sparks from a random point on the ring" },
    { source: "hat", text: "A scattering of particles flares bright" },
    { source: "tone", text: "A fountain of sparks in the note's colour; low notes from the bottom of the ring" },
    { source: "bassline", text: "A slow, soft shockwave in the bass note's colour" },
    { source: "chord", text: "Dyes part of the ring in the chord's colours, which drift back" },
    { source: "bass", text: "The ring swells and shrinks (Bass breathing)" },
    { source: "spectrum", text: "Loud frequencies bulge the ring out (Spectrum shape)" },
    { source: "level", text: "Loud passages make every glow bigger" },
    { source: "beat", text: "Glows swell a little on each beat" },
  ],
  create: () => new ParticleBloom(),
};
