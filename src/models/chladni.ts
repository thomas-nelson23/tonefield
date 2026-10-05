import type { ModelDefinition, MusicFrame, NoteEvent, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { Feedback, applyFeedback, colourParam, feedbackParams, hueToward, schemeHue } from "./lib/visual";
import { gravityAt, gravityModeParam, isUniform } from "./lib/gravity";

/**
 * Vibration modes of a square plate, (n, m, sign), ordered roughly by pitch.
 * The plate's displacement in mode (n, m) is
 *   cos(nπx)cos(mπy) ± cos(mπx)cos(nπy)
 * which is the classic approximation Chladni figures are drawn from.
 */
const SQUARE: [number, number, number][] = [];
for (let n = 1; n <= 8; n++) {
  for (let m = n + 1; m <= 9; m++) {
    SQUARE.push([n, m, -1]);
    SQUARE.push([n, m, 1]);
  }
}
SQUARE.sort((a, b) => a[0] ** 2 + a[1] ** 2 - (b[0] ** 2 + b[1] ** 2));

/**
 * Modes of a round plate, (spokes, rings, 0): cos(nθ)·cos(mπr) has n
 * straight nodal diameters and m nodal circles, which draws mandalas.
 */
const ROUND: [number, number, number][] = [];
for (let n = 2; n <= 14; n++) for (let m = 1; m <= 5; m++) ROUND.push([n, m, 0]);
ROUND.sort((a, b) => a[0] + a[1] * 3 - (b[0] + b[1] * 3));

/** Seconds a new mode takes to fade in over the old one. */
const MORPH = 0.35;

/**
 * Cymatics: sand on a vibrating plate is thrown off the parts that move and
 * collects along the nodal lines that stay still. Each note rings the plate
 * in a new mode and the glowing sand morphs from one figure to the next, so a
 * melody draws a sequence of patterns. The round plate turns slowly, and
 * drums and loudness shake the sand loose.
 */
class CymaticsSim implements SimulationModel {
  private gx = new Float32Array(0);
  private gy = new Float32Array(0);
  /** How hard each grain's spot is moving, 0..1, for colouring. */
  private amp = new Float32Array(0);
  private view: Viewport = { width: 1, height: 1 };
  private mode = 0;
  private prevMode = 0;
  /** 0..1 progress of the morph from `prevMode` to `mode`. */
  private morph = 1;
  private lastParamMode = -1;
  private shake = 0;
  private hue = 45;
  private rot = 0;
  private round = false;
  private pointer: { x: number; y: number } | null = null;
  private fb = new Feedback();
  private stepped = false;
  private time = 0;

  reset(view: Viewport, p: ParamValues): void {
    this.view = view;
    const n = p.grains as number;
    this.gx = new Float32Array(n);
    this.gy = new Float32Array(n);
    this.amp = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.gx[i] = Math.random();
      this.gy[i] = Math.random();
    }
    this.mode = this.prevMode = p.mode as number;
    this.lastParamMode = this.mode;
    this.morph = 1;
  }

  resize(view: Viewport): void {
    this.view = view;
  }

  private modes(): [number, number, number][] {
    return this.round ? ROUND : SQUARE;
  }

  /** The plate: a centred square (or the circle inside it), in CSS pixels. */
  private plate(): [number, number, number] {
    const s = Math.min(this.view.width, this.view.height) * 0.92;
    return [(this.view.width - s) / 2, (this.view.height - s) / 2, s];
  }

  /**
   * Displacement of mode `k` at plate coordinates (x, y) in 0..1, and its
   * slope, written into `out` as [a, da/dx, da/dy].
   */
  private wave(k: number, x: number, y: number, out: Float64Array): void {
    const list = this.modes();
    const [n, m, sign] = list[k % list.length];
    const PI = Math.PI;
    if (!this.round) {
      const X = PI * x, Y = PI * y;
      const cnx = Math.cos(n * X), cmx = Math.cos(m * X), cny = Math.cos(n * Y), cmy = Math.cos(m * Y);
      out[0] = cnx * cmy + sign * cmx * cny;
      out[1] = PI * (-n * Math.sin(n * X) * cmy - sign * m * Math.sin(m * X) * cny);
      out[2] = PI * (-m * cnx * Math.sin(m * Y) - sign * n * cmx * Math.sin(n * Y));
      return;
    }
    // Polar: a = cos(nθ + turn)·cos(mπr) on u, v in -1..1.
    const u = 2 * x - 1, v = 2 * y - 1;
    const r2 = Math.max(1e-4, u * u + v * v), r = Math.sqrt(r2);
    const th = n * Math.atan2(v, u) + this.rot;
    const ct = Math.cos(th), cr = Math.cos(m * PI * r);
    const ar = -ct * m * PI * Math.sin(m * PI * r);
    const at = -n * Math.sin(th) * cr;
    out[0] = ct * cr;
    out[1] = 2 * ((u / r) * ar - (v / r2) * at);
    out[2] = 2 * ((v / r) * ar + (u / r2) * at);
  }

  private f1 = new Float64Array(3);
  private f2 = new Float64Array(3);

  /** The plate's displacement and slope, blending the old mode into the new one while it morphs. */
  private field(x: number, y: number): Float64Array {
    const a = this.f1;
    this.wave(this.mode, x, y, a);
    if (this.morph >= 1) return a;
    const b = this.f2, t = this.morph;
    this.wave(this.prevMode, x, y, b);
    a[0] = a[0] * t + b[0] * (1 - t);
    a[1] = a[1] * t + b[1] * (1 - t);
    a[2] = a[2] * t + b[2] * (1 - t);
    return a;
  }

  /** Roughly how many wavelengths cross the plate in the current mode, to keep the descent stable. */
  private busyness(): number {
    const list = this.modes();
    const [n, m] = list[this.mode % list.length];
    return this.round ? 2 * (n * 0.5 + m) + 1 : n + m;
  }

  private setMode(k: number): void {
    if (k === this.mode) return;
    this.prevMode = this.mode;
    this.mode = k;
    this.morph = 0;
  }

  step(dt: number, p: ParamValues, music: MusicFrame): void {
    this.stepped = true;
    const round = p.plate === "round";
    if (round !== this.round) {
      this.round = round;
      this.prevMode = this.mode;
      this.morph = 1;
    }
    // The slider wins whenever it moves; notes take over otherwise.
    if (p.mode !== this.lastParamMode) {
      this.setMode(p.mode as number);
      this.lastParamMode = p.mode as number;
    }
    this.morph = Math.min(1, this.morph + dt / MORPH);
    this.rot += dt * (p.turn as number) * (Math.PI / 180) * (1 + Math.min(1.5, music.level));

    const amp = (p.vibration as number) * (1 + Math.min(1.5, music.level) * (p.loudShake as number)) + this.shake;
    this.shake *= Math.exp(-dt * 4);
    const busy = this.busyness();
    // Gradient descent toward the nodal lines overshoots (and the sand jitters across the line)
    // once the per-step gain passes ~1, which happens sooner on busy modes, so cap the step.
    const pull = Math.min((p.settle as number) * dt * 0.25, 0.9 / (Math.PI * busy));
    const jitter = amp * dt * 0.05;
    const drift = (0.15 + (p.vibration as number) * 0.25) * dt;
    const norm = 1 / (Math.PI * busy);
    const { gx, gy } = this;
    // Gravity tilts the plate: sand slides that way, and only the nodal lines hold it back.
    this.time += dt;
    const gMode = p.gravityMode as string, gPull = (p.fieldGravity as number) * dt;
    const tilted = gMode !== "off" && gPull > 0;
    const uniform = isUniform(gMode);
    const [ugx, ugy] = uniform ? gravityAt(gMode, gPull, 0, 0, 1, 1, this.time) : [0, 0];
    let px = -1, py = -1;
    if (this.pointer) {
      const [ox, oy, s] = this.plate();
      px = (this.pointer.x - ox) / s;
      py = (this.pointer.y - oy) / s;
    }
    for (let i = 0; i < gx.length; i++) {
      const x0 = gx[i], y0 = gy[i];
      const f = this.field(x0, y0);
      const a = f[0], dax = f[1], day = f[2];
      // Slide downhill on a², i.e. toward the nodal lines...
      // Capped per step: near the centre of the round plate the spokes crowd together and the slope is steep.
      let x = x0 - Math.max(-0.01, Math.min(0.01, a * dax * norm * pull));
      let y = y0 - Math.max(-0.01, Math.min(0.01, a * day * norm * pull));
      // ...while the shaking plate bounces grains around where it moves most.
      // A little drift everywhere spreads settled sand along its line instead of letting
      // it bunch up where the old and new figures cross.
      const kick = Math.abs(a) * jitter + drift;
      x += (Math.random() - 0.5) * kick;
      y += (Math.random() - 0.5) * kick;
      if (tilted) {
        if (uniform) { x += ugx; y += ugy; }
        else {
          const [ax, ay] = gravityAt(gMode, gPull, x, y, 1, 1, this.time, 0.05);
          x += ax; y += ay;
        }
      }
      if (px >= 0 && (x - px) ** 2 + (y - py) ** 2 < 0.004) {
        x += (Math.random() - 0.5) * 0.04;
        y += (Math.random() - 0.5) * 0.04;
      }
      // Grains bounce off the plate's rim.
      if (this.round) {
        const u = 2 * x - 1, v = 2 * y - 1, r = Math.hypot(u, v);
        if (r > 1) {
          const k = (2 - r) / r;
          x = (u * k + 1) / 2;
          y = (v * k + 1) / 2;
        }
      } else {
        x = x < 0 ? -x : x > 1 ? 2 - x : x;
        y = y < 0 ? -y : y > 1 ? 2 - y : y;
      }
      gx[i] = x;
      gy[i] = y;
      this.amp[i] = Math.min(1, Math.abs(a));
    }
  }

  onNote(ev: NoteEvent, p: ParamValues): void {
    const punch = p.punch as number;
    if (ev.role === "tone") {
      // Higher notes ring higher (busier) modes.
      const list = this.modes();
      this.setMode(Math.round(ev.x * Math.min(list.length - 1, this.round ? 40 : 36)));
      this.shake = Math.max(this.shake, ev.velocity * 1.5 * punch);
    } else if (ev.role === "chord") {
      // Each chord rings its own figure, set by the chord's root.
      const list = this.modes();
      const pc = ((ev.note % 12) + 12) % 12;
      this.setMode(Math.round((pc / 11) * Math.min(list.length - 1, this.round ? 24 : 20)));
      this.shake = Math.max(this.shake, ev.velocity * 0.8 * punch);
    } else {
      const kick = ev.role === "kick" ? 3 : ev.role === "snare" ? 1.6 : ev.role === "bassline" ? 1 : 0.6;
      this.shake = Math.max(this.shake, ev.velocity * kick * punch);
    }
  }

  onPointer(input: PointerInput): void {
    this.pointer = input.pressed && input.type !== "up" ? { x: input.x, y: input.y } : null;
  }

  render(g: CanvasRenderingContext2D, view: Viewport, p: ParamValues, m: MusicFrame): void {
    applyFeedback(this.fb, g, view, p, this.stepped);
    this.stepped = false;
    const [ox, oy, s] = this.plate();
    const scheme = p.colours as string;
    this.hue = hueToward(this.hue, scheme === "notes" ? m.hue : schemeHue(scheme, 0.5, m.hue, m.beats), 0.08);
    // Settled sand on the still lines glows in the main colour; sand still bouncing glows a second colour.
    const still = new Path2D(), moving = new Path2D();
    const r = (p.grainSize as number) * (1 + Math.min(1, m.treble) * 0.5);
    const { gx, gy, amp } = this;
    for (let i = 0; i < gx.length; i++) {
      const path = amp[i] < 0.25 ? still : moving;
      path.rect(ox + gx[i] * s - r / 2, oy + gy[i] * s - r / 2, r, r);
    }
    g.globalCompositeOperation = "lighter";
    const light = 55 + Math.min(1, m.energy) * 15;
    g.fillStyle = `hsla(${this.hue} 85% ${light}% / 0.9)`;
    g.fill(still);
    g.fillStyle = `hsla(${(this.hue + (p.secondHue as number)) % 360} 80% ${light - 10}% / 0.45)`;
    g.fill(moving);
    g.globalCompositeOperation = "source-over";
  }

  stats(): string {
    const list = this.modes();
    const [n, m, sign] = list[this.mode % list.length];
    const name = this.round ? `${n} spokes, ${m} rings` : `Mode (${n}, ${m}) ${sign > 0 ? "+" : "−"}`;
    return `${name} · ${this.gx.length.toLocaleString()} grains`;
  }
}

