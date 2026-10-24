import type { NoteEvent, NoteRole } from "../models/types";
import type { AudioEngine, DrumSound, MixSettings, SynthTrack, TrackKey } from "./audio";
import { GRIDS_STEPS, gridsLevels, gridsThreshold } from "./grids";
import { DejaVuSequence, Distribution, LOOP_SIZE, pitchWeights, quantize, smoothness, spread, stepsLevel } from "./marbles";
import { ENGINES, type EngineName, type Patch } from "./plaits/patch";

/** Sixteenth notes per bar. */
export const STEPS = 16;

export type DrumKey = "kick" | "snare" | "hat";

/** The drum tracks, inner ring first. `max` is how many hits full density gives. */
export const DRUMS: { key: DrumKey; role: NoteRole; label: string; note: number; max: number; colour: string }[] = [
  { key: "kick", role: "kick", label: "Kick", note: 36, max: 10, colour: "#ff4d6d" },
  { key: "snare", role: "snare", label: "Snare", note: 38, max: 8, colour: "#ffb020" },
  { key: "hat", role: "hat", label: "Hat", note: 42, max: 16, colour: "#2ad4ff" },
];

export const SCALES: Record<string, { label: string; steps: number[] }> = {
  minorPent: { label: "Minor pentatonic", steps: [0, 3, 5, 7, 10] },
  majorPent: { label: "Major pentatonic", steps: [0, 2, 4, 7, 9] },
  major: { label: "Major", steps: [0, 2, 4, 5, 7, 9, 11] },
  minor: { label: "Natural minor", steps: [0, 2, 3, 5, 7, 8, 10] },
  dorian: { label: "Dorian", steps: [0, 2, 3, 5, 7, 9, 10] },
  whole: { label: "Whole tone", steps: [0, 2, 4, 6, 8, 10] },
};

/** Reset choices for a drum track: every how many bars its pattern starts over. "0" never does. */
export const DRUM_RESETS = [
  { value: "0", label: "None" }, { value: "1", label: "1 bar" }, { value: "2", label: "2 bars" },
  { value: "4", label: "4 bars" }, { value: "8", label: "8 bars" }, { value: "16", label: "16 bars" },
];
/**
 * How a drum track makes its pattern: evenly spread euclidean hits, the
 * Grids-style drum map, or both merged.
 */
export const DRUM_MODES = [
  { value: "euclid", label: "Euclidean" }, { value: "grids", label: "Grids" }, { value: "both", label: "Both" },
];
/** Longest drum pattern, in sixteenths. */
export const MAX_DRUM_LENGTH = 32;

/** The mixer's tracks, in strip order. */
export const TRACKS: { key: TrackKey; label: string }[] = [
  { key: "drums", label: "Drums" },
  { key: "bass", label: "Bass" },
  { key: "chords", label: "Chords" },
  { key: "melody", label: "Melody" },
];

/** Echo times, in sixteenths. */
export const ECHO_TIMES = [1, 2, 3, 4, 6];
export const ECHO_TIME_LABELS = ["1/16", "1/8", "Dotted 1/8", "1/4", "Dotted 1/4"];

/** The Plaits engines each track can play, in Plaits' order. */
export const ENGINE_CHOICES: { value: EngineName; label: string }[] = [
  { value: "analog", label: "Virtual analog" },
  { value: "fold", label: "Waveshaper" },
  { value: "fm", label: "FM" },
  { value: "grain", label: "Grain formant" },
  { value: "additive", label: "Additive" },
  { value: "strings", label: "String machine" },
  { value: "pluck", label: "Plucked string" },
  { value: "modal", label: "Modal resonator" },
];

/** The state key prefix of each synth track's sound controls. */
const SOUND_PREFIX: Record<SynthTrack, "bass" | "chord" | "melody"> = { bass: "bass", chords: "chord", melody: "melody" };

/** A fader position as gain: 0.8 is unity, the top is about +4 dB. */
export function faderGain(v: number): number {
  return (Math.max(0, v) / 0.8) ** 2;
}

export const ROOTS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/**
 * The overall feel. Each style places the euclidean drum tracks (how many hits
 * and where the pattern starts) and sets how hard and how often it fills.
 * Picking a style moves the drum density sliders to its starting point.
 */
export const STYLES: Record<string, { label: string; hits: Record<DrumKey, number>; rotate: Record<DrumKey, number>; map: [number, number]; level: number; fills: number }> = {
  broken: { label: "Broken beat", hits: { kick: 3, snare: 2, hat: 11 }, rotate: { kick: 0, snare: 4, hat: 0 }, map: [0.8, 0.4], level: 1, fills: 1 },
  four: { label: "Four on the floor", hits: { kick: 4, snare: 2, hat: 4 }, rotate: { kick: 0, snare: 4, hat: 2 }, map: [0, 0.33], level: 1, fills: 0.8 },
  half: { label: "Half-time", hits: { kick: 3, snare: 1, hat: 8 }, rotate: { kick: 0, snare: 8, hat: 0 }, map: [0.4, 0], level: 1, fills: 1 },
  ambient: { label: "Ambient", hits: { kick: 2, snare: 1, hat: 5 }, rotate: { kick: 0, snare: 12, hat: 2 }, map: [0.1, 0], level: 0.6, fills: 0.3 },
};

/** Velocity accent per sixteenth: downbeats loudest, then beats, then off-beats. */
const ACCENT = [1, 0.55, 0.75, 0.55, 0.9, 0.55, 0.75, 0.6, 0.95, 0.55, 0.75, 0.55, 0.9, 0.55, 0.75, 0.65];

export const BASS_STYLES: Record<string, { label: string; weights: number[]; legato: number; onChange: boolean }> = {
  pulse: { label: "Root pulse", weights: [1, 0.1, 0.6, 0.1, 0.85, 0.1, 0.6, 0.15, 0.95, 0.1, 0.6, 0.1, 0.85, 0.15, 0.6, 0.3], legato: 0.8, onChange: true },
  offbeat: { label: "Off-beat", weights: [0.15, 0, 1, 0.1, 0.15, 0, 1, 0.1, 0.15, 0, 1, 0.1, 0.15, 0, 1, 0.2], legato: 0.6, onChange: false },
  octave: { label: "Octave bounce", weights: [1, 0.15, 0.8, 0.15, 0.9, 0.15, 0.8, 0.2, 0.95, 0.15, 0.8, 0.15, 0.9, 0.2, 0.8, 0.3], legato: 0.5, onChange: true },
  syncopated: { label: "Syncopated", weights: [1, 0, 0.3, 0.75, 0, 0.25, 0.8, 0, 0.4, 0.65, 0, 0.75, 0, 0.3, 0.6, 0.4], legato: 0.7, onChange: true },
  walk: { label: "Walking", weights: [1, 0, 0.1, 0, 1, 0, 0.1, 0, 1, 0, 0.1, 0, 1, 0, 0.15, 0.05], legato: 0.95, onChange: true },
  drone: { label: "Drone", weights: [1, 0, 0, 0, 0.05, 0, 0, 0, 0.6, 0, 0, 0, 0.05, 0, 0, 0], legato: 1, onChange: true },
};

/**
 * One level of a style's harmonic rhythm, used from Rhythm density `at` up.
 * Each pattern gives the length in sixteenths of each chord of a four-chord
 * progression (longer progressions repeat it). "8+8" plays the chord for 8 and
 * then a style-typical approach chord into the next one for 8. Rhythm
 * variation picks between a level's patterns from one pass to the next.
 */
export interface HarmonicRung {
  at: number;
  patterns: string[];
}

const TWO_BARS = "32 32 32 32";
const MIXED_TWO = "32 32 48 16";
const TURN_TWO = "32 32 32 16+16";
const TURN_TWO_MID = "32 16+16 32 16+16";
const ONE_BAR = "16 16 16 16";
const MIXED_ONE = "16 16 24 8";
const TURN_ONE = "16 16 16 8+8";
const TURN_ONE_MID = "16 8+8 16 16";
const HALF_BAR = "8 8 8 8";
const MIXED_HALF = "8 8 12 4";

/**
 * Chord progressions per style, as Roman numerals relative to the key, one
 * list for major-sounding scales and one for minor. "b" flattens the root,
 * lower case is minor, ° diminished, ø half-diminished; suffixes add 7ths,
 * 9ths, sus and power chords.
 */
