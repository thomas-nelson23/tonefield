import type { ModelDefinition, MusicFrame, NoteEvent, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { noteHash, noteHue } from "./lib/music";
import { Feedback, applyFeedback, colourParam, feedbackParams, schemeHue } from "./lib/visual";
import { gravityAt, gravityModeParam, isUniform } from "./lib/gravity";

interface Boid {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Colour as a unit vector round the hue wheel, so neighbours can average it. */
  hx: number;
  hy: number;
  spark: number;
}

const HUE_BUCKETS = 24;

/**
 * A murmuration of light streaks. Underneath it is Reynolds' boids
 * (separation, alignment, cohesion, on a grid for speed), but every note
 * lures the flock and soaks the nearest birds in its colour, and colour
 * spreads bird to bird through the flock like a rumour. Kicks scatter it,
 * snares spin a vortex through it, and the bass stretches the streaks.
 */
class BoidsSim implements SimulationModel {
  private boids: Boid[] = [];
  private view: Viewport = { width: 1, height: 1 };
  private pointer: { x: number; y: number; repel: boolean } | null = null;
  /** Short-lived pulls toward where recent notes landed. */
  private lures: { x: number; y: number; life: number; strength: number }[] = [];
  private flash = 0;
  private scatter = 160;
  private vortex: { x: number; y: number; life: number; dir: number } | null = null;
  private fb = new Feedback();
  private stepped = false;
  private time = 0;

  reset(view: Viewport, p: ParamValues): void {
    this.view = view;
    this.boids = Array.from({ length: p.count as number }, () => {
      const a = Math.random() * Math.PI * 2;
      const h = ((200 + Math.random() * 60) * Math.PI) / 180;
      return { x: Math.random() * view.width, y: Math.random() * view.height, vx: Math.cos(a) * 60, vy: Math.sin(a) * 60, hx: Math.cos(h), hy: Math.sin(h), spark: 0 };
    });
  }

  resize(view: Viewport): void {
    this.view = view;
  }

  step(dt: number, p: ParamValues, m: MusicFrame): void {
    this.stepped = true;
    const spread = p.colourSpread as number;
    const scheme = p.colours as string;
    // Outside "follow the melody", the scheme slowly tints the flock by position.
    const tint = scheme === "notes" ? 0 : dt * 0.6;
    const radius = p.radius as number;
    const r2 = radius * radius;
    const sepR2 = (radius * 0.4) ** 2;
    const maxSpeed = p.maxSpeed as number;
    const wander = p.wander as number;
    const lurePull = p.lure as number;
    const home = p.home as number;
    const { width, height } = this.view;
    this.time += dt;
    const gMode = p.gravityMode as string, gStrength = p.fieldGravity as number;
    const [ugx, ugy] = isUniform(gMode) ? gravityAt(gMode, gStrength, 0, 0, width, height, this.time) : [0, 0];
    this.scatter = p.scatter as number;

    const cell = Math.max(radius, 8);
    const cols = Math.ceil(width / cell) + 1;
    const grid = new Map<number, Boid[]>();
    for (const b of this.boids) {
      const k = Math.floor(b.y / cell) * cols + Math.floor(b.x / cell);
      const list = grid.get(k);
      if (list) list.push(b);
      else grid.set(k, [b]);
    }

    for (const b of this.boids) {
      let ax = 0, ay = 0, cx = 0, cy = 0, sx = 0, sy = 0, n = 0, hx = 0, hy = 0;
      const gx = Math.floor(b.x / cell);
      const gy = Math.floor(b.y / cell);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const list = grid.get((gy + oy) * cols + gx + ox);
          if (!list) continue;
          for (const o of list) {
            if (o === b) continue;
            const dx = o.x - b.x;
            const dy = o.y - b.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > r2) continue;
            n++;
            ax += o.vx; ay += o.vy;
            hx += o.hx; hy += o.hy;
            cx += o.x; cy += o.y;
            if (d2 < sepR2 && d2 > 0) { sx -= dx / d2; sy -= dy / d2; }
          }
        }
      }
      let fx = 0, fy = 0;
      if (n > 0) {
        fx += (ax / n - b.vx) * (p.alignment as number);
        fy += (ay / n - b.vy) * (p.alignment as number);
        fx += (cx / n - b.x) * (p.cohesion as number);
        fy += (cy / n - b.y) * (p.cohesion as number);
        fx += sx * (p.separation as number) * 1000;
        fy += sy * (p.separation as number) * 1000;
        // Colour spreads from neighbour to neighbour.
        const k = Math.min(1, spread * dt);
        b.hx += (hx / n - b.hx) * k;
        b.hy += (hy / n - b.hy) * k;
      }
      if (tint > 0) {
        const t = (schemeHue(scheme, b.x / width, m.hue, m.beats) * Math.PI) / 180;
        b.hx += (Math.cos(t) - b.hx) * tint;
        b.hy += (Math.sin(t) - b.hy) * tint;
      }
      const hl = Math.hypot(b.hx, b.hy) || 1;
      b.hx /= hl; b.hy /= hl;
      b.spark *= Math.exp(-dt * 5);
      if (this.vortex) {
        const dx = b.x - this.vortex.x, dy = b.y - this.vortex.y;
        const d = Math.hypot(dx, dy) + 30;
        const s = (this.vortex.dir * this.vortex.life * 200000) / (d * d) * 30;
        fx += (-dy / d) * s - (dx / d) * s * 0.3;
        fy += (dx / d) * s - (dy / d) * s * 0.3;
      }
      if (wander > 0) {
        // Random steering, so the flock frays and wobbles.
        fx += (Math.random() - 0.5) * 2 * wander;
        fy += (Math.random() - 0.5) * 2 * wander;
      }
      for (const l of this.lures) {
        const dx = l.x - b.x, dy = l.y - b.y;
        const d = Math.hypot(dx, dy) + 1;
        const s = (l.strength * l.life * 3000 * lurePull) / d;
        fx += (dx / d) * s;
        fy += (dy / d) * s;
      }
      if (isUniform(gMode)) { fx += ugx; fy += ugy; }
      else {
        const [gx2, gy2] = gravityAt(gMode, gStrength, b.x, b.y, width, height, this.time, 60);
        fx += gx2; fy += gy2;
      }
      // A gentle pull home keeps the flock on screen between kicks.
      fx += (width / 2 - b.x) * home;
      fy += (height / 2 - b.y) * home;
      if (this.pointer) {
        const dx = this.pointer.x - b.x;
        const dy = this.pointer.y - b.y;
        const d = Math.hypot(dx, dy) + 1;
        const s = (this.pointer.repel ? -1 : 1) * 4000 / d;
        fx += (dx / d) * s;
        fy += (dy / d) * s;
      }
      b.vx += fx * dt;
      b.vy += fy * dt;
      const speed = Math.hypot(b.vx, b.vy);
      const minSpeed = maxSpeed * 0.3;
      if (speed > maxSpeed) { b.vx *= maxSpeed / speed; b.vy *= maxSpeed / speed; }
      else if (speed < minSpeed && speed > 0) { b.vx *= minSpeed / speed; b.vy *= minSpeed / speed; }
    }

    if (this.vortex && (this.vortex.life -= dt * 1.4) <= 0) this.vortex = null;
    for (const l of this.lures) l.life -= dt * 1.5;
    this.lures = this.lures.filter((l) => l.life > 0);

    for (const b of this.boids) {
      b.x = (b.x + b.vx * dt + width) % width;
      b.y = (b.y + b.vy * dt + height) % height;
    }
  }

  onPointer(input: PointerInput): void {
    this.pointer = input.pressed && input.type !== "up"
      ? { x: input.x, y: input.y, repel: input.button === 2 || input.shift }
      : null;
  }

  onNote(ev: NoteEvent): void {
    const { width, height } = this.view;
    if (ev.role === "tone") {
      // The flock chases each note, placed left to right by pitch, and the birds nearest it take its colour.
      const lx = width * (0.1 + ev.x * 0.8), ly = height * (0.2 + noteHash(ev.note) * 0.6);
      this.lures.push({ x: lx, y: ly, life: 1, strength: ev.velocity });
      if (this.lures.length > 6) this.lures.shift();
      const h = (noteHue(ev.note) * Math.PI) / 180;
      const r2 = (Math.min(width, height) * 0.22) ** 2;
      for (const b of this.boids) {
        if ((b.x - lx) ** 2 + (b.y - ly) ** 2 > r2) continue;
        b.hx = Math.cos(h); b.hy = Math.sin(h);
        b.spark = ev.velocity;
      }
    } else if (ev.role === "kick") {
      // Scatter outward from the centre.
      for (const b of this.boids) {
        const dx = b.x - width / 2, dy = b.y - height / 2;
        const d = Math.hypot(dx, dy) + 1;
        b.vx += (dx / d) * this.scatter * ev.velocity;
        b.vy += (dy / d) * this.scatter * ev.velocity;
      }
      this.flash = ev.velocity;
    } else if (ev.role === "snare") {
      // A vortex spins up somewhere and drags the flock round, turning the other way each time.
      this.vortex = { x: width * (0.2 + Math.random() * 0.6), y: height * (0.2 + Math.random() * 0.6), life: ev.velocity, dir: this.vortex ? -this.vortex.dir : 1 };
      this.flash = Math.max(this.flash, ev.velocity * 0.5);
    } else if (ev.role === "bassline") {
      // A low lure along the bottom, placed by pitch, that drags the flock down.
      this.lures.push({ x: width * (0.15 + ev.x * 0.7), y: height * 0.82, life: 1, strength: ev.velocity * 0.6 });
      if (this.lures.length > 6) this.lures.shift();
    } else if (ev.role === "chord") {
      // A share of the flock takes the chord's colours.
      const notes = ev.notes ?? [ev.note];
      for (let k = 0; k < this.boids.length * 0.3 * ev.velocity; k++) {
        const b = this.boids[Math.floor(Math.random() * this.boids.length)];
        const h = (noteHue(notes[k % notes.length]) * Math.PI) / 180;
        b.hx = Math.cos(h); b.hy = Math.sin(h);
        b.spark = Math.max(b.spark, ev.velocity * 0.3);
      }
    } else {
      for (let k = 0; k < this.boids.length * 0.1; k++) this.boids[Math.floor(Math.random() * this.boids.length)].spark = ev.velocity;
    }
  }

  render(g: CanvasRenderingContext2D, view: Viewport, p: ParamValues, m: MusicFrame): void {
    applyFeedback(this.fb, g, view, p, this.stepped);
    this.stepped = false;
    const z = p.size as number;
    const streak = (p.streak as number) * (1 + Math.min(1.5, m.bass) * 1.2);
    this.flash *= 0.9;
    const light = 48 + this.flash * 20 + Math.min(1, m.level) * 8;
    // Streaks, batched by hue so each colour is one stroke.
    const paths = Array.from({ length: HUE_BUCKETS }, () => new Path2D());
    const sparks = new Path2D();
    for (const b of this.boids) {
      const hue = ((Math.atan2(b.hy, b.hx) * 180) / Math.PI + 360) % 360;
      const path = paths[Math.floor(hue / (360 / HUE_BUCKETS)) % HUE_BUCKETS];
      path.moveTo(b.x - b.vx * 0.06 * streak, b.y - b.vy * 0.06 * streak);
      path.lineTo(b.x, b.y);
      if (b.spark > 0.1) sparks.rect(b.x - 1.5 * z, b.y - 1.5 * z, 3 * z, 3 * z);
    }
    g.globalCompositeOperation = "lighter";
    g.lineCap = "round";
    g.lineWidth = 1.6 * z;
    for (let i = 0; i < HUE_BUCKETS; i++) {
      g.strokeStyle = `hsla(${(i + 0.5) * (360 / HUE_BUCKETS)} 90% ${light}% / 0.5)`;
      g.stroke(paths[i]);
    }
    g.fillStyle = `rgba(255,255,255,${0.6 + m.treble * 0.4})`;
    g.fill(sparks);
    g.lineWidth = 1;
    g.lineCap = "butt";
    g.globalCompositeOperation = "source-over";
  }

  stats(): string {
    return `${this.boids.length} boids`;
  }
}

