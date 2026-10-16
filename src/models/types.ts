import type { Gfx } from "../gl/gfx";

/**
 * The contract every simulation model implements.
 *
 * A model owns its own state, advances it in `step`, and draws it in
 * `render`. The host app handles the canvas, the animation loop, the
 * parameter UI, and routing pointer input, so a new model only has to
 * describe its parameters and implement these methods.
 */

/** Fields every parameter kind shares. */
interface ParamCommon {
  key: string;
  label: string;
  /** One short sentence shown under the control, saying what it does. */
  description?: string;
  /**
   * Sidebar heading the parameter is listed under, e.g. "Gravity" or "Look".
   * Parameters with the same group are shown together, in the order the
   * groups first appear.
   */
  group?: string;
  /**
   * A fine control: listed under a folded "More" heading after the primary
   * ones, so a model's panel opens on the five to seven controls that change
   * the picture most.
   */
  advanced?: boolean;
  /**
   * Only show the control while this is true of the current values, e.g. a
   * slider that only matters for one choice of a dropdown. The parameter
   * keeps its value and macros and routes still push it while hidden.
   */
  showWhen?: (params: ParamValues) => boolean;
  /** Re-run `reset` when this parameter changes (e.g. particle count). */
  resetOnChange?: boolean;
  /** The slider has a frame-rate cost; it is marked as such. */
  perf?: boolean;
  /**
   * Which Global Control drives this number parameter. "energy": the global
   * Energy multiplies it on top of its slider. "gravity": it is the model's
   * gravity-field strength, set by the global Gravity strength as a multiple
   * of its default (mark it `hidden` too).
   */
  global?: "gravity" | "energy";
  /**
   * No control shows for it, because a Global Control or a built-in reaction
   * row in the modulation matrix covers it: the model keeps the value at its
   * default, or the global or the row's strength sets it (gravity strength,
   * the keys `gravityMode`, `colours`, `afterglow`, `zoom` and `spin`, and
   * any parameter a `reactions` entry names). Macros can still push it.
   */
  hidden?: boolean;
}

export type ParamSpec = ParamCommon &
  (
  | {
      kind: "number";
      min: number;
      max: number;
      step: number;
      default: number;
      /** Optional readout text, e.g. "1 bar" instead of the number; it also sees the other values. */
      format?: (value: number, params?: ParamValues) => string;
      /**
       * Shapes the slider: the value is `min + (max - min) * position^curve`,
       * so a curve above 1 gives the low end most of the track. Pick it so the
       * default sits near the middle; `curveFor` works it out.
       */
      curve?: number;
      /** The band Randomize rolls inside; the whole range when left out. */
      random?: [number, number];
      /** The slider sticks at zero, for ranges that run both ways. */
      snapZero?: boolean;
      /** A label that depends on other values, e.g. what "Shape" means for the chosen pattern. */
      labelFor?: (params: ParamValues) => string;
    }
  | {
      kind: "boolean";
      default: boolean;
    }
  | {
      /** A dropdown of named options, e.g. a preset or a brush material. */
      kind: "choice";
      options: { value: string; label: string }[];
      default: string;
      /** Draw the options as a row of buttons instead of a dropdown; for up to about six short names. */
      segmented?: boolean;
    }
  | {
      /**
       * A control drawn for other parameters: an XY pad that moves two number
       * parameters at once. The parameters it names get no control of their
       * own unless they are `advanced`.
       */
      kind: "widget";
      widget: "pad";
      keys: string[];
    }
  );

/** The slider curve that puts `value` at the middle of a slider from `min` to `max`. */
export function curveFor(min: number, max: number, value: number): number {
  const frac = (value - min) / (max - min);
  if (frac <= 0 || frac >= 1) return 1;
  return Math.log(frac) / Math.log(0.5);
}

export type ParamValues = Record<string, number | boolean | string>;

export interface Viewport {
  width: number;
  height: number;
}