export const CHORD_STYLES: Record<string, {
  label: string;
  major: string[];
  minor: string[];
  /** Comping rhythm: how likely each sixteenth is to get a hit. */
  rhythm: number[];
  /** How much of the gap to the next hit a chord holds for. */
  legato: number;
  /** Harmonic rhythm: how long chords last at each level of Rhythm density (see HarmonicRung). */
  changes: HarmonicRung[];
}> = {
  jazz: {
    label: "Jazz",
    major: ["ii7 V7 Imaj7 Imaj7", "Imaj7 vi7 ii7 V7", "iii7 vi7 ii7 V7", "Imaj9 vi9 ii9 V9", "Imaj7 I7 IVmaj7 iv7 iii7 VI7 ii7 V7"],
    minor: ["iiø7 V7 i7 i7", "i7 iv7 bVII7 bIIImaj7", "i7 bVImaj7 iiø7 V7", "i9 iv9 i9 V7"],
    rhythm: [0.9, 0, 0, 0.2, 0, 0, 0.85, 0.1, 0, 0.3, 0.5, 0, 0, 0.2, 0.6, 0.15],
    legato: 0.6,
    // Jazz moves: a bar per chord with ii-V turnarounds, up to two or four changes a bar.
    changes: [
      { at: 0, patterns: [TWO_BARS, MIXED_TWO] },
      { at: 0.15, patterns: [ONE_BAR, MIXED_ONE] },
      { at: 0.25, patterns: [TURN_ONE, TURN_ONE_MID] },
      { at: 0.45, patterns: ["16 8+8 16 8+8"] },
      { at: 0.6, patterns: [HALF_BAR, MIXED_HALF] },
      { at: 0.8, patterns: ["8 8 8 4+4", "8 4+4 8 4+4"] },
      { at: 0.92, patterns: ["4 4 4 4"] },
    ],
  },
  pop: {
    label: "Pop",
    major: ["I V vi IV", "vi IV I V", "I vi IV V", "I IV vi V", "IV I V vi"],
    minor: ["i bVI bIII bVII", "i bVII bVI bVII", "i iv bVI bVII", "bVI bVII i i", "i bIII bVII iv"],
    rhythm: [1, 0, 0.3, 0, 0.5, 0, 0.6, 0, 0.8, 0, 0.3, 0.2, 0.5, 0, 0.6, 0.1],
    legato: 0.95,
    // Pop: two bars per chord with a pickup into the next phrase, then a bar each, then faster.
    changes: [
      { at: 0, patterns: [TWO_BARS, MIXED_TWO] },
      { at: 0.2, patterns: [TURN_TWO, TURN_TWO_MID] },
      { at: 0.4, patterns: [ONE_BAR, MIXED_ONE] },
      { at: 0.6, patterns: [TURN_ONE, TURN_ONE_MID] },
      { at: 0.8, patterns: [HALF_BAR, MIXED_HALF] },
    ],
  },
  dance: {
    label: "Dance",
    major: ["vi IV I V", "Iadd9 V vi IV", "IV V vi vi", "Imaj7 IVmaj7 Imaj7 IVmaj7", "vi7 IVmaj7 I V"],
    minor: ["i bVI bIII bVII", "i bVII bVI bVII", "i i bVI bVII", "i7 bVImaj7 bIII bVII", "iadd9 bVImaj7 bVII iv7"],
    rhythm: [0.15, 0, 1, 0, 0.15, 0, 1, 0, 0.15, 0, 1, 0, 0.15, 0.1, 1, 0.2],
    legato: 0.45,
    // Dance loops sit on long, even chords; a sus pickup builds into the next phrase.
    changes: [
      { at: 0, patterns: [TWO_BARS] },
      { at: 0.35, patterns: [TURN_TWO] },
      { at: 0.5, patterns: [ONE_BAR] },
      { at: 0.7, patterns: [TURN_ONE] },
      { at: 0.85, patterns: [HALF_BAR] },
    ],
  },
  epic: {
    label: "Epic",
    major: ["I bVI bVII I", "I III vi IV", "vi IV I V", "I bIII IV I", "Isus4 I bVI bVII"],
    minor: ["i bVI bIII bVII", "i bVI iv V", "i bVII bVI V", "i bIII bVII IV", "i5 bVI5 bVII5 i5", "isus2 bVI bIII V"],
    rhythm: [1, 0.1, 0.7, 0.1, 0.8, 0.1, 0.7, 0.1, 0.9, 0.1, 0.7, 0.1, 0.8, 0.15, 0.75, 0.3],
    legato: 0.9,
    // Epic holds chords for a long time and lets them swell.
    changes: [
      { at: 0, patterns: ["64 64 64 64", "64 64 96 32"] },
      { at: 0.15, patterns: [TWO_BARS, MIXED_TWO] },
      { at: 0.35, patterns: [TURN_TWO, TURN_TWO_MID] },
      { at: 0.55, patterns: [ONE_BAR, MIXED_ONE] },
      { at: 0.75, patterns: [TURN_ONE] },
      { at: 0.9, patterns: [HALF_BAR] },
    ],
  },
};


/** Wobble speeds, in beats per cycle. */
const WOBBLE_RATES = [8, 4, 2, 1, 0.5];
export const WOBBLE_RATE_LABELS = ["2 bars", "1 bar", "½ bar", "1 beat", "½ beat"];

/**
 * How the melody decides which clock ticks get a note, after Marbles' t
 * section: a coin toss on every tick, notes that come in bursts, or steady
 * divisions of the clock. Density is Marbles' t Bias.
 */
export const MELODY_RHYTHMS = [
  { value: "coin", label: "Coin" }, { value: "bursts", label: "Bursts" }, { value: "steady", label: "Steady" },
];
/** The melody's clock, in sixteenths per tick. */
export const MELODY_RATES = [8, 4, 2, 1];
export const MELODY_RATE_LABELS = ["½", "¼", "⅛", "1/16"];
/** What Déjà vu loops: both the rhythm and the notes, or only one (the other stays fresh), like Marbles' two lock buttons. */
export const MELODY_LOOPS = [
  { value: "both", label: "Both" }, { value: "rhythm", label: "Rhythm" }, { value: "notes", label: "Notes" },
];
/** Steady's patterns over eight ticks, sparse to every tick; Density picks one. */
const STEADY = ["10000000", "10001000", "10010010", "10101010", "10110110", "11101110", "11111111"];

/** Starting points for the melody, each a handful of its controls. */
export const MELODY_PRESETS: { id: string; label: string; hint: string; values: Partial<SequencerState> }[] = [
  { id: "drift", label: "Drift", hint: "Slow, low notes that rarely repeat",
    values: { melodyRhythm: "coin", melodyRate: 1, melodyDensity: 0.45, melodyJitter: 0.15, melodyLegato: 0.9, melodySpread: 0.4, melodyBias: 0.35, melodySteps: 0.3, melodyOctaves: 1.5, melodyDejaVu: 0.15, melodyLength: 8, melodyLoop: "both" } },
  { id: "wander", label: "Wander", hint: "A tune that keeps a shape but slowly changes",
    values: { melodyRhythm: "coin", melodyRate: 2, melodyDensity: 0.5, melodyJitter: 0, melodyLegato: 0.5, melodySpread: 0.45, melodyBias: 0.5, melodySteps: 0.7, melodyOctaves: 1.5, melodyDejaVu: 0.35, melodyLength: 8, melodyLoop: "both" } },
  { id: "riff", label: "Riff", hint: "A short phrase locked into a loop",
    values: { melodyRhythm: "coin", melodyRate: 3, melodyDensity: 0.6, melodyJitter: 0, melodyLegato: 0.35, melodySpread: 0.5, melodyBias: 0.45, melodySteps: 0.75, melodyOctaves: 1, melodyDejaVu: 0.5, melodyLength: 6, melodyLoop: "both" } },
  { id: "sparkle", label: "Sparkle", hint: "Quick, high notes on the chord",
    values: { melodyRhythm: "bursts", melodyRate: 3, melodyDensity: 0.55, melodyJitter: 0, melodyLegato: 0.2, melodySpread: 0.7, melodyBias: 0.75, melodySteps: 0.85, melodyOctaves: 2, melodyDejaVu: 0.3, melodyLength: 16, melodyLoop: "rhythm" } },
  { id: "chant", label: "Chant", hint: "Steady notes that stay close together",
    values: { melodyRhythm: "steady", melodyRate: 2, melodyDensity: 0.5, melodyJitter: 0, melodyLegato: 0.7, melodySpread: 0.2, melodyBias: 0.5, melodySteps: 0.65, melodyOctaves: 1, melodyDejaVu: 0.4, melodyLength: 4, melodyLoop: "both" } },
  { id: "shuffle", label: "Shuffle", hint: "A loop played in a different order each time round",
    values: { melodyRhythm: "coin", melodyRate: 2, melodyDensity: 0.65, melodyJitter: 0, melodyLegato: 0.45, melodySpread: 0.55, melodyBias: 0.5, melodySteps: 0.7, melodyOctaves: 1.5, melodyDejaVu: 0.85, melodyLength: 8, melodyLoop: "notes" } },
  { id: "chaos", label: "Chaos", hint: "Wide leaps, loose timing, never the same twice",
    values: { melodyRhythm: "coin", melodyRate: 3, melodyDensity: 0.55, melodyJitter: 0.6, melodyLegato: 0.3, melodySpread: 0.9, melodyBias: 0.5, melodySteps: 0.55, melodyOctaves: 3, melodyDejaVu: 0, melodyLength: 16, melodyLoop: "both" } },
];

/** Metric weight of each sixteenth for melody notes: downbeats first, then off-beats. */
const MELODY_WEIGHT = [1, 0.15, 0.45, 0.2, 0.8, 0.15, 0.5, 0.25, 0.9, 0.15, 0.45, 0.2, 0.75, 0.2, 0.55, 0.3];
/** Extra snare and hat weight in the last beat of a fill bar. */
const FILL_WEIGHT = [0.55, 0.7, 0.8, 0.95];

