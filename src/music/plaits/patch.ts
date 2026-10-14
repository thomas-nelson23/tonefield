// What the main thread and the Plaits voices in the audio worklet share.

/** The Plaits engines Tonefield ports, in Plaits' order. */
export const ENGINES = ["analog", "fold", "fm", "grain", "additive", "strings", "pluck", "modal"] as const;
export type EngineName = (typeof ENGINES)[number];

/** One track's sound: a Plaits patch plus Tonefield's extras. All 0..1 unless noted. */
export interface Patch {
  /** Index into ENGINES. */
  engine: number;
  harmonics: number;
  timbre: number;
  morph: number;
  /** How far each note's decay envelope pushes Timbre and Morph, -1..1 (Plaits' attenuverters). */
  timbreEnv: number;
  morphEnv: number;
  /** The low-pass gate's decay: short plucks to long rings; past 60% notes also hold while held. */
  decay: number;
  /** The gate's colour: 0 is a plain VCA, 1 a filter that darkens as it closes. */
  colour: number;
  glide: number;
  /** Fade-in time. */
  attack: number;
  /** A sine at the note's pitch under the engine, for weight. */
  sub: number;
  /** Chords: sweep the voicing down or up through inversions; 0.5 leaves it as voiced. */
  inversion: number;
  /** Chords: spread the notes' starts, lowest first. */
  strum: number;
  /** A sine LFO on Timbre: speed in Hz and depth. */
  wobbleHz: number;
  wobbleDepth: number;
}

export function defaultPatch(): Patch {
  return {
    engine: 0, harmonics: 0.5, timbre: 0.5, morph: 0.5, timbreEnv: 0, morphEnv: 0, decay: 0.5, colour: 0.5,
    glide: 0, attack: 0, sub: 0, inversion: 0.5, strum: 0, wobbleHz: 1, wobbleDepth: 0,
  };
}

/** Messages the main thread sends the synth. Times are AudioContext seconds. */
export type SynthMessage =
  | { type: "patch"; track: number; patch: Patch }
  | { type: "note"; track: number; id: number; time: number; notes: number[]; velocity: number; duration: number }
  | { type: "off"; track: number; id: number; time: number }
  | { type: "allOff" };