export interface PointerInput {
  type: "down" | "move" | "up";
  x: number;
  y: number;
  /** 0 = primary, 2 = secondary, as in PointerEvent.button. */
  button: number;
  /** True while any button is held. */
  pressed: boolean;
  shift: boolean;
}

/**
 * What a built-in reaction listens to: a kind of note, an audio band, the
 * spectrum (and waveform), or the beat clock.
 */
export type ReactionSource = NoteRole | "level" | "bass" | "mid" | "treble" | "spectrum" | "beat";

/**
 * What kind of hit a note is. Drum sounds are told apart so models can react
 * to the beat; "tone" is the melody, "bassline" the bass part and "chord" a
 * chord hit from the sequencer.
 */
export type NoteRole = "kick" | "snare" | "hat" | "tone" | "bassline" | "chord";

/**
 * A musical event, from the built-in sequencer, a MIDI device, or a beat
 * detected in an audio file. Models may react to it in `onNote`.
 */
export interface NoteEvent {
  /** MIDI note number (60 = middle C). */
  note: number;
  /** 0..1 */
  velocity: number;
  role: NoteRole;
  /**
   * Where the note sits in its range, 0 = lowest, 1 = highest. Models use it
   * as a position (e.g. left-to-right) so melodies spread across the canvas.
   */
  x: number;
  source: "sequencer" | "midi" | "audio";
  /** For a chord, every note in it, lowest first. */
  notes?: number[];
}

/**
 * A macro is one 0..1 knob that pushes several parameters at once. At 0 the
 * parameters keep their slider values; at 1 each number moves by `amount`
 * times its full range (negative amounts move it down). A target with `set`
 * instead switches a dropdown or checkbox to that value once the knob passes
 * `at`, so one turn can flip the whole look.
 */
export interface MacroSpec {
  key: string;
  label: string;
  /** One short line on what it does, shown under the knob. */
  description?: string;
  targets: MacroTarget[];
}

export type MacroTarget =
  | { param: string; amount: number }
  | { param: string; set: string | boolean; at: number };

/**
 * A modulation route: a music source (see src/music/modulation.ts for the
 * list) pushes a target, which is a number parameter's key or `macro:<key>`.
 * `amount` is a fraction of the target's range, -1..1.
 */
export interface ModRoute {
  source: string;
  target: string;
  amount: number;
  /** Switched off in the matrix but kept, so it can be turned back on. */
  off?: boolean;
}

/**
 * What the music is doing right now, handed to `step` and `render` every
 * frame so models can move with the sound continuously, not only on hits.
 * Every value is already scaled by the global music Intensity (so it can go
 * above 1), times the strength of the matching built-in reaction row in the
 * modulation matrix, and zero when music or that row is switched off.
 */
export interface MusicFrame {
  /** Drum, melody, bass-part and chord envelopes: jump to the hit's velocity, then decay. */
  kick: number;
  snare: number;
  hat: number;
  tone: number;
  bassline: number;
  chord: number;
  /** Loudness of everything playing, and its bass, mid and treble bands, roughly 0..1. */
  level: number;
  bass: number;
  mid: number;
  treble: number;
  /** Log-spaced spectrum, lowest frequencies first, each 0..1. */
  spectrum: Float32Array;
  /** A snapshot of the waveform, -1..1. */
  wave: Float32Array;
  /** Musical clock in beats (quarter notes). Always runs, so it can drive slow colour cycles. */
  beats: number;
  /** 1 right on each beat, easing to 0 before the next one. */
  pulse: number;
  /** Hue in degrees of the last melody note, and how high it was, 0..1. */
  hue: number;
  pitch: number;
  /** Hue in degrees of the current chord's root. */
  chordHue: number;
  /** Overall activity, a blend of loudness and recent hits. */
  energy: number;
}