export interface SequencerState {
  // Global
  tempo: number;
  swing: number;
  scale: string;
  root: number;
  sound: boolean;
  style: string;
  /** Freeze every part instead of letting it evolve. */
  hold: boolean;
  /** 0..1, 0.5 as set: pushes every part's density down or up. */
  energy: number;
  /** 0..1, 0.5 as set: scales how much every part changes as it plays. */
  evolve: number;
  /** Freeze one part, leaving the others to evolve. */
  drumsHold: boolean;
  bassHold: boolean;
  chordsHold: boolean;
  melodyHold: boolean;
  seed: number;
  // Parts on or off
  drumsOn: boolean;
  bassOn: boolean;
  chordsOn: boolean;
  melodyOn: boolean;
  // Drums: mode picks euclidean, Grids map or both (a DRUM_MODES value), density
  // how many euclidean hits, fill how much of the map's pattern plays, variation
  // how much each bar strays, length how many steps the pattern has, rotate
  // (Offset) where it starts, and reset every how many bars it starts over (a DRUM_RESETS value).
  kickMode: string;
  kickFill: number;
  snareMode: string;
  snareFill: number;
  hatMode: string;
  hatFill: number;
  /** Where on the Grids drum map the drums are, 0..1 each way. */
  gridsX: number;
  gridsY: number;
  kickDensity: number;
  kickVariation: number;
  kickRotate: number;
  kickLength: number;
  kickReset: string;
  snareDensity: number;
  snareVariation: number;
  snareRotate: number;
  snareLength: number;
  snareReset: string;
  hatDensity: number;
  hatVariation: number;
  hatRotate: number;
  hatLength: number;
  hatReset: string;
  // Bass
  bassStyle: string;
  bassDensity: number;
  /** 1..7: how many intervals the bass may use, root first. */
  bassRange: number;
  bassVariation: number;
  // Chords
  chordStyle: string;
  /** How often the progression is swapped or a chord substituted. */
  chordVariation: number;
  chordDensity: number;
  /** How much the comping rhythm changes from bar to bar. */
  chordRhythm: number;
  /** How much each pass of the progression repeats the last one's variations (Marbles' déjà vu). */
  chordDejaVu: number;
  // Chord sound: a Plaits patch plus these, 0..1 except the
  // wobble rate, an index into WOBBLE_RATES.
  chordAttack: number;
  chordWobble: number;
  chordWobbleRate: number;
  /** Sweeps the voicing through inversions, as Plaits' chord engine does; 0.5 is as voiced. */
  chordInversion: number;
  chordStrum: number;
  /** Octaves up or down from where the chords are voiced. */
  chordOctave: number;
  /** Plaits engine name (see ENGINE_CHOICES). */
  chordEngine: string;
  chordHarmonics: number;
  chordTimbre: number;
  chordMorph: number;
  /** -1..1: how far each note's decay envelope pushes Timbre and Morph. */
  chordTimbreEnv: number;
  chordMorphEnv: number;
  chordDecay: number;
  chordColour: number;
  /** Which progression of the style is playing. */
  prog: number;
  // Melody, after Marbles. Rhythm (its t section): which ticks play (a
  // MELODY_RHYTHMS value), the clock (a MELODY_RATES index), Density (t Bias),
  // Jitter, and how long each note holds.
  melodyRhythm: string;
  melodyRate: number;
  melodyDensity: number;
  melodyJitter: number;
  melodyLegato: number;
  // Notes (its X section): Spread, Bias (the register), Steps, and how many octaves the notes cover.
  melodySpread: number;
  melodyBias: number;
  melodySteps: number;
  melodyOctaves: number;
  // Déjà vu, the loop's length in ticks, and what it loops (a MELODY_LOOPS value).
  melodyDejaVu: number;
  melodyLength: number;
  melodyLoop: string;
  // Melody sound, a Plaits patch (it's also what a MIDI keyboard plays through)
  /** Plaits engine name (see ENGINE_CHOICES). */
  melodyEngine: string;
  melodyHarmonics: number;
  melodyTimbre: number;
  melodyMorph: number;
  /** -1..1: how far each note's decay envelope pushes Timbre and Morph. */
  melodyTimbreEnv: number;
  melodyMorphEnv: number;
  melodyDecay: number;
  melodyColour: number;
  melodyOctave: number;
  melodyAttack: number;
  melodyGlide: number;
  // Bass sound, a Plaits patch
  /** Plaits engine name (see ENGINE_CHOICES). */
  bassEngine: string;
  bassHarmonics: number;
  bassTimbre: number;
  bassMorph: number;
  /** -1..1: how far each note's decay envelope pushes Timbre and Morph. */
  bassTimbreEnv: number;
  bassMorphEnv: number;
  bassDecay: number;
  bassColour: number;
  bassOctave: number;
  bassSub: number;
  bassGlide: number;
  // Per-drum sound: on/off, fader and pan, pitch in semitones, and 0..1 decay and tone.
  kickOn: boolean; kickVolume: number; kickPan: number; kickPitch: number; kickDecay: number; kickTone: number;
  snareOn: boolean; snareVolume: number; snarePan: number; snarePitch: number; snareDecay: number; snareTone: number;
  hatOn: boolean; hatVolume: number; hatPan: number; hatPitch: number; hatDecay: number; hatTone: number;
  // Mixer: per-track fader (0.8 is unity), pan -1..1, solo, and echo and reverb sends 0..1.
  // A track's mute is `<track>On` switched off.
  drumsVolume: number; drumsPan: number; drumsSolo: boolean; drumsEcho: number; drumsSpace: number;
  bassVolume: number; bassPan: number; bassSolo: boolean; bassEcho: number; bassSpace: number;
  chordsVolume: number; chordsPan: number; chordsSolo: boolean; chordsEcho: number; chordsSpace: number;
  melodyVolume: number; melodyPan: number; melodySolo: boolean; melodyEcho: number; melodySpace: number;
  // Master: output level (gain, 0..1), echo time (an ECHO_TIMES index) and feedback, reverb size.
  masterVolume: number;
  echoTime: number;
  echoFeedback: number;
  spaceSize: number;
}

type SoundKey = "Engine" | "Harmonics" | "Timbre" | "Morph" | "TimbreEnv" | "MorphEnv" | "Decay" | "Colour";
type SoundState<P extends string> = { [K in SoundKey as `${P}${K}`]: K extends "Engine" ? string : number };

function sound<P extends string>(prefix: P, engine: EngineName, v: number[]): SoundState<P> {
  const keys: SoundKey[] = ["Harmonics", "Timbre", "Morph", "TimbreEnv", "MorphEnv", "Decay", "Colour"];
  const out: Record<string, string | number> = { [`${prefix}Engine`]: engine };
  keys.forEach((k, i) => (out[`${prefix}${k}`] = v[i]));
  return out as SoundState<P>;
}

/**
 * Each track's starting sound: a round analog bass with a plucky envelope on
 * its shape, a string-machine pad for the chords and a folded lead.
 * Order: harmonics, timbre, morph, env → timbre, env → morph, decay, colour.
 */
export const SOUND_DEFAULTS = {
  bass: sound("bass", "analog", [0.5, 0.25, 0.6, 0.45, 0, 0.45, 0.6]),
  chord: sound("chord", "strings", [0.55, 0.6, 0.35, 0, 0, 0.8, 0.4]),
  melody: sound("melody", "fold", [0.5, 0.2, 0.5, 0.35, 0, 0.55, 0.5]),
};

/**
 * Named starting sounds for each synth track, so a sound can be picked by ear
 * before learning what Harmonics, Timbre and Morph do. Each is a Plaits patch
 * (same order as SOUND_DEFAULTS) plus any of the track's other sound controls.
 * The first of each is the track's default sound.
 */
function soundPreset(prefix: "bass" | "chord" | "melody", label: string, engine: EngineName, v: number[], extra: Record<string, number> = {}) {
  return { label, values: { ...sound(prefix, engine, v), ...extra } as Partial<SequencerState> };
}
export const SOUND_PRESETS: Record<SynthTrack, { label: string; values: Partial<SequencerState> }[]> = {
  bass: [
    soundPreset("bass", "Round", "analog", [0.5, 0.25, 0.6, 0.45, 0, 0.45, 0.6], { bassSub: 0.5 }),
    soundPreset("bass", "Acid", "analog", [0.5, 0.65, 0.9, 0.7, 0, 0.35, 0.95], { bassSub: 0.2 }),
    soundPreset("bass", "Rubber", "fm", [0.25, 0.35, 0.2, 0.55, 0, 0.4, 0.5], { bassSub: 0.4 }),
    soundPreset("bass", "Growl", "fold", [0.4, 0.55, 0.6, 0.45, 0.2, 0.5, 0.7], { bassSub: 0.35 }),
    soundPreset("bass", "Pluck", "pluck", [0.3, 0.5, 0.45, 0, 0, 0.45, 0.3], { bassSub: 0.45 }),
    soundPreset("bass", "Deep sub", "analog", [0.5, 0, 0, 0, 0, 0.7, 0.2], { bassSub: 0.85 }),
  ],
  chords: [
    soundPreset("chord", "String pad", "strings", [0.55, 0.6, 0.35, 0, 0, 0.8, 0.4], { chordAttack: 0 }),
    soundPreset("chord", "Organ", "strings", [0.45, 0.15, 0.8, 0, 0, 0.8, 0.15], { chordAttack: 0 }),
    soundPreset("chord", "Glass keys", "fm", [0.5, 0.5, 0.1, 0.4, 0, 0.7, 0.3], { chordAttack: 0 }),
    soundPreset("chord", "Bell pad", "modal", [0.7, 0.6, 0.75, 0, 0, 0.75, 0.3], { chordAttack: 0.3 }),
    soundPreset("chord", "Choir", "grain", [0.4, 0.45, 0.5, 0, 0, 0.8, 0.3], { chordAttack: 0.45 }),
    soundPreset("chord", "Soft saw", "analog", [0.5, 0.5, 0.5, 0.2, 0, 0.75, 0.6], { chordAttack: 0.2 }),
  ],
  melody: [
    soundPreset("melody", "Folded lead", "fold", [0.5, 0.2, 0.5, 0.35, 0, 0.55, 0.5], { melodyAttack: 0 }),
    soundPreset("melody", "Bell", "modal", [0.75, 0.7, 0.6, 0, 0, 0.6, 0.3], { melodyAttack: 0 }),
    soundPreset("melody", "Pluck", "pluck", [0.4, 0.65, 0.6, 0, 0, 0.6, 0.3], { melodyAttack: 0 }),
    soundPreset("melody", "Flute", "additive", [0.3, 0.5, 0.5, 0, 0, 0.7, 0.1], { melodyAttack: 0.25 }),
    soundPreset("melody", "FM keys", "fm", [0.5, 0.45, 0.15, 0.6, 0, 0.5, 0.5], { melodyAttack: 0 }),
    soundPreset("melody", "Voice", "grain", [0.45, 0.5, 0.5, 0.3, 0, 0.55, 0.3], { melodyAttack: 0.15 }),
  ],
};

export function defaultState(): SequencerState {
  const s: SequencerState = {
    tempo: 112, swing: 0, scale: "minorPent", root: 9, sound: true, style: "broken", hold: false, seed: 1, energy: 0.5, evolve: 0.5,
    drumsHold: false, bassHold: false, chordsHold: false, melodyHold: false,
    drumsOn: true, bassOn: true, chordsOn: true, melodyOn: true,
    kickMode: "euclid", snareMode: "euclid", hatMode: "euclid", kickFill: 0.5, snareFill: 0.5, hatFill: 0.5,
    gridsX: 0, gridsY: 0,
    kickDensity: 0, kickVariation: 0.3, kickRotate: 0, kickLength: STEPS, kickReset: "0",
    snareDensity: 0, snareVariation: 0.25, snareRotate: 0, snareLength: STEPS, snareReset: "0",
    hatDensity: 0, hatVariation: 0.4, hatRotate: 0, hatLength: STEPS, hatReset: "0",
    bassStyle: "pulse", bassDensity: 0.4, bassRange: 3, bassVariation: 0.3,
    chordStyle: "pop", chordVariation: 0.3, chordDensity: 0.3, chordRhythm: 0.25, prog: 0,
    chordDejaVu: 0, chordAttack: 0, chordWobble: 0, chordWobbleRate: 2, chordInversion: 0.5, chordStrum: 0, chordOctave: 0,
    ...(MELODY_PRESETS[1].values as Pick<SequencerState, "melodyRhythm" | "melodyRate" | "melodyDensity" | "melodyJitter" | "melodyLegato" | "melodySpread" | "melodyBias" | "melodySteps" | "melodyOctaves" | "melodyDejaVu" | "melodyLength" | "melodyLoop">),
    melodyOctave: 0, melodyAttack: 0, melodyGlide: 0,
    bassOctave: 0, bassSub: 0.5, bassGlide: 0,
    ...SOUND_DEFAULTS.bass, ...SOUND_DEFAULTS.chord, ...SOUND_DEFAULTS.melody,
    kickOn: true, kickVolume: 0.8, kickPan: 0, kickPitch: 0, kickDecay: 0.5, kickTone: 0.5,
    snareOn: true, snareVolume: 0.8, snarePan: 0, snarePitch: 0, snareDecay: 0.5, snareTone: 0.5,
    hatOn: true, hatVolume: 0.8, hatPan: 0, hatPitch: 0, hatDecay: 0.5, hatTone: 0.5,
    drumsVolume: 0.8, drumsPan: 0, drumsSolo: false, drumsEcho: 0, drumsSpace: 0,
    bassVolume: 0.8, bassPan: 0, bassSolo: false, bassEcho: 0, bassSpace: 0,
    chordsVolume: 0.8, chordsPan: 0, chordsSolo: false, chordsEcho: 0, chordsSpace: 0,
    melodyVolume: 0.8, melodyPan: 0, melodySolo: false, melodyEcho: 0, melodySpace: 0,
    masterVolume: 0.7, echoTime: 2, echoFeedback: 0.35, spaceSize: 0.5,
  };
  applyStyleDensities(s);
  return s;
}

