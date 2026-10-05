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
  /** Re-run `reset` when this parameter changes (e.g. particle count). */
  resetOnChange?: boolean;
  /**
   * Which Global Control scales this number parameter, so one global knob
   * moves the matching slider in every model: "gravity" for gravity-field
   * strength, "energy" for how wild things move, "size" for glow and line
   * sizes. Parameters keyed `gravityMode`, `colours`, `afterglow`, `zoom`
   * and `spin` are picked up by key without a tag.
   */
  global?: GlobalTag;
}

export type GlobalTag = "gravity" | "energy" | "size";

export type ParamSpec = ParamCommon &
  (
  | {
      kind: "number";
      min: number;
      max: number;
      step: number;
      default: number;
      /** Optional readout text, e.g. "1 bar" instead of the number. */
      format?: (value: number) => string;
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
    }
  );

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
 * above 1) and is zero when music is switched off or the matching built-in
 * reaction is switched off in the modulation matrix.
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
  category: "Particles" | "Surfaces" | "Custom";
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
   * the `MusicFrame`), listed in the modulation matrix so the user can see and
   * switch off each one. Switching one off stops those notes reaching
   * `onNote` and zeroes that part of the `MusicFrame`.
   */
  reactions?: { source: ReactionSource; text: string }[];
  /**
   * The model paints its own background each frame (e.g. to leave fading
   * trails), so the host doesn't clear the canvas first.
   */
  paintsBackground?: boolean;
  create(): SimulationModel;
}

export function defaultParams(def: ModelDefinition): ParamValues {
  const values: ParamValues = {};
  for (const p of def.params) values[p.key] = p.default;
  return values;
}