export const boids: ModelDefinition = {
  id: "boids",
  name: "Murmuration",
  category: "Particles",
  description: "A flock of light streaks. It chases every melody note, and the birds nearest the note take its colour, which then spreads through the flock bird to bird. Kicks scatter it, snares spin vortices through it, and the bass stretches the streaks.",
  hint: "Hold the mouse to draw the flock in. Right-click or Shift to scatter it.",
  fixedDt: 1 / 60,
  paintsBackground: true,
  params: [
    { kind: "number", key: "separation", label: "Separation", min: 0, max: 15, step: 0.1, default: 1.5, group: "Behaviour",
      description: "How hard birds avoid crowding. High values spread the flock into a lattice." },
    { kind: "number", key: "alignment", label: "Alignment", min: 0, max: 10, step: 0.1, default: 1.2, group: "Behaviour",
      description: "How much birds match their neighbours' heading. High values form rivers of light." },
    { kind: "number", key: "cohesion", label: "Cohesion", min: 0, max: 15, step: 0.1, default: 0.8, group: "Behaviour",
      description: "How strongly birds steer to the middle of their group. High values make tight balls." },
    { kind: "number", key: "radius", label: "Vision radius", min: 5, max: 200, step: 1, default: 40, group: "Behaviour",
      description: "How far each bird can see. Small makes many little groups, large one big flock." },
    { kind: "number", key: "maxSpeed", label: "Max speed", min: 20, max: 900, step: 5, default: 160, group: "Motion", global: "energy",
      description: "Top speed. Birds never drop below about a third of it." },
    { kind: "number", key: "wander", label: "Wander", min: 0, max: 1500, step: 10, default: 0, group: "Motion", global: "energy",
      description: "Random steering that makes the flock jitter and fray apart." },
    { kind: "number", key: "lure", label: "Note pull", min: 0, max: 5, step: 0.1, default: 1.2, group: "Music",
      description: "How strongly the flock chases each melody note." },
    { kind: "number", key: "home", label: "Centre pull", min: 0, max: 5, step: 0.05, default: 0.6, group: "Motion",
      description: "How strongly the flock is drawn back to the middle of the screen. Zero lets it roam and wrap round the edges." },
    { kind: "number", key: "scatter", label: "Kick scatter", min: 0, max: 800, step: 10, default: 180, group: "Music", global: "energy",
      description: "How hard a kick drum blasts the flock outward from the centre." },
    { kind: "number", key: "colourSpread", label: "Colour spread", min: 0, max: 10, step: 0.1, default: 1.5, group: "Music",
      description: "How fast a note's colour passes from bird to bird. Zero keeps each bird the colour it was given." },
    gravityModeParam("off", undefined, { description: "A pull on every bird. Swirl turns the flock into a whirlpool; Down makes it pour like rain." }),
    { kind: "number", key: "fieldGravity", label: "Field strength", min: 0, max: 1500, step: 10, default: 300, group: "Gravity", global: "gravity",
      description: "How hard the gravity field pulls the birds. Strong fields overpower the flocking." },
    colourParam("notes"),
    { kind: "number", key: "streak", label: "Streak length", min: 0, max: 6, step: 0.05, default: 1.2, group: "Look", global: "size",
      description: "How long a streak each bird draws behind it. The bass stretches it further." },
    { kind: "number", key: "size", label: "Line width", min: 0.4, max: 5, step: 0.1, default: 1, group: "Look", global: "size",
      description: "How thick each streak is." },
    ...feedbackParams(0.8, 0, 0),
    { kind: "number", key: "count", label: "Birds", min: 10, max: 4000, step: 10, default: 900, resetOnChange: true, group: "Setup",
      description: "How many birds. Rebuilds the flock." },
  ],
  macros: [
    { key: "swarm", label: "Swarm", description: "Packs the whole flock into one dense, pulsing ball.",
      targets: [{ param: "cohesion", amount: 0.8 }, { param: "alignment", amount: 0.6 }, { param: "separation", amount: -0.3 }, { param: "radius", amount: 0.5 }, { param: "home", amount: 0.3 }] },
    { key: "panic", label: "Panic", description: "Blows the flock apart into a frantic, jittering spray.",
      targets: [{ param: "separation", amount: 0.8 }, { param: "maxSpeed", amount: 0.8 }, { param: "wander", amount: 0.7 }, { param: "alignment", amount: -0.6 }, { param: "scatter", amount: 0.5 }] },
    { key: "dream", label: "Dream", description: "Slow, long streaks melt into a spiralling tunnel.",
      targets: [{ param: "afterglow", amount: 0.2 }, { param: "zoom", amount: 0.6 }, { param: "spin", amount: 0.4 }, { param: "streak", amount: 0.6 }, { param: "maxSpeed", amount: -0.1 }] },
    { key: "whirl", label: "Whirlpool", description: "Sucks the flock into a rainbow whirlpool round the centre.",
      targets: [{ param: "fieldGravity", amount: 0.6 }, { param: "alignment", amount: 0.3 }, { param: "home", amount: -0.3 }, { param: "gravityMode", set: "swirl", at: 0.15 }, { param: "colours", set: "rainbow", at: 0.6 }] },
  ],
  modulations: [
    { source: "kick", target: "maxSpeed", amount: 0.35 },
    { source: "tone", target: "alignment", amount: 0.3 },
    { source: "lfoBar", target: "cohesion", amount: 0.25 },
    { source: "treble", target: "size", amount: 0.2 },
  ],
  reactions: [
    { source: "tone", text: "The flock chases the note, placed by pitch, and nearby birds take its colour" },
    { source: "kick", text: "Blasts the flock outward from the centre and flashes it" },
    { source: "snare", text: "Spins a vortex through the flock, alternating direction" },
    { source: "hat", text: "A sprinkling of birds sparkle" },
    { source: "bassline", text: "A low lure along the bottom, placed by pitch, drags the flock down" },
    { source: "chord", text: "A share of the flock takes the chord's colours" },
    { source: "bass", text: "Stretches the streaks" },
    { source: "level", text: "The flock glows brighter as the music gets louder" },
    { source: "treble", text: "Sparkles shine brighter" },
  ],
  create: () => new BoidsSim(),
};