/** Set the drum sliders to the style's starting pattern: its hits and offsets over one bar. */
export function applyStyleDensities(s: SequencerState): void {
  const st = STYLES[s.style] ?? STYLES.broken;
  const rec = s as unknown as Record<string, number>;
  for (const d of DRUMS) {
    rec[`${d.key}Density`] = st.hits[d.key] / d.max;
    rec[`${d.key}Rotate`] = st.rotate[d.key];
    rec[`${d.key}Length`] = STEPS;
  }
  [s.gridsX, s.gridsY] = st.map;
}

/** Keep only fields that match the current state's types (older saves had other controls). */
export function sanitizeState(saved: unknown): SequencerState {
  const s = defaultState();
  if (!saved || typeof saved !== "object") return s;
  const rec = s as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(saved as Record<string, unknown>)) {
    if (k in rec && typeof v === typeof rec[k] && (typeof v !== "number" || Number.isFinite(v))) rec[k] = v;
  }
  if (!(s.style in STYLES)) s.style = "broken";
  const num = s as unknown as Record<string, number>;
  const str = s as unknown as Record<string, string>;
  for (const d of DRUMS) {
    const len = (num[`${d.key}Length`] = Math.max(1, Math.min(MAX_DRUM_LENGTH, Math.round(num[`${d.key}Length`]))));
    num[`${d.key}Rotate`] = mod(Math.round(num[`${d.key}Rotate`]), len);
    if (!DRUM_RESETS.some((r) => r.value === str[`${d.key}Reset`])) str[`${d.key}Reset`] = "0";
    if (!DRUM_MODES.some((m) => m.value === str[`${d.key}Mode`])) str[`${d.key}Mode`] = "euclid";
    num[`${d.key}Fill`] = Math.max(0, Math.min(1, num[`${d.key}Fill`]));
  }
  if (!(s.scale in SCALES)) s.scale = "minorPent";
  if (!(s.bassStyle in BASS_STYLES)) s.bassStyle = "pulse";
  if (!(s.chordStyle in CHORD_STYLES)) s.chordStyle = "pop";
  if (!MELODY_RHYTHMS.some((m) => m.value === s.melodyRhythm)) s.melodyRhythm = "coin";
  if (!MELODY_LOOPS.some((m) => m.value === s.melodyLoop)) s.melodyLoop = "both";
  for (const prefix of Object.values(SOUND_PREFIX)) {
    if (!ENGINES.includes(str[`${prefix}Engine`] as EngineName)) str[`${prefix}Engine`] = SOUND_DEFAULTS[prefix][`${prefix}Engine` as never];
  }
  const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
  s.bassOctave = clampInt(s.bassOctave, -2, 1);
  s.chordOctave = clampInt(s.chordOctave, -1, 1);
  s.melodyOctave = clampInt(s.melodyOctave, -2, 2);
  s.echoTime = clampInt(s.echoTime, 0, ECHO_TIMES.length - 1);
  for (const d of DRUMS) num[`${d.key}Pitch`] = clampInt(num[`${d.key}Pitch`], -12, 12);
  s.chordWobbleRate = Math.max(0, Math.min(WOBBLE_RATES.length - 1, Math.round(s.chordWobbleRate)));
  s.gridsX = Math.max(0, Math.min(1, s.gridsX));
  s.gridsY = Math.max(0, Math.min(1, s.gridsY));
  s.root = ((Math.round(s.root) % 12) + 12) % 12;
  s.bassRange = Math.max(1, Math.min(7, Math.round(s.bassRange)));
  s.melodyRate = Math.max(0, Math.min(MELODY_RATES.length - 1, Math.round(s.melodyRate)));
  s.melodyLength = Math.max(1, Math.min(LOOP_SIZE, Math.round(s.melodyLength)));
  s.melodyOctaves = Math.max(1, Math.min(3, s.melodyOctaves));
  s.energy = Math.max(0, Math.min(1, s.energy));
  s.evolve = Math.max(0, Math.min(1, s.evolve));
  return s;
}

/** Small seeded PRNG so "New idea" is a seed and a pattern can be recreated. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mod = (n: number, m: number) => ((n % m) + m) % m;

/**
 * Chance that a step with weight `w` plays at `density`. 0.5 plays each step
 * with its own weight; lower values thin out to the strongest steps and higher
 * values fill in the gaps. Because each step compares against a fixed random
 * gate, raising the density only ever adds notes to what's already playing.
 */
export function chance(w: number, density: number): number {
  if (density <= 0 || w <= 0) return 0;
  return Math.pow(w, Math.pow(2, (0.5 - density) * 6));
}

/** `k` hits spread as evenly as possible over `n` steps, starting at `rotate`. */
export function euclid(k: number, n: number, rotate: number): boolean[] {
  const out = new Array<boolean>(n).fill(false);
  k = Math.min(n, Math.max(0, Math.round(k)));
  for (let j = 0; j < k; j++) out[mod(Math.floor((j * n) / k) + rotate, n)] = true;
  return out;
}

/** A chord as semitones: `root` above the key, `tones` above the root. */
export interface Chord {
  numeral: string;
  root: number;
  tones: number[];
}

const NUMERALS = ["I", "II", "III", "IV", "V", "VI", "VII"];
const MAJOR_SEMIS = [0, 2, 4, 5, 7, 9, 11];