/**
 * The step models were tuned at, in seconds. The host steps by however long
 * each frame took, so anything a model does "per step" that should happen per
 * second (iterations, random jitter) is scaled by `dt / NOMINAL_DT`.
 */
export const NOMINAL_DT = 1 / 60;

/** Scale for a per-step random nudge so the random walk it makes covers the same ground per second at any step size. */
export function jitterScale(dt: number): number {
  return Math.sqrt(dt / NOMINAL_DT);
}

/** A silent frame, for stepping a model outside the main loop. */
export const SILENT_MUSIC: MusicFrame = {
  kick: 0, snare: 0, hat: 0, tone: 0, bassline: 0, chord: 0, level: 0, bass: 0, mid: 0, treble: 0,
  spectrum: new Float32Array(48), wave: new Float32Array(128),
  beats: 0, pulse: 0, hue: 210, pitch: 0.5, chordHue: 210, energy: 0,
};

export interface SimulationModel {
  /** (Re)create the model's state for the given viewport and parameters. */
  reset(view: Viewport, params: ParamValues): void;
  /** Advance the simulation by `dt` seconds. */
  step(dt: number, params: ParamValues, music: MusicFrame): void;
  /**
   * Draw the current state. The canvas is already cleared, unless the
   * definition sets `paintsBackground`.
   */
  render(g: CanvasRenderingContext2D, view: Viewport, params: ParamValues, music: MusicFrame): void;
  /**
   * Optional: draw the same picture on the GPU. When present (and WebGL works)
   * the host calls this instead of `render`. The frame is already cleared,
   * unless the definition sets `paintsBackground`.
   */
  renderGL?(gfx: Gfx, view: Viewport, params: ParamValues, music: MusicFrame): void;
  /** Optional: react to mouse / touch input on the canvas. */
  onPointer?(input: PointerInput, params: ParamValues): void;
  /** Optional: keep state valid when the canvas size changes. */
  resize?(view: Viewport): void;
  /** Optional: react to a note or drum hit, e.g. spawn something where the note lands. */
  onNote?(note: NoteEvent, params: ParamValues): void;
  /** Optional: short status text shown in the sidebar (e.g. body count). */
  stats?(): string;
}

export interface ModelDefinition {
  id: string;
  name: string;
  category: "Particles" | "Surfaces" | "Shapes" | "Custom";
  description: string;
  /** One line telling the user how to interact with the canvas. */
  hint?: string;
  params: ParamSpec[];
  /**
   * Fixed simulation timestep in seconds. The host runs `step` at this rate
   * regardless of display refresh rate so results are reproducible.
   */
  fixedDt?: number;
  /** Performance knobs shown above the parameters; MIDI-learnable and modulatable. */
  macros?: MacroSpec[];
  /** Modulation routes the model starts with, so music does something out of the box. */
  modulations?: ModRoute[];
  /**
   * Everything the model does with the music by itself (in `onNote`, and with
   * the `MusicFrame`). Each one starts as a row in the modulation matrix,
   * named by `label` with `text` as its longer explanation, where the user
   * can scale, switch off or delete it. Its strength scales the velocity of
   * those notes and that part of the `MusicFrame`; off or deleted, the notes
   * don't reach `onNote` and that part of the frame is zero.
   */
  reactions?: {
    source: ReactionSource;
    label: string;
    text: string;
    /**
     * The hidden number parameter(s) this reaction's strength stands for: at
     * 100% they sit at their default, at 200% at double it, and off is zero.
     * These used to be sliders of their own; the row is now their control.
     */
    param?: string | string[];
  }[];
  /**
   * The model paints its own background each frame (e.g. to leave fading
   * trails), so the host doesn't clear the canvas first.
   */
  paintsBackground?: boolean;
  create(): SimulationModel;
}

export function defaultParams(def: ModelDefinition): ParamValues {
  const values: ParamValues = {};
  for (const p of def.params) if (p.kind !== "widget") values[p.key] = p.default;
  return values;
}