export const chladni: ModelDefinition = {
  id: "chladni",
  name: "Cymatics",
  category: "Surfaces",
  description: "Glowing sand on a vibrating plate gathers on the lines that stay still. Every melody note rings a new mode and the sand morphs into its figure, higher notes drawing busier ones; the round plate draws turning mandalas. Drums and loud passages shake the sand loose.",
  hint: "Play notes (sequencer or MIDI) to change the figure, or use the Mode slider. Drag to stir the sand.",
  fixedDt: 1 / 60,
  paintsBackground: true,
  params: [
    {
      kind: "choice", key: "plate", label: "Plate", default: "round", group: "Shape",
      description: "A round plate draws mandalas of spokes and rings; a square one draws classic Chladni figures.",
      options: [
        { value: "round", label: "Round (mandalas)" },
        { value: "square", label: "Square (Chladni figures)" },
      ],
    },
    { kind: "number", key: "mode", label: "Mode", min: 0, max: SQUARE.length - 1, step: 1, default: 6, group: "Shape",
      description: "Which vibration pattern the plate rings in. Higher modes draw busier figures." },
    { kind: "number", key: "turn", label: "Turning", min: -120, max: 120, step: 1, default: 6, group: "Shape",
      description: "How fast the round plate's pattern turns, degrees per second. Speeds up when the music is loud." },
    { kind: "number", key: "punch", label: "Hit shake", min: 0, max: 4, step: 0.05, default: 1, group: "Music", global: "energy",
      description: "How hard drums and notes shake the sand off the lines." },
    { kind: "number", key: "loudShake", label: "Loudness shake", min: 0, max: 6, step: 0.1, default: 1.5, group: "Music", global: "energy",
      description: "How much loud music keeps the sand churning between hits." },
    { kind: "number", key: "vibration", label: "Vibration", min: 0, max: 12, step: 0.05, default: 1, group: "Behaviour", global: "energy",
      description: "How hard the plate shakes all the time. High values blow the sand into a churning haze." },
    { kind: "number", key: "settle", label: "Settling speed", min: 0, max: 12, step: 0.05, default: 1.6, group: "Behaviour",
      description: "How fast sand slides onto the still lines. High values snap each figure sharp." },
    gravityModeParam("off", undefined, { description: "Tilts the plate so the sand slides that way, pooling along the lines it can't cross." }),
    { kind: "number", key: "fieldGravity", label: "Tilt", min: 0, max: 1.5, step: 0.01, default: 0.25, group: "Gravity", global: "gravity",
      description: "How steeply the plate tilts. High values pour the sand off the figure into a heap." },
    colourParam("notes"),
    { kind: "number", key: "secondHue", label: "Second colour", min: 0, max: 360, step: 5, default: 160, group: "Look",
      description: "How far round the colour wheel the bouncing sand is from the settled sand." },
    { kind: "number", key: "grainSize", label: "Grain size", min: 0.5, max: 5, step: 0.1, default: 1.8, group: "Look", global: "size",
      description: "How big each grain is drawn. Treble makes them sparkle bigger." },
    ...feedbackParams(0.7, 0, 0),
    { kind: "number", key: "grains", label: "Grains", min: 2000, max: 40000, step: 1000, default: 16000, resetOnChange: true, group: "Setup",
      description: "How many grains of sand are on the plate. More grains draw finer lines." },
  ],
  macros: [
    { key: "agitate", label: "Agitate", description: "Shakes the plate so hard the figure boils into a glittering haze.",
      targets: [{ param: "vibration", amount: 0.7 }, { param: "settle", amount: -0.4 }, { param: "grainSize", amount: 0.3 }, { param: "punch", amount: 0.5 }] },
    { key: "mandala", label: "Mandala", description: "Switches to the round plate and spins its mandala down a tunnel.",
      targets: [{ param: "turn", amount: 0.5 }, { param: "afterglow", amount: 0.25 }, { param: "spin", amount: 0.3 }, { param: "zoom", amount: 0.2 }, { param: "plate", set: "round", at: 0.1 }] },
    { key: "crystal", label: "Crystal", description: "Freezes the sand into razor-sharp, glowing lines.",
      targets: [{ param: "settle", amount: 1 }, { param: "vibration", amount: -0.6 }, { param: "grainSize", amount: -0.2 }, { param: "afterglow", amount: 0.2 }, { param: "secondHue", amount: 0.3 }] },
    { key: "storm", label: "Sandstorm", description: "A swirling wind tears the sand off the plate into a turning storm.",
      targets: [{ param: "fieldGravity", amount: 0.15 }, { param: "vibration", amount: 0.4 }, { param: "settle", amount: -0.1 }, { param: "afterglow", amount: 0.15 }, { param: "spin", amount: 0.4 }, { param: "gravityMode", set: "swirl", at: 0.15 }] },
  ],
  modulations: [
    { source: "kick", target: "grainSize", amount: 0.3 },
    { source: "lfoBar", target: "settle", amount: 0.25 },
    { source: "snare", target: "zoom", amount: 0.12 },
  ],
  reactions: [
    { source: "tone", text: "Rings the plate in a mode set by pitch; the sand morphs to the new figure" },
    { source: "kick", text: "A hard shake that throws the sand off the lines" },
    { source: "snare", text: "A medium shake that blurs the figure" },
    { source: "hat", text: "A light shiver" },
    { source: "bassline", text: "A soft thump that loosens the sand" },
    { source: "chord", text: "Each chord rings its own figure, set by its root" },
    { source: "level", text: "Loud music keeps the sand churning and turns the round plate faster" },
    { source: "treble", text: "Grains sparkle bigger" },
  ],
  create: () => new CymaticsSim(),
};