/** Parse a Roman-numeral chord like "bVImaj7", "iiø7" or "Isus4". */
export function parseChord(sym: string): Chord {
  const m = /^([b#]?)(VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i)([°ø+]?)(.*)$/.exec(sym);
  if (!m) return { numeral: sym, root: 0, tones: [0, 4, 7] };
  const [, acc, num, q, suffix] = m;
  const upper = num === num.toUpperCase();
  const root = mod(MAJOR_SEMIS[NUMERALS.indexOf(num.toUpperCase())] + (acc === "b" ? -1 : acc === "#" ? 1 : 0), 12);
  let third = upper ? 4 : 3, fifth = 7;
  if (q === "°" || q === "ø") { third = 3; fifth = 6; }
  if (q === "+") fifth = 8;
  const seventh = q === "°" ? 9 : 10;
  let tones = [0, third, fifth];
  switch (suffix) {
    case "7": tones.push(seventh); break;
    case "maj7": tones.push(11); break;
    case "9": tones.push(seventh, 14); break;
    case "maj9": tones.push(11, 14); break;
    case "add9": tones.push(14); break;
    case "6": tones.push(9); break;
    case "sus2": tones = [0, 2, fifth]; break;
    case "sus4": tones = [0, 5, fifth]; break;
    case "7sus4": tones = [0, 5, fifth, 10]; break;
    case "5": tones = [0, 7, 12]; break;
  }
  if (q === "ø" && !tones.includes(10)) tones.push(10);
  return { numeral: sym, root, tones };
}

/** A readable chord name in a key, e.g. "Am7", "F#sus4", "Bbmaj9". */
export function chordName(c: Chord, key: number): string {
  const name = ROOTS[mod(key + c.root, 12)];
  const has = (n: number) => c.tones.some((t) => mod(t, 12) === n && !(n === 2 && t === 14));
  const nine = c.tones.includes(14);
  const q = has(4) && has(8) ? "+" : has(3) && has(6) ? (has(10) ? "ø" : "°") : has(3) ? "m" : has(4) ? "" : has(2) ? "sus2" : has(5) ? "sus4" : "5";
  let ext = "";
  if (q === "ø") ext = "7";
  else if (has(11)) ext = nine ? "maj9" : "maj7";
  else if (has(10)) ext = nine ? "9" : "7";
  else if (has(9)) ext = q === "°" ? "7" : "6";
  else if (nine) ext = "add9";
  return q.startsWith("sus") ? name + ext + q : name + q + ext;
}

/** One bar of drums as the generator would play it, for the ring view. */
export interface DrumStep {
  on: boolean;
  velocity: number;
  /** "base" is the pattern itself; "ghost" an extra from Variation; "fill" from a fill. */
  kind: "base" | "ghost" | "fill" | "off";
}

/** One bar's variations for a drum track. */
interface DrumVariation {
  /** Plays every hit a little early or late, as a share of a sixteenth. */
  nudge: number;
  /** Extra quiet hits in the gaps, by step, with their velocity. */
  ghost: Map<number, number>;
  /** Hits left out this bar. */
  drop: Set<number>;
  /** On the map: how far each step's weight is pushed this bar, or null for none. */
  chaos: Float32Array | null;
}

/** The melody's loop as the view draws it: Marbles' two random loops, rhythm and notes. */
export interface MelodyLoop {
  /** Whether each tick of the rhythm loop plays, and how loud. */
  ticks: { on: boolean; velocity: number }[];
  /** Each note of the note loop: 0..1 within the range (after Steps), and the raw value before it. */
  notes: { x: number; raw: number }[];
  /** The cells that played last, or -1. */
  tick: number;
  note: number;
}

/**
 * A generative sequencer in four parts. Drums are euclidean rings whose
 * density sets the number of hits, or patterns read off a Grids-style drum map
 * (see grids.ts), or both merged; variation adds ghost notes, drops and nudges
 * each bar, and on the map also jiggles each step's weight like Grids' chaos. Chords walk through a progression typical of their
 * style, and Variation swaps progressions and substitutes chords. The bass
 * follows the chord root, and the melody follows the scale and leans on chord
 * tones. Each part keeps a fixed random "gate" per step and plays every step
 * whose gate is under the chance its weights and density give it, so raising
 * a density only adds notes.
 *
 * Scheduling uses the usual Web Audio lookahead pattern: a timer schedules
 * sounds a little ahead on the audio clock, and the matching visual events
 * are queued so the animation loop can hand them to the model when they
 * become audible.
 */
export class Sequencer {
  state: SequencerState;
  playing = false;
  /** Step currently sounding, for the playhead. -1 when stopped. */
  current = -1;
  /** Where each drum track is in its own pattern, for the rings' playheads. */
  drumCurrent: number[] = DRUMS.map(() => -1);
  /** Bumped whenever the pattern changes, so views know to redraw. */
  version = 0;
  /** The chords this pass plays, after Variation's substitutions and with any approach chords. */
  cycle: Chord[] = [];
  /** How long each chord of `cycle` lasts, in sixteenths. */
  private lengths: number[] = [];
  /** Which chord of the progression each chord of `cycle` belongs to (approach chords share it). */
  private slots: number[] = [];
  /** The progression this pass plays, before approach chords are added. */
  private base: Chord[] = [];
  /** What each chord of the progression last became, for Déjà vu, and which progression that was. */
  private memory: Chord[] = [];
  private memoryKey = "";
  /** Which harmonic-rhythm pattern of its level this pass uses. */
  private rhythmPick = 0;
  /** The level of harmonic rhythm `cycle` was laid out for. */
  private rung = -1;
  /** Absolute sixteenths where the scheduled chord started and where the next one starts. */
  private chordStart = 0;
  private changeAt = 0;
  /** Which chord of `cycle` is sounding. */
  chordIndex = 0;
  /** Epic's key change, in semitones, for this pass of the progression. */
  lift = 0;
  private rng: () => number;
  /** This bar's variations per drum. */
  private drumVar: DrumVariation[] = [];
  /** Each drum's base pattern and step levels, kept until a control they depend on changes. */
  private drumCache: { key: string; base: boolean[]; euclid: boolean[]; levels: Float32Array }[] =
    DRUMS.map(() => ({ key: "", base: [], euclid: [], levels: new Float32Array(GRIDS_STEPS) }));
  private bassGate: number[] = [];
  private bassPick: number[] = [];
  private chordGate: number[] = [];
  private voicing: number[] = [];
  /** The melody's random loops, as on Marbles: one for its rhythm and one for its notes. */
  private tLoop: DejaVuSequence;
  private xLoop: DejaVuSequence;
  /** Spread and Bias as a distribution, shared with the view. */
  readonly distribution = new Distribution();
  /** Whether the last tick played, for Bursts. */
  private burstOn = false;
  /** Which cells of the melody's loops are sounding, for the view. */
  melodyCursor = { tick: -1, note: -1 };
  private bar = 0;
  private fillBar = false;
  private fillRequested = false;
  /** Absolute sixteenth being scheduled next, counted from Play. */
  private abs = 0;
  private nextTime = 0;
  private startTime = 0;
  private timer: number | undefined;
  private queue: { time: number; step: number; drumSteps: number[]; chord: number; melody: { tick: number; note: number }; events: NoteEvent[] }[] = [];
  /** Which chord the scheduler has reached (it runs a little ahead of what's heard). */
  private schedChord = -1;
  /** Called just before each bar is scheduled, so changes to the song can land on the bar. */
  onBar: (() => void) | null = null;

  constructor(private audio: AudioEngine, state?: SequencerState) {
    this.state = state ?? defaultState();
    this.rng = mulberry32(this.state.seed);
    this.tLoop = new DejaVuSequence(() => this.rng());
    this.xLoop = new DejaVuSequence(() => this.rng());
    this.generate();
  }

  get stepLength(): number {
    return 60 / this.state.tempo / 4;
  }

  /** The key's root, including Epic's lift. */
  get key(): number {
    return this.state.root + this.lift;
  }

  get chord(): Chord {
    return this.cycle[this.chordIndex] ?? this.cycle[0] ?? parseChord("I");
  }

  /** Start over from a fresh seed: new drums variations, gates, melody and progression. */
  newIdea(): void {
    this.state.seed = Math.floor(Math.random() * 2 ** 31);
    this.rng = mulberry32(this.state.seed);
    this.state.prog = Math.floor(this.rng() * 8);
    this.generate();
  }

  /** Start again from the seed the state holds, e.g. after the state was put back to how it was. */
  reload(): void {
    this.rng = mulberry32(this.state.seed);
    this.generate();
  }

  /**
   * Begin the progression again from its first chord at the next step the
   * scheduler reaches. Called from `onBar`, so a song that changed on the bar
   * starts its chords on the bar too, instead of partway through the old
   * cycle.
   */
  restartCycle(): void {
    this.schedChord = -1;
    this.chordIndex = 0;
    this.voicing = [];
  }

  /** Keep the musical clock continuous across a tempo change while playing. */
  tempoChanged(oldTempo: number): void {
    const ctx = this.audio.ctx;
    if (!this.playing || !ctx || oldTempo === this.state.tempo) return;
    this.startTime = ctx.currentTime - ((ctx.currentTime - this.startTime) * oldTempo) / this.state.tempo;
  }

  /**
   * A fresh start for one part while the others play on: new rhythm and notes
   * for the bass, a new progression for the chords, new loops for the melody.
   * (The drums' patterns come from their controls, so the panel rolls those.)
   */
  reroll(part: "drums" | "bass" | "chords" | "melody"): void {
    const r = this.rng;
    if (part === "drums") this.drumVar = DRUMS.map(() => ({ nudge: 0, ghost: new Map(), drop: new Set(), chaos: null }));
    if (part === "bass") {
      this.bassGate = Array.from({ length: STEPS }, r);
      this.bassPick = Array.from({ length: STEPS }, r);
    }
    if (part === "chords") {
      const n = this.progressions().length;
      this.state.prog = (this.state.prog + 1 + Math.floor(r() * Math.max(1, n - 1))) % n;
      this.chordGate = Array.from({ length: STEPS }, r);
      this.memory = [];
      this.refreshHarmony();
    }
    if (part === "melody") {
      this.tLoop.reseed();
      this.xLoop.reseed();
    }
    this.version++;
  }

  /** Play a fill at the end of the current bar. */
  fill(): void {
    const step = this.abs % STEPS;
    // Too late in this bar for a fill to be heard: play it at the end of the next one.
    if (this.playing && step > 0 && step <= 12) this.fillBar = true;
    else this.fillRequested = true;
    this.version++;
  }

  get fillPending(): boolean {
    return this.fillRequested || this.fillBar;
  }

  /** Rebuild the progression after the chord style or scale changed. */
  refreshHarmony(): void {
    this.buildCycle(false);
    this.chordIndex = Math.min(this.chordIndex, this.cycle.length - 1);
    this.schedChord = Math.min(this.schedChord, this.cycle.length - 1);
    this.version++;
  }

  private generate(): void {
    const r = this.rng;
    this.drumVar = DRUMS.map(() => ({ nudge: 0, ghost: new Map(), drop: new Set(), chaos: null }));
    this.bassGate = Array.from({ length: STEPS }, r);
    this.bassPick = Array.from({ length: STEPS }, r);
    this.chordGate = Array.from({ length: STEPS }, r);
    this.tLoop?.reseed();
    this.xLoop?.reseed();
    this.lift = 0;
    this.buildCycle(true);
    this.chordIndex = 0;
    this.voicing = [];
    // While playing, the scheduler is partway through the old cycle: point it
    // at a chord of the new one and voice it, or the chords would be sent with
    // no notes until the next change (empty chords reach the synth as NaN,
    // which silences the whole mix for good once it is in the echo).
    if (this.schedChord >= 0) {
      this.schedChord = Math.min(this.schedChord, this.cycle.length - 1);
      this.chordIndex = this.schedChord;
      this.voicing = this.voice(this.cycle[this.schedChord]);
    }
    this.version++;
  }

  private progressions(): string[] {
    const style = CHORD_STYLES[this.state.chordStyle] ?? CHORD_STYLES.pop;
    const steps = SCALES[this.state.scale]?.steps ?? [];
    return steps.includes(3) ? style.minor : style.major;
  }

  /** Set up the next pass of the progression. Variation may switch progression and substitute chords. */
  private buildCycle(first: boolean): void {
    const r = this.rng;
    const v = this.held("chords") || first ? 0 : this.vary(this.state.chordVariation);
    // Déjà vu, as on Marbles: how likely each change is to replay what this slot did last time instead of something new.
    const dv = this.state.chordDejaVu;
    const list = this.progressions();
    if (r() < v * 0.5 * (1 - dv)) this.state.prog = (this.state.prog + 1 + Math.floor(r() * (list.length - 1))) % list.length;
    const key = `${this.state.chordStyle}:${this.state.scale}:${mod(this.state.prog, list.length)}`;
    if (key !== this.memoryKey || first) {
      this.memory = [];
      this.memoryKey = key;
    }
    const syms = list[mod(this.state.prog, list.length)].split(" ");
    this.base = syms.map((s, i) => {
      if (this.memory[i] && v > 0 && r() < dv) return this.memory[i];
      const c = parseChord(s);
      return (this.memory[i] = r() < v * 0.45 ? this.substitute(c) : c);
    });
    if (first) this.rhythmPick = 0;
    else if (!this.held("chords") && r() < this.vary(this.state.chordRhythm) * 0.6 * (1 - dv)) this.rhythmPick = Math.floor(r() * 4);
    this.layout();
    // Epic's wildcard: some passes lift the whole song up a step or two, then it comes home.
    if (this.state.chordStyle === "epic" && !first && !this.held("chords")) {
      this.lift = this.lift === 0 && r() < v * 0.6 ? (r() < 0.5 ? 2 : 1) : 0;
    } else if (this.state.chordStyle !== "epic") {
      this.lift = 0;
    }
  }

  /** Which level of the style's harmonic rhythm Rhythm density reaches. */
  private rungIndex(): number {
    const style = CHORD_STYLES[this.state.chordStyle] ?? CHORD_STYLES.pop;
    let i = 0;
    while (i + 1 < style.changes.length && style.changes[i + 1].at <= this.state.chordDensity) i++;
    return i;
  }

  /** Lay this pass's progression out in time, adding approach chords where the pattern splits a chord. */
  private layout(): void {
    const style = CHORD_STYLES[this.state.chordStyle] ?? CHORD_STYLES.pop;
    this.rung = this.rungIndex();
    const { patterns } = style.changes[this.rung];
    const pattern = patterns[mod(this.rhythmPick, patterns.length)].split(" ");
    this.cycle = [];
    this.lengths = [];
    this.slots = [];
    this.base.forEach((c, i) => {
      const [len, approach] = pattern[i % pattern.length].split("+").map(Number);
      this.cycle.push(c);
      this.lengths.push(len);
      this.slots.push(i);
      if (approach) {
        this.cycle.push(this.approach(c, this.base[(i + 1) % this.base.length]));
        this.lengths.push(approach);
        this.slots.push(i);
      }
    });
  }

  /** A style-typical chord that leads from `c` into `next`. */
  private approach(c: Chord, next: Chord): Chord {
    let a: Chord;
    switch (this.state.chordStyle) {
      case "jazz":
        // The next chord's own dominant seventh.
        a = { numeral: `V7/${next.numeral}`, root: mod(next.root + 7, 12), tones: [0, 4, 7, 10] };
        break;
      case "dance":
        a = { numeral: `${next.numeral}sus4`, root: next.root, tones: [0, 5, 7] };
        break;
      case "epic":
        a = { numeral: `bVII/${next.numeral}`, root: mod(next.root - 2, 12), tones: [0, 4, 7] };
        break;
      default:
        a = { numeral: `V/${next.numeral}`, root: mod(next.root + 7, 12), tones: [0, 4, 7] };
    }
    // Leading in with the chord that's already playing would sound like no change at all:
    // jazz takes the tritone substitute instead, the others suspend the next chord.
    if (a.root === c.root) {
      a = this.state.chordStyle === "jazz"
        ? { numeral: `subV7/${next.numeral}`, root: mod(next.root + 1, 12), tones: [0, 4, 7, 10] }
        : { numeral: `${next.numeral}sus4`, root: next.root, tones: [0, 5, 7] };
    }
    return a;
  }

  /** A style-typical replacement for a chord. */
  private substitute(c: Chord): Chord {
    const r = this.rng;
    const minor = c.tones.includes(3) && !c.tones.includes(4);
    const major = c.tones.includes(4) && !c.tones.includes(3);
    switch (this.state.chordStyle) {
      case "jazz":
        // Tritone substitution for a dominant; otherwise a ninth on top.
        if (major && c.tones.includes(10)) return { numeral: `sub${c.numeral}`, root: mod(c.root + 6, 12), tones: c.tones };
        return { ...c, tones: c.tones.includes(14) ? c.tones : [...c.tones, 14] };
      case "pop":
        if (r() < 0.5) return { ...c, tones: c.tones.map((t) => (t === 3 || t === 4 ? (r() < 0.5 ? 2 : 5) : t)) };
        if (major) return { numeral: c.numeral, root: mod(c.root + 9, 12), tones: [0, 3, 7] };
        if (minor) return { numeral: c.numeral, root: mod(c.root + 3, 12), tones: [0, 4, 7] };
        return c;
      case "dance":
        return { ...c, tones: [...c.tones, r() < 0.5 ? 14 : minor ? 10 : 11] };
      case "epic":
        // A chromatic mediant or a bare power chord.
        if (r() < 0.5) return { numeral: c.numeral, root: mod(c.root + (r() < 0.5 ? 4 : 8), 12), tones: [0, 4, 7] };
        return { ...c, tones: [0, 7, 12] };
    }
    return c;
  }

  /** Each bar, let every part stray from its pattern by its own Variation. */
  private evolve(): void {
    this.bar++;
    this.fillBar = this.fillRequested;
    this.fillRequested = false;
    const s = this.state;
    const style = STYLES[s.style] ?? STYLES.broken;
    const drumV = this.vary(Math.max(s.kickVariation, s.snareVariation, s.hatVariation));
    if (!this.fillBar && drumV > 0.15 && this.bar % 4 === 3 && this.rng() < drumV * style.fills) this.fillBar = true;
    const r = this.rng;
    if (!this.held("drums")) {
      DRUMS.forEach((d, i) => {
        const v = this.vary(this.num(`${d.key}Variation`));
        const dv: DrumVariation = { nudge: 0, ghost: new Map<number, number>(), drop: new Set<number>(), chaos: null };
        const len = this.length(d.key);
        const start = this.rotation(d.key);
        const base = this.basePattern(i);
        const mode = this.mode(d.key);
        if (mode !== "euclid" && v > 0) {
          // Like Grids' chaos: every step's weight is pushed up or down a little each bar,
          // so weak steps come and go and, with a lot of Variation, strong ones can drop out.
          dv.chaos = Float32Array.from({ length: len }, () => (r() - 0.5) * v * 0.7);
        }
        if (mode !== "grids" && r() < v * 0.9) {
          // Ghost notes in the gaps; hats get more of them.
          const n = 1 + Math.floor(r() * (1 + v * (d.key === "hat" ? 4 : 2)));
          for (let k = 0; k < n; k++) {
            const pos = Math.floor(r() * len);
            if (!base[pos]) dv.ghost.set(pos, 0.25 + 0.3 * r());
          }
        }
        if (r() < v * 0.5) {
          // Leave a hit out, but never the kick that starts the pattern.
          const hits = base.map((on, k) => (on ? k : -1)).filter((k) => k >= 0 && !(d.key === "kick" && k === start));
          if (hits.length > 1) dv.drop.add(hits[Math.floor(r() * hits.length)]);
        }
        // A slight push or drag in timing, never more than a tenth of a sixteenth.
        if (v > 0.3 && r() < v * 0.5) dv.nudge = (r() < 0.5 ? -1 : 1) * (0.02 + 0.08 * v * r());
        this.drumVar[i] = dv;
      });
    }
    if (!this.held("bass")) {
      for (let i = 0; i < STEPS; i++) {
        if (r() < this.vary(s.bassVariation) * 0.3) this.bassGate[i] = r();
        if (r() < this.vary(s.bassVariation) * 0.35) this.bassPick[i] = r();
      }
    }
    if (!this.held("chords")) {
      for (let i = 0; i < STEPS; i++) if (r() < this.vary(s.chordRhythm) * 0.3 * (1 - s.chordDejaVu)) this.chordGate[i] = r();
    }
    this.version++;
  }

  /** Whether a track is heard: not muted, and soloed if any track is. */
  audible(track: TrackKey): boolean {
    const s = this.state;
    if (!s[`${track}On`]) return false;
    const solo = s.drumsSolo || s.bassSolo || s.chordsSolo || s.melodySolo;
    return !solo || s[`${track}Solo`];
  }

  /** The mixer and master effects as the audio engine wants them. */
  mixSettings(): MixSettings {
    const s = this.state;
    const track = (k: TrackKey) => ({ volume: faderGain(s[`${k}Volume`]), pan: s[`${k}Pan`], echo: s[`${k}Echo`], space: s[`${k}Space`] });
    return {
      master: s.masterVolume,
      tracks: { drums: track("drums"), bass: track("bass"), chords: track("chords"), melody: track("melody") },
      drums: DRUMS.map((d) => ({ volume: faderGain(this.num(`${d.key}Volume`)), pan: this.num(`${d.key}Pan`) })),
      echoTime: this.stepLength * ECHO_TIMES[s.echoTime],
      echoFeedback: s.echoFeedback,
      spaceSize: s.spaceSize,
    };
  }

  /** A drum's own sound controls. */
  drumSound(key: DrumKey): DrumSound {
    return { pitch: this.num(`${key}Pitch`), decay: this.num(`${key}Decay`), tone: this.num(`${key}Tone`) };
  }

  /** A synth track's sound as a Plaits patch; MIDI keyboard notes play through the melody's. */
  patch(track: SynthTrack): Patch {
    const s = this.state;
    const p = SOUND_PREFIX[track];
    const n = (k: string) => this.num(`${p}${k}`);
    const engine = ENGINES.indexOf((s as unknown as Record<string, string>)[`${p}Engine`] as EngineName);
    const chords = track === "chords";
    const beat = 60 / s.tempo;
    return {
      engine: Math.max(0, engine),
      harmonics: n("Harmonics"), timbre: n("Timbre"), morph: n("Morph"),
      timbreEnv: n("TimbreEnv"), morphEnv: n("MorphEnv"), decay: n("Decay"), colour: n("Colour"),
      // Steps below the middle is Marbles' smooth side: the melody slides between its notes.
      glide: track === "chords" ? 0 : track === "melody" ? Math.max(n("Glide"), 0.75 * this.melodySmooth) : n("Glide"),
      attack: track === "bass" ? 0 : n("Attack"),
      sub: track === "bass" ? s.bassSub : 0,
      inversion: chords ? s.chordInversion : 0.5,
      strum: chords ? s.chordStrum : 0,
      wobbleHz: 1 / (beat * WOBBLE_RATES[Math.max(0, Math.min(WOBBLE_RATES.length - 1, Math.round(s.chordWobbleRate)))]),
      wobbleDepth: chords ? s.chordWobble : 0,
    };
  }

  /** Whether a part is frozen, by its own Hold or the global one. */
  held(part: "drums" | "bass" | "chords" | "melody"): boolean {
    return this.state.hold || this.state[`${part}Hold`];
  }

  /** A part's density after Energy, which pushes every density down or up; a part set to none stays silent. */
  dens(v: number): number {
    return v <= 0 ? 0 : Math.max(0, Math.min(1, v + (this.state.energy - 0.5) * 0.7));
  }

  /** A part's variation after Evolve, which scales every variation: none at 0, double at 1. */
  vary(v: number): number {
    return Math.max(0, Math.min(1, v * this.state.evolve * 2));
  }

  // ---- Drums ----------------------------------------------------------------

  private num(key: string): number {
    return (this.state as unknown as Record<string, number>)[key];
  }

  /** How many steps a drum track's pattern has. */
  length(key: DrumKey): number {
    return Math.max(1, Math.min(MAX_DRUM_LENGTH, Math.round(this.num(`${key}Length`))));
  }

  /** How many euclidean hits a drum track has at its density; density is per bar, so longer patterns get more. */
  pulses(key: DrumKey): number {
    const d = this.dens(this.num(`${key}Density`));
    const max = DRUMS.find((x) => x.key === key)!.max;
    const len = this.length(key);
    return d <= 0 ? 0 : Math.max(1, Math.min(len, Math.round((d * max * len) / STEPS)));
  }

  /** Where the track's pattern starts (its Offset). */
  rotation(key: DrumKey): number {
    return mod(Math.round(this.num(`${key}Rotate`)), this.length(key));
  }

  /** Which step of its pattern a drum track is on at absolute sixteenth `a`, after its resets. */
  drumPos(i: number, a: number): number {
    const key = DRUMS[i].key;
    const bars = Number((this.state as unknown as Record<string, string>)[`${key}Reset`]) || 0;
    const since = bars > 0 ? a % (bars * STEPS) : a;
    return since % this.length(key);
  }

  /** How a drum track makes its pattern: "euclid", "grids" or "both". */
  mode(key: DrumKey): string {
    return (this.state as unknown as Record<string, string>)[`${key}Mode`];
  }

  /**
   * Which map step a track reads at step `pos` of its pattern. The map's grooves are
   * written against the bar, so Offset (which places the euclidean hits) leaves them be;
   * Steps under 32 plays the first part of the map's two-bar pattern.
   */
  private mapStep(pos: number): number {
    return pos % GRIDS_STEPS;
  }

  /** Builds (or reuses) a track's bare pattern and its map levels. */
  private drumPattern(i: number): { base: boolean[]; euclid: boolean[]; levels: Float32Array } {
    const d = DRUMS[i];
    const s = this.state;
    const mode = this.mode(d.key);
    const len = this.length(d.key), rot = this.rotation(d.key), pulses = this.pulses(d.key);
    const fill = this.dens(this.num(`${d.key}Fill`));
    const cache = this.drumCache[i];
    const key = `${mode}|${len}|${rot}|${pulses}|${fill}|${s.gridsX}|${s.gridsY}`;
    if (cache.key === key) return cache;
    cache.key = key;
    cache.euclid = mode === "grids" ? new Array<boolean>(len).fill(false) : euclid(pulses, len, rot);
    cache.base = cache.euclid.slice();
    if (mode !== "euclid") {
      gridsLevels(i, s.gridsX, s.gridsY, cache.levels);
      const threshold = gridsThreshold(fill);
      for (let k = 0; k < len; k++) if (cache.levels[this.mapStep(k)] > threshold) cache.base[k] = true;
    }
    return cache;
  }

  /** The bare pattern of a track (euclidean, map or both), without this bar's variations. */
  basePattern(i: number): boolean[] {
    return this.drumPattern(i).base;
  }

  /** Whether a track's pattern has any hits at all, so fills and ghosts stay off an empty one. */
  private hasHits(i: number): boolean {
    return this.drumPattern(i).base.includes(true);
  }

  /**
   * Whether a track plays at step `pos` of its own pattern. `step` is the
   * sixteenth within the bar, for accents and fills (which always land at the
   * end of a bar); -1 leaves fills out, for views of a pattern that isn't a bar long.
   */
  drumHit(i: number, pos: number, step: number, fill = this.fillBar): DrumStep {
    const d = DRUMS[i];
    const style = STYLES[this.state.style] ?? STYLES.broken;
    const dv = this.drumVar[i];
    const { base, euclid: euclidHits, levels } = this.drumPattern(i);
    const mode = this.mode(d.key);
    const level = style.level;
    if (fill && step >= 12 && d.key !== "kick" && this.hasHits(i)) {
      // Rolls build through the last beat.
      const w = FILL_WEIGHT[step - 12] * (d.key === "snare" ? 1 : 0.8);
      if (base[pos] || w > 0.6) return { on: true, velocity: Math.min(1, (0.55 + 0.1 * (step - 12) + 0.2 * w) * level), kind: base[pos] ? "base" : "fill" };
    }
    const accent = ACCENT[step >= 0 ? step : pos % STEPS];
    let velocity = (0.45 + 0.5 * accent) * level;
    let on = base[pos];
    let kind: DrumStep["kind"] = "base";
    if (mode !== "euclid") {
      // On the map, a step's weight is its loudness, and Variation's chaos can push it over or under the line.
      const w = levels[this.mapStep(pos)];
      const fillAmount = this.dens(this.num(`${d.key}Fill`));
      const jiggled = w + (dv.chaos?.[pos] ?? 0);
      const mapOn = fillAmount > 0 && w > 0.05 && jiggled > gridsThreshold(fillAmount);
      const euclidOn = euclidHits[pos];
      if (mapOn) velocity = Math.max(euclidOn ? velocity : 0, (0.35 + 0.65 * Math.min(1, w)) * level);
      if (mapOn && !on) kind = "ghost";
      on = euclidOn || mapOn;
    }
    if (on && !dv.drop.has(pos)) return { on: true, velocity, kind };
    const ghost = dv.ghost.get(pos);
    if (ghost !== undefined && this.hasHits(i)) return { on: true, velocity: ghost * level, kind: "ghost" };
    return { on: false, velocity: 0, kind: "off" };
  }

  // ---- Harmony --------------------------------------------------------------

  /** Whether a new chord starts at absolute sixteenth `a` (at or after the one being scheduled). */
  private isChange(a: number): boolean {
    return a === this.chordStart || a >= this.changeAt;
  }

  private advanceChord(a: number): void {
    // Rhythm density moved to another level: lay the pass out again and carry on with the next chord of the progression.
    if (this.schedChord >= 0 && this.rungIndex() !== this.rung) {
      const slot = this.slots[this.schedChord];
      this.layout();
      const nextSlot = this.slots.indexOf(slot + 1);
      this.schedChord = (nextSlot < 0 ? this.cycle.length : nextSlot) - 1;
    }
    this.schedChord++;
    if (this.schedChord >= this.cycle.length) {
      this.buildCycle(false);
      this.schedChord = 0;
    }
    this.chordStart = a;
    this.changeAt = a + (this.lengths[this.schedChord] ?? STEPS);
    this.voicing = this.voice(this.cycle[this.schedChord]);
    this.version++;
  }

  /** Voice a chord near the last one, so the changes move smoothly. */
  private voice(c: Chord): number[] {
    const pc = mod(this.key + c.root, 12);
    const tones = [...new Set(c.tones)].sort((a, b) => a - b);
    const prev = this.voicing.length ? this.voicing : [57, 60, 64, 67];
    let best: number[] = tones.map((t) => 48 + pc + t);
    let bestCost = Infinity;
    for (let inv = 0; inv < tones.length; inv++) {
      for (const oct of [36, 48, 60]) {
        const notes = tones.map((t, i) => oct + pc + t + (i < inv ? 12 : 0)).sort((a, b) => a - b);
        if (notes[0] < 50 || notes[notes.length - 1] > 80) continue;
        const mean = notes.reduce((a, b) => a + b, 0) / notes.length;
        let cost = Math.abs(mean - 63) * 0.4;
        notes.forEach((n, i) => (cost += Math.abs(n - prev[Math.min(i, prev.length - 1)]) / notes.length));
        if (cost < bestCost) { bestCost = cost; best = notes; }
      }
    }
    this.voicing = best;
    return best;
  }

  private chordOn(a: number): boolean {
    const s = this.state;
    if (!this.audible("chords") || s.chordDensity <= 0) return false;
    if (this.isChange(a)) return true;
    const style = CHORD_STYLES[s.chordStyle] ?? CHORD_STYLES.pop;
    const step = a % STEPS;
    return this.chordGate[step] < chance(style.rhythm[step], this.dens(s.chordDensity));
  }

  // ---- Bass -------------------------------------------------------------------

  private bassOn(a: number): boolean {
    const s = this.state;
    if (!this.audible("bass") || s.bassDensity <= 0) return false;
    const style = BASS_STYLES[s.bassStyle] ?? BASS_STYLES.pulse;
    if (style.onChange && this.isChange(a)) return true;
    const step = a % STEPS;
    return this.bassGate[step] < chance(style.weights[step], this.dens(s.bassDensity));
  }

  private bassNote(a: number, c: Chord, next: Chord): number {
    const s = this.state;
    const step = a % STEPS;
    const pick = this.bassPick[step];
    const third = c.tones.find((t) => t === 3 || t === 4 || t === 2 || t === 5) ?? 7;
    const seventh = c.tones.find((t) => t === 10 || t === 11 || t === 9) ?? 10;
    const pool = [0, 12, 7, third, -5, seventh, 2].slice(0, Math.max(1, Math.round(s.bassRange)));
    const any = () => pool[Math.floor(pick * pool.length)];
    let interval = 0;
    switch (s.bassStyle) {
      case "octave":
        interval = step % 4 < 2 ? 0 : pool.length > 1 ? 12 : 0;
        if (pool.length > 2 && pick > 0.8) interval = 7;
        break;
      case "walk": {
        if (a === this.chordStart) break;
        const toNext = this.changeAt - a <= 4;
        if (toNext && pool.length >= 3) {
          // Approach the next chord's root from a semitone away.
          let target = mod(next.root - c.root, 12);
          if (target > 6) target -= 12;
          interval = target + (pick < 0.5 ? -1 : 1);
        } else interval = any();
        break;
      }
      case "drone":
        interval = step === 8 && pool.length > 1 ? pool[1 + Math.floor(pick * (pool.length - 1))] : 0;
        break;
      default:
        interval = step % 8 === 0 && pick < 0.7 ? 0 : any();
    }
    let base = 36 + mod(this.key + c.root, 12);
    if (base > 43) base -= 12;
    return base + interval;
  }

  // ---- Melody -----------------------------------------------------------------
  //
  // After Marbles: a clock ticks at the melody's Rate; on each tick the rhythm
  // loop decides whether a note plays, and each note takes the next value of the
  // note loop, shapes it with Spread and Bias and snaps it to the notes Steps
  // allows. Déjà vu decides how often each loop takes a new value.

  /** Déjà vu after Evolve: below the middle Evolve leans towards a locked loop, above it towards fresh values. */
  private dejaVu(): number {
    const { melodyDejaVu: dv, evolve } = this.state;
    if (evolve < 0.5) return dv + (0.5 - dv) * (1 - evolve * 2);
    const more = (evolve - 0.5) * 2;
    return dv <= 0.5 ? dv * (1 - more) : dv + (1 - dv) * more;
  }

  /** Set both loops from the controls. */
  private setLoops(): void {
    const s = this.state;
    const dv = this.dejaVu();
    this.tLoop.dejaVu = s.melodyLoop === "notes" ? 0 : dv;
    this.xLoop.dejaVu = s.melodyLoop === "rhythm" ? 0 : dv;
    this.tLoop.setLength(s.melodyLength);
    this.xLoop.setLength(s.melodyLength);
    this.distribution.set(s.melodySpread, s.melodyBias);
  }

  /** Sixteenths per tick of the melody's clock. */
  get melodyDiv(): number {
    return MELODY_RATES[this.state.melodyRate] ?? 2;
  }

  /** Whether tick number `tick` plays, from its rhythm-loop value and (for Bursts) whether the last tick did. */
  private tickOn(tick: number, u: number, lastOn: boolean): boolean {
    const s = this.state;
    const density = this.dens(s.melodyDensity);
    if (density <= 0) return false;
    switch (s.melodyRhythm) {
      case "steady":
        return STEADY[Math.min(STEADY.length - 1, Math.round(density * (STEADY.length - 1)))][tick % 8] === "1";
      case "bursts":
        // Notes come in runs: after a note, another is likely; after a rest, a new run is rarer.
        return u < (lastOn ? 0.35 + 0.6 * density : 0.6 * density * density);
      default: {
        // A coin toss, weighted a little towards the beat.
        const step = (tick * this.melodyDiv) % STEPS;
        return u < chance(0.55 + 0.45 * MELODY_WEIGHT[step], density);
      }
    }
  }

  /** The notes the melody may use over a chord, as weights per pitch class. */
  private melodyWeights(c: Chord): Uint8Array {
    return pitchWeights(mod(this.key, 12), this.scaleSteps(), mod(this.key + c.root, 12), c.tones);
  }

  /** The lowest note of the melody's range and how many semitones it covers, centred on the key's root near middle C. */
  private melodyRange(): { low: number; span: number } {
    const key = mod(this.key, 12);
    const root = 60 + (key > 6 ? key - 12 : key);
    const span = this.state.melodyOctaves * 12;
    return { low: root - span / 2, span };
  }

  /** A note from a note-loop value over a chord, and where it sits in the range. */
  private marblesNote(u: number, weights: Uint8Array): { note: number; x: number; raw: number } {
    const { low, span } = this.melodyRange();
    const raw = this.distribution.sample(u);
    const note = quantize(low + raw * span, weights, stepsLevel(this.state.melodySteps));
    return { note, x: Math.min(1, Math.max(0, (note - low) / span)), raw };
  }

  /** Play the melody's tick at absolute sixteenth `a`, if it has one there. */
  private melodyTick(a: number, time: number, c: Chord, events: NoteEvent[]): void {
    const s = this.state;
    const div = this.melodyDiv;
    if (a % div !== 0) return;
    this.setLoops();
    const held = this.held("melody");
    const seed = this.tLoop.next(held);
    const tick = Math.floor(a / div);
    const on = this.tickOn(tick, spread(seed, 0), this.burstOn);
    this.burstOn = on;
    if (!on) return;
    const { note: n, x } = this.marblesNote(this.xLoop.next(held), this.melodyWeights(c));
    if (!this.audible("melody")) return;
    const note = n + 12 * s.melodyOctave;
    const step = a % STEPS;
    const velocity = Math.min(1, 0.5 + 0.3 * MELODY_WEIGHT[step] + 0.2 * spread(seed, 2));
    // Jitter, as on Marbles, makes the clock wander: each note lands a little early or late.
    const len = this.stepLength * div;
    const jitter = s.melodyJitter ** 2 * 0.45 * (spread(seed, 1) * 2 - 1) * len;
    const t = Math.max(this.audio.ctx?.currentTime ?? 0, time + jitter);
    events.push({ note, velocity, role: "tone", x, source: "sequencer" });
    if (s.sound) this.audio.note("melody", [note], velocity, t, len * (0.15 + 1.35 * s.melodyLegato));
  }

  /** The melody's two loops as they stand, for the view. */
  melodyLoop(): MelodyLoop {
    this.setLoops();
    const L = this.tLoop.length;
    const weights = this.melodyWeights(this.chord);
    const ticks: MelodyLoop["ticks"] = [];
    let last = false;
    for (let k = 0; k < L; k++) {
      const seed = this.tLoop.cell(k);
      const on: boolean = this.audible("melody") && this.tickOn(k, spread(seed, 0), last);
      last = on;
      ticks.push({ on, velocity: 0.5 + 0.5 * spread(seed, 2) });
    }
    const notes: MelodyLoop["notes"] = [];
    for (let k = 0; k < this.xLoop.length; k++) {
      const { x, raw } = this.marblesNote(this.xLoop.cell(k), weights);
      notes.push({ x, raw });
    }
    return { ticks, notes, tick: this.melodyCursor.tick, note: this.melodyCursor.note };
  }

  /** Which notes the melody may play over the sounding chord at its Steps, as 0..1 heights in its range, with their weights. */
  melodyLadder(): { x: number; weight: number }[] {
    const { low, span } = this.melodyRange();
    const weights = this.melodyWeights(this.chord);
    const level = stepsLevel(this.state.melodySteps);
    const out: { x: number; weight: number }[] = [];
    for (let n = Math.ceil(low); n <= low + span; n++) {
      const pc = mod(n, 12);
      if (quantize(n, weights, level) === n) out.push({ x: (n - low) / span, weight: weights[pc] });
    }
    return out;
  }

  /** How much the melody glides between notes, from the smooth half of Steps. */
  get melodySmooth(): number {
    return smoothness(this.state.melodySteps);
  }

  private scaleSteps(): number[] {
    return SCALES[this.state.scale]?.steps ?? SCALES.minorPent.steps;
  }

  // ---- Transport ----------------------------------------------------------------

  start(): void {
    if (this.playing) return;
    const ctx = this.audio.ensure();
    this.playing = true;
    this.abs = 0;
    this.bar = 0;
    this.schedChord = -1;
    this.nextTime = ctx.currentTime + 0.06;
    this.startTime = this.nextTime;
    this.schedule();
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  stop(): void {
    this.playing = false;
    this.current = -1;
    this.drumCurrent = DRUMS.map(() => -1);
    this.melodyCursor = { tick: -1, note: -1 };
    this.queue = [];
    this.chordIndex = 0;
    window.clearInterval(this.timer);
  }

  /** Musical time in quarter notes, for tempo-synced LFOs. */
  beats(nowSeconds: number): number {
    if (this.playing && this.audio.ctx) return ((this.audio.ctx.currentTime - this.startTime) * this.state.tempo) / 60;
    return (nowSeconds * this.state.tempo) / 60;
  }

  private schedule(): void {
    const ctx = this.audio.ctx;
    if (!ctx || !this.playing) return;
    const s = this.state;
    while (this.nextTime < ctx.currentTime + 0.12) {
      const a = this.abs;
      const step = a % STEPS;
      if (step === 0 && a > 0) this.evolve();
      if (step === 0 && this.onBar) this.onBar();
      if (this.schedChord < 0 || a >= this.changeAt) this.advanceChord(a);
      const c = this.cycle[this.schedChord];
      const next = this.cycle[(this.schedChord + 1) % this.cycle.length];
      const len = this.stepLength;
      // Swing delays every second sixteenth.
      const t = this.nextTime + (step % 2 === 1 ? s.swing * len * 0.5 : 0);
      const events: NoteEvent[] = [];

      const drumSteps = DRUMS.map((_, i) => this.drumPos(i, a));
      if (this.audible("drums")) {
        DRUMS.forEach((d, i) => {
          if (!this.state[`${d.key}On`]) return;
          const hit = this.drumHit(i, drumSteps[i], step);
          if (!hit.on) return;
          events.push({ note: d.note, velocity: hit.velocity, role: d.role, x: 0.5, source: "sequencer" });
          if (s.sound) this.audio.drum(d.key, hit.velocity, Math.max(ctx.currentTime, t + this.drumVar[i].nudge * len), this.drumSound(d.key));
        });
      }

      if (this.bassOn(a)) {
        const style = BASS_STYLES[s.bassStyle] ?? BASS_STYLES.pulse;
        const note = this.bassNote(a, c, next) + 12 * s.bassOctave;
        let gap = 1;
        while (gap < 16 && !this.bassOn(a + gap) && !this.isChange(a + gap)) gap++;
        const velocity = 0.55 + 0.4 * (style.weights[step] || 0.5);
        events.push({ note, velocity, role: "bassline", x: Math.min(1, Math.max(0, (note - 24) / 31)), source: "sequencer" });
        if (s.sound) this.audio.note("bass", [note], velocity, t, len * Math.max(0.5, gap * style.legato) * 0.95);
      }

      if (this.chordOn(a)) {
        const style = CHORD_STYLES[s.chordStyle] ?? CHORD_STYLES.pop;
        let gap = 1;
        while (gap < 64 && !this.chordOn(a + gap)) gap++;
        const change = a === this.chordStart;
        const velocity = change ? 0.85 : 0.45 + 0.4 * style.rhythm[step];
        let notes = this.voicing.length ? this.voicing : this.voice(c);
        // Epic doubles the chord an octave below and above.
        if (s.chordStyle === "epic") notes = [notes[0] - 12, ...notes, notes[notes.length - 1] + 12];
        if (s.chordOctave) notes = notes.map((n) => n + 12 * s.chordOctave);
        const mean = notes.reduce((x, y) => x + y, 0) / notes.length;
        events.push({ note: 48 + mod(this.key + c.root, 12), notes, velocity, role: "chord", x: Math.min(1, Math.max(0, (mean - 50) / 26)), source: "sequencer" });
        if (s.sound) this.audio.note("chords", notes, velocity, t, len * Math.max(0.6, gap * style.legato));
      }

      this.melodyTick(a, t, c, events);

      this.queue.push({ time: t, step, drumSteps, chord: this.schedChord, melody: { tick: this.tLoop.position, note: this.xLoop.position }, events });
      this.nextTime += len;
      this.abs++;
    }
  }

  /** Events that are audible by now. Call once per animation frame. */
  drain(): NoteEvent[] {
    const ctx = this.audio.ctx;
    if (!ctx || this.queue.length === 0) return [];
    const out: NoteEvent[] = [];
    while (this.queue.length && this.queue[0].time <= ctx.currentTime) {
      const q = this.queue.shift()!;
      this.current = q.step;
      this.drumCurrent = q.drumSteps;
      this.melodyCursor = q.melody;
      if (q.chord !== this.chordIndex) {
        this.chordIndex = q.chord;
        this.version++;
      }
      out.push(...q.events);
    }
    return out;
  }
}
