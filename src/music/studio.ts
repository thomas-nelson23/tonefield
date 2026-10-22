import { SILENT_MUSIC, type ModRoute, type ModelDefinition, type MusicFrame, type NoteEvent, type ParamSpec, type ParamValues, type ReactionSource } from "../models/types";
import { noteHue } from "../models/lib/music";
import { COLOUR_SCHEMES } from "../models/lib/visual";
import { paintRange, renderParamControls, type ControlOptions, type ParamControls } from "../ui/controls";
import type { Grade } from "../ui/grade";
import { knob, fader, type Dial } from "../ui/knob";
import { LiveOverlay, bar, q } from "../ui/overlay";
import { segmented } from "../ui/segmented";
import { AudioEngine, BeatDetector, type DrumKind, type SynthTrack, type TrackKey } from "./audio";
import { dispatchMidi, openMidi, type MidiInputs } from "./midi";
import { applyModulation, applyReactions, macroSpecs, modulatable, ModSources, SOURCES, sourceLabel, type NumberSpec } from "./modulation";
import {
  BUILT_IN_PRESETS, GLOBAL_SPECS, applyEnergy, defaultGlobals, gradeOf, matchesPreset, presetValues, sanitizeGlobals, setHidden,
  type GlobalPreset,
} from "./globals";
import {
  BASS_STYLES, CHORD_STYLES, ENGINE_CHOICES, SOUND_DEFAULTS, WOBBLE_RATE_LABELS, DRUM_MODES, DRUM_RESETS, DRUMS, ECHO_TIME_LABELS, MAX_DRUM_LENGTH, MELODY_LOOPS, MELODY_PRESETS, MELODY_RATE_LABELS, MELODY_RATES, MELODY_RHYTHMS, ROOTS, SCALES, SOUND_PRESETS,
  STEPS, STYLES, TRACKS, Sequencer, applyStyleDensities, chordName, faderGain, sanitizeState, type DrumKey, type SequencerState,
} from "./sequencer";
import { GRIDS_COLS, GRIDS_ROWS, gridsName } from "./grids";
import { DICE_ICON, SWITCH_CHANCE, between, chance, pick, pickOther, randomStep, rollChoice, rollNumber, type RollLevel } from "../roll";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface GlobalSettings {
  seq: SequencerState;
  thru: boolean;
  decay: number;
  /** Seconds the audio bands take to follow a change when a route reads them. */
  smoothing: number;
  inputs: string[];
  /** CC number -> target: `macro#<slot>` (any model), `glob#<key>`, `gen#<key>` or `<modelId>/<paramKey>`. */
  bindings: Record<string, string>;
  dockHidden: boolean;
  /** Master switch: when off, no routes push and no notes reach the model. */
  musicOn: boolean;
  /** Scales every route on every model, 0..2. */
  intensity: number;
  /** Global Controls, as the user set them (see globals.ts). */
  globals: ParamValues;
  /** Global Control presets the user saved, after the built-in ones. */
  presets: GlobalPreset[];
  /** The mixer strip whose controls are open: a track or "master". */
  mixerTrack: TrackKey | "master";
  /** The drum voice whose controls are open in the Drums panel. */
  drumVoice: DrumKey;
  /** Whether each synth track shows its pattern or its sound. */
  trackViews?: Record<string, string>;
}

/**
 * Bump when models' default routes change enough that saved per-model
 * settings should be replaced by the new defaults.
 */
const MODEL_SETTINGS_VERSION = 6;

/** One of the model's built-in reactions, as a row in the modulation matrix. */
interface ReactionRow {
  source: ReactionSource;
  /** How strongly the model reacts, 0..2; 1 is as designed. */
  amount: number;
  off?: boolean;
}

interface ModelSettings {
  v: number;
  macros: Record<string, number>;
  routes: ModRoute[];
  /** The model's built-in reactions still in the matrix; a deleted one is left out. */
  reactions: ReactionRow[];
}

/** What older saves kept instead of reaction rows: the reactions switched off. */
type SavedModelSettings = ModelSettings & { muted?: ReactionSource[] };

/** The global controls a route can push. */
const GLOBAL_NUMBERS = GLOBAL_SPECS.filter((p): p is NumberSpec => p.kind === "number");

/** Seconds between redraws of the live meters, playheads and modulation bars: about 20 a second. */
const UI_INTERVAL = 0.04;
/**
 * The live UI slows down while frames are slow. Every tick that changes a
 * panel makes WebKitGTK repaint the window as one rectangle (its drawing area
 * paints the bounds of what changed once the canvas is part of it), so on a
 * machine where that repaint is the cost, fewer ticks are most of the cure:
 * at 25 ticks a second the panels cost about as much as the picture.
 */
const UI_INTERVAL_SLOW = 1 / 14;
const UI_INTERVAL_SLOWER = 1 / 9;

const SYNTH_TRACKS: SynthTrack[] = ["bass", "chords", "melody"];

/** What the dice never touch in the music: mutes, holds, solos, volumes and pans stay as set. */
const MUSIC_KEEPS = /^(sound|hold)$|Hold$|On$|Solo$|Volume$|Pan$/;
/** The useful part of some music controls' ranges, for the dice. */
const MUSIC_BANDS: Record<string, [number, number]> = {
  tempo: [84, 148], swing: [0, 0.5], energy: [0.3, 0.8], evolve: [0.3, 0.8],
  bassRange: [1, 5], melodyOctaves: [1, 2.5], melodyLength: [4, 16], melodyRate: [1, 3],
};

/** What `Studio.snapshot` keeps: the global controls, the model's macros and matrix, and the music's controls. */
export interface StudioSnapshot {
  globals: ParamValues;
  model: { id: string; settings: ModelSettings };
  seq: ParamValues;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const choices = (rec: Record<string, { label: string }>) => Object.entries(rec).map(([value, o]) => ({ value, label: o.label }));
const signed = (v: number, unit: string) => `${v > 0 ? "+" : ""}${v}${unit}`;
const decibels = (gain: number) => (gain <= 0.0001 ? "-∞ dB" : `${signed(Number((20 * Math.log10(gain)).toFixed(1)), " dB")}`);
const panLabel = (v: number) => (Math.abs(v) < 0.005 ? "C" : `${v < 0 ? "L" : "R"}${Math.round(Math.abs(v) * 100)}`);
const octaves = (v: number) => (v === 0 ? "0" : signed(v, " oct"));
const STEPS_LABELS = ["Slide", "Scale", "Chord", "Triad", "Root + 5th", "Root"];
const stepsIndex = (v: number) => 1 + Math.min(4, Math.floor(((v - 0.5) / 0.5) * 5));
const dejaVuLabel = (v: number) => (v < 0.04 ? "Always new" : v < 0.47 ? `${Math.round((1 - (2 * v - 1) ** 2) * 100)}% repeat` : v <= 0.53 ? "Locked" : "Shuffled");
const BASS_RANGE_LABELS = ["Root only", "+ octave", "+ fifth", "+ third", "+ low fifth", "+ seventh", "+ passing"];
/** The drum map pad's height and the margin round its grid, in CSS pixels. */
const PAD_WIDTH = 150;
const PAD_HEIGHT = 104;
const PAD_INSET = 8;
/** Drum ring radii as a share of the canvas radius, kick innermost. */
const RING_RADII = [0.4, 0.68, 0.94];

/** The running sequencer, so drum readouts can show hits for the pattern's current length. */
let liveSeq: Sequencer | null = null;

function drumSpecs(key: DrumKey): ParamSpec[] {
  return [
    { kind: "choice", key: `${key}Mode`, label: "Mode", options: DRUM_MODES, default: "euclid",
      description: "Euclidean spreads Density's hits evenly; Grids reads a pattern off the drum map; Both plays the two together." },
    { kind: "number", key: `${key}Density`, label: "Density", min: 0, max: 1, step: 0.01, default: 0.3,
      format: () => {
        const n = liveSeq?.pulses(key) ?? 0;
        return `${n} hit${n === 1 ? "" : "s"}`;
      },
      description: "How many euclidean hits the ring spreads evenly round its pattern." },
    { kind: "number", key: `${key}Fill`, label: "Fill", min: 0, max: 1, step: 0.01, default: 0.5, format: pct,
      description: "How much of the drum map's pattern plays: low keeps only its strongest hits, high adds every ghost note." },
    { kind: "number", key: `${key}Variation`, label: "Variation", min: 0, max: 1, step: 0.01, default: 0.3, format: pct,
      description: "How much each bar strays: ghost notes, dropped hits and nudges. On the drum map it also makes weak hits come and go." },
    { kind: "number", key: `${key}Length`, label: "Steps", min: 1, max: MAX_DRUM_LENGTH, step: 1, default: 16, format: (v) => `${v}`,
      description: "How many sixteenths the pattern has before it repeats. Anything but 16 drifts against the bar." },
    { kind: "number", key: `${key}Rotate`, label: "Offset", min: 0, max: MAX_DRUM_LENGTH - 1, step: 1, default: 0,
      format: (v) => `${liveSeq ? v % liveSeq.length(key) : v}`,
      description: "Turns the euclidean hits round the ring, so they start on a different step. The drum map's grooves stay put." },
    { kind: "choice", key: `${key}Reset`, label: "Reset", options: DRUM_RESETS, default: "0",
      description: "Brings the pattern back to its start every so many bars." },
    { kind: "number", key: `${key}Volume`, label: "Volume", group: "Sound", min: 0, max: 1, step: 0.01, default: 0.8,
      format: (v) => decibels(faderGain(v)), description: "This drum's level inside the drum track." },
    { kind: "number", key: `${key}Pan`, label: "Pan", group: "Sound", min: -1, max: 1, step: 0.01, default: 0, format: panLabel,
      description: "Moves this drum left or right." },
    { kind: "number", key: `${key}Pitch`, label: "Pitch", group: "Sound", min: -12, max: 12, step: 1, default: 0,
      format: (v) => signed(v, " st"), description: "Tunes the drum up or down, in semitones." },
    { kind: "number", key: `${key}Decay`, label: "Decay", group: "Sound", min: 0, max: 1, step: 0.01, default: 0.5, format: pct,
      description: key === "hat" ? "Short and closed to long and open." : "How long the hit rings. 50% is the stock sound." },
    { kind: "number", key: `${key}Tone`, label: key === "kick" ? "Punch" : key === "snare" ? "Snap" : "Bright", group: "Sound",
      min: 0, max: 1, step: 0.01, default: 0.5, format: pct,
      description: key === "kick" ? "How hard the kick's pitch drops: soft thud to punchy click."
        : key === "snare" ? "Body to rattle: more tone or more snare wires." : "How bright and sizzly the hat is." },
  ];
}

/** A track's mixer controls: fader, pan and the two effect sends. */
function mixerSpecs(key: TrackKey, label: string): ParamSpec[] {
  return [
    { kind: "number", key: `${key}Volume`, label: `${label} volume`, min: 0, max: 1, step: 0.01, default: 0.8,
      format: (v) => decibels(faderGain(v)), description: "The track's level. The mark is 0 dB." },
    { kind: "number", key: `${key}Pan`, label: `${label} pan`, min: -1, max: 1, step: 0.01, default: 0, format: panLabel,
      description: "Moves the track left or right." },
    { kind: "number", key: `${key}Echo`, label: `${label} echo`, min: 0, max: 1, step: 0.01, default: 0, format: pct,
      description: "How much of the track goes to the echo. Set its time on the Master strip." },
    { kind: "number", key: `${key}Space`, label: `${label} reverb`, min: 0, max: 1, step: 0.01, default: 0, format: pct,
      description: "How much of the track goes to the reverb. Set its size on the Master strip." },
  ];
}

const signedPct = (v: number) => signed(Math.round(v * 100), "%");

/**
 * A track's Plaits controls. As on the module, Harmonics, Timbre and Morph do
 * something different on each engine; the descriptions say what.
 */
function soundSpecs(prefix: "bass" | "chord" | "melody"): ParamSpec[] {
  const d = SOUND_DEFAULTS[prefix] as unknown as Record<string, number | string>;
  const knob = (key: string, label: string, description: string, min = 0): ParamSpec => ({
    kind: "number", key: `${prefix}${key}`, label, group: "Sound", min, max: 1, step: 0.01, default: d[`${prefix}${key}`] as number,
    format: min < 0 ? signedPct : pct, description,
  });
  return [
    { kind: "choice", key: `${prefix}Engine`, label: "Engine", group: "Sound", options: ENGINE_CHOICES, default: d[`${prefix}Engine`] as string,
      description: "Which Plaits synthesis model plays the notes." },
    knob("Harmonics", "Harmonics",
      "Analog: the second oscillator's interval. Waveshaper: the shaper's curve. FM: the frequency ratio. Grain: the formant ratio. "
      + "Additive: extra peaks in the spectrum. String machine: brightness. Pluck and modal: from inharmonic to bell-like."),
    knob("Timbre", "Timbre",
      "Analog: the first oscillator's shape. Waveshaper: how hard it folds. FM: the modulation depth. Grain: the formant's pitch. "
      + "Additive: which harmonics are loudest. String machine: the ensemble chorus. Pluck and modal: how bright the strike is."),
    knob("Morph", "Morph",
      "Analog: the second oscillator's shape. Waveshaper: the wave's skew. FM: feedback. Grain: the grain's shape. "
      + "Additive: how wide the spectrum is. String machine: the organ registration. Pluck and modal: how long it rings."),
    knob("TimbreEnv", "Env → Timbre", "How far each note's decay envelope pushes Timbre, up or down.", -1),
    knob("MorphEnv", "Env → Morph", "How far each note's decay envelope pushes Morph, up or down.", -1),
    knob("Decay", "Decay", "The low-pass gate: short plucks to long rings. Past 60% notes also hold for as long as they last."),
    knob("Colour", "Colour", "The low-pass gate's colour: 0% is a plain fade, higher closes like a filter, darkening as it decays."),
  ];
}

/**
 * The sequencer's controls, by part. They're drawn as sliders and dropdowns,
 * and can be mapped to a MIDI knob (as `gen#<key>`).
 */
const PARTS: { part: string; specs: ParamSpec[] }[] = [
  { part: "Song", specs: [
    { kind: "number", key: "tempo", label: "Tempo", min: 40, max: 240, step: 1, default: 112, format: (v) => `${v}`,
      description: "How fast the song plays, in beats per minute." },
    { kind: "number", key: "swing", label: "Swing", min: 0, max: 0.8, step: 0.05, default: 0, format: pct,
      description: "Delays every second sixteenth for a shuffled feel." },
    { kind: "number", key: "energy", label: "Energy", min: 0, max: 1, step: 0.01, default: 0.5, format: (v) => signedPct((v - 0.5) * 2),
      description: "Makes every track busier or sparser at once, on top of each track's own Density. The middle plays them as set." },
    { kind: "number", key: "evolve", label: "Evolve", min: 0, max: 1, step: 0.01, default: 0.5, format: (v) => signedPct((v - 0.5) * 2),
      description: "How much every track changes as it plays, on top of each one's Variation. All the way down freezes the song; up keeps it moving." },
  ] },
  ...DRUMS.map((d) => ({ part: d.label, specs: drumSpecs(d.key) })),
  { part: "Drum map", specs: [
    { kind: "number", key: "gridsX", label: "Map X", min: 0, max: 1, step: 0.01, default: 0, format: pct,
      description: "Across the drum map: straight grooves on the left, broken and syncopated on the right." },
    { kind: "number", key: "gridsY", label: "Map Y", min: 0, max: 1, step: 0.01, default: 0, format: pct,
      description: "Up the drum map: sparse half-time at the bottom, busy and frantic at the top." },
  ] },
  { part: "Bass", specs: [
    { kind: "choice", key: "bassStyle", label: "Style", options: choices(BASS_STYLES), default: "pulse" },
    { kind: "number", key: "bassDensity", label: "Density", min: 0, max: 1, step: 0.01, default: 0.4, format: pct,
      description: "How many notes the bass plays." },
    { kind: "number", key: "bassRange", label: "Range", min: 1, max: 7, step: 1, default: 3, format: (v) => BASS_RANGE_LABELS[v - 1] ?? String(v),
      description: "Which notes it may leave the root for: octave, fifth, chord tones, then passing notes." },
    { kind: "number", key: "bassVariation", label: "Variation", min: 0, max: 1, step: 0.01, default: 0.3, format: pct,
      description: "How much the bass line changes from bar to bar." },
    ...soundSpecs("bass"),
    { kind: "number", key: "bassOctave", label: "Octave", group: "Sound", min: -2, max: 1, step: 1, default: 0, format: octaves },
    { kind: "number", key: "bassSub", label: "Sub", group: "Sound", min: 0, max: 1, step: 0.01, default: 0.5, format: pct,
      description: "A pure sine under the engine, for weight." },
    { kind: "number", key: "bassGlide", label: "Glide", group: "Sound", min: 0, max: 1, step: 0.01, default: 0, format: pct,
      description: "Slides each note's pitch in from the last one." },
  ] },
  { part: "Chords", specs: [
    { kind: "choice", key: "chordStyle", label: "Style", options: choices(CHORD_STYLES), default: "pop" },
    { kind: "number", key: "chordVariation", label: "Variation", min: 0, max: 1, step: 0.01, default: 0.3, format: pct,
      description: "How often the progression switches and chords are swapped for substitutes typical of the style." },
    { kind: "number", key: "chordDensity", label: "Rhythm density", min: 0, max: 1, step: 0.01, default: 0.3, format: pct,
      description: "Low holds each chord for bars at a time, as the style would; higher fits in more chord changes and plays them in a busier rhythm." },
    { kind: "number", key: "chordRhythm", label: "Rhythm variation", min: 0, max: 1, step: 0.01, default: 0.25, format: pct,
      description: "How much the chord rhythm changes from bar to bar, and how often the pattern of chord changes is mixed up." },
    { kind: "number", key: "chordDejaVu", label: "Déjà vu", min: 0, max: 1, step: 0.01, default: 0, format: pct,
      description: "As on Marbles: how often a variation comes back instead of a new one. 0% is always fresh; 100% locks the varied progression and its rhythm into a loop." },
    ...soundSpecs("chord"),
    { kind: "number", key: "chordInversion", label: "Inversion", group: "Sound", min: 0, max: 1, step: 0.01, default: 0.5,
      format: (v) => signed(Math.round((v - 0.5) * 2 * 100), "%"),
      description: "Sweeps the voicing down or up through its inversions, crossfading each note an octave as Plaits' chord engine does. 0 is as voiced." },
    { kind: "number", key: "chordStrum", label: "Strum", group: "Sound", min: 0, max: 1, step: 0.01, default: 0, format: pct,
      description: "Starts the notes one after another, lowest first, like a strummed chord." },
    { kind: "number", key: "chordAttack", label: "Attack", group: "Sound", min: 0, max: 1, step: 0.01, default: 0, format: pct,
      description: "How slowly the chords fade in: low plucks, high swells." },
    { kind: "number", key: "chordWobble", label: "Wobble", group: "Sound", min: 0, max: 1, step: 0.01, default: 0, format: pct,
      description: "Sweeps Timbre up and down in time with the music." },
    { kind: "number", key: "chordWobbleRate", label: "Wobble speed", group: "Sound", min: 0, max: WOBBLE_RATE_LABELS.length - 1, step: 1,
      default: 2, format: (v) => WOBBLE_RATE_LABELS[v] ?? String(v), description: "How long one sweep of the wobble takes." },
    { kind: "number", key: "chordOctave", label: "Octave", group: "Sound", min: -1, max: 1, step: 1, default: 0, format: octaves },
  ] },
  { part: "Melody", specs: [
    { kind: "choice", key: "melodyRhythm", label: "Mode", options: MELODY_RHYTHMS, default: "coin",
      description: "How ticks of the clock get a note. Coin tosses a coin on each one; Bursts plays notes in runs with rests between; Steady plays regular divisions of the clock." },
    { kind: "number", key: "melodyRate", label: "Clock", min: 0, max: MELODY_RATES.length - 1, step: 1, default: 2,
      format: (v) => MELODY_RATE_LABELS[v] ?? String(v), description: "How fast the clock ticks: a half note, a quarter, an eighth or a sixteenth. At most one note plays per tick." },
    { kind: "number", key: "melodyDensity", label: "Density", min: 0, max: 1, step: 0.01, default: 0.5, format: pct,
      description: "How many ticks get a note (Marbles' t Bias)." },
    { kind: "number", key: "melodyJitter", label: "Jitter", min: 0, max: 1, step: 0.01, default: 0, format: pct,
      description: "Makes the clock wobble, so notes land a little early or late, like a player who doesn't count." },
    { kind: "number", key: "melodyLegato", label: "Note length", min: 0, max: 1, step: 0.01, default: 0.5, format: pct,
      description: "Short and detached to long notes that run into the next." },
    { kind: "number", key: "melodySpread", label: "Spread", min: 0, max: 1, step: 0.01, default: 0.45, format: pct,
      description: "How far notes stray from Bias. Low stays on one note, the middle wanders round it, high leaps between the lowest and highest notes." },
    { kind: "number", key: "melodyBias", label: "Bias", min: 0, max: 1, step: 0.01, default: 0.5,
      format: (v) => (v < 0.35 ? "Low" : v > 0.65 ? "High" : "Middle"), description: "Where the notes gather: low, middle or high in the range." },
    { kind: "number", key: "melodySteps", label: "Steps", min: 0, max: 1, step: 0.01, default: 0.7,
      format: (v) => STEPS_LABELS[v < 0.5 ? 0 : stepsIndex(v)], description: "Which notes the melody may use. Left of the middle it slides between scale notes; right of it, fewer and fewer notes: the chord's notes, then just its root and fifth, then the root." },
    { kind: "number", key: "melodyOctaves", label: "Range", min: 1, max: 3, step: 0.5, default: 1.5, format: (v) => `${v} oct`,
      description: "How many octaves the notes cover." },
    { kind: "number", key: "melodyDejaVu", label: "Déjà vu", min: 0, max: 1, step: 0.01, default: 0.35,
      format: dejaVuLabel, description: "Marbles' Déjà vu. Left: every note is new. Towards the middle the last few notes come back more and more, until at the middle they loop. Right of the middle the loop plays in a jumbled order." },
    { kind: "number", key: "melodyLength", label: "Loop length", min: 1, max: 16, step: 1, default: 8, format: (v) => `${v} tick${v === 1 ? "" : "s"}`,
      description: "How many ticks Déjà vu loops over." },
    { kind: "choice", key: "melodyLoop", label: "Loops", options: MELODY_LOOPS, default: "both",
      description: "What Déjà vu repeats: the rhythm and the notes, or only one of them while the other stays fresh." },
    ...soundSpecs("melody"),
    { kind: "number", key: "melodyOctave", label: "Octave", group: "Sound", min: -2, max: 2, step: 1, default: 0, format: octaves },
    { kind: "number", key: "melodyAttack", label: "Attack", group: "Sound", min: 0, max: 1, step: 0.01, default: 0, format: pct,
      description: "How slowly notes fade in: low plucks, high swells." },
    { kind: "number", key: "melodyGlide", label: "Glide", group: "Sound", min: 0, max: 1, step: 0.01, default: 0, format: pct,
      description: "Slides each note's pitch in from the last one." },
  ] },
  { part: "Mixer", specs: TRACKS.flatMap((t) => mixerSpecs(t.key, t.label)) },
  { part: "Master", specs: [
    { kind: "number", key: "masterVolume", label: "Volume", min: 0, max: 1, step: 0.01, default: 0.7, format: decibels,
      description: "The level of everything: sequencer, MIDI keyboard and audio file." },
    { kind: "number", key: "echoTime", label: "Echo time", min: 0, max: ECHO_TIME_LABELS.length - 1, step: 1, default: 2,
      format: (v) => ECHO_TIME_LABELS[v] ?? String(v), description: "The gap between echoes, in time with the tempo." },
    { kind: "number", key: "echoFeedback", label: "Echo feedback", min: 0, max: 0.9, step: 0.01, default: 0.35, format: pct,
      description: "How many times each echo repeats." },
    { kind: "number", key: "spaceSize", label: "Reverb size", min: 0, max: 1, step: 0.01, default: 0.5, format: pct,
      description: "A small room to a huge hall." },
  ] },
];

function findSeqSpec(key: string): { part: string; spec: ParamSpec } | null {
  for (const p of PARTS) {
    const spec = p.specs.find((x) => x.key === key);
    if (spec) return { part: p.part, spec };
  }
  return null;
}

const REACTION_LABELS: Record<ReactionSource, string> = {
  kick: "Kick", snare: "Snare", hat: "Hi-hat", tone: "Melody notes", bassline: "Bass notes", chord: "Chords",
  level: "Sound level", bass: "Bass", mid: "Mids", treble: "Treble", spectrum: "Spectrum", beat: "Beat",
};

/** The modulation source whose live value the matrix shows next to each reaction. */
const REACTION_METERS: Record<ReactionSource, string> = {
  kick: "kick", snare: "snare", hat: "hat", tone: "tone", bassline: "bassline", chord: "chord",
  level: "level", bass: "bass", mid: "mid", treble: "treble", spectrum: "level", beat: "lfoBeat",
};

/** How the matrix groups a model's built-in reactions: by the kind of sound each listens to. */
const REACTION_GROUPS: { name: string; text: string; sources: ReactionSource[] }[] = [
  { name: "Drums", text: "What kicks, snares and hi-hats do", sources: ["kick", "snare", "hat"] },
  { name: "Melody and chords", text: "What melody notes, bass notes and chords do", sources: ["tone", "bassline", "chord"] },
  { name: "Loudness", text: "What the sound's level, bands, spectrum and the beat do", sources: ["level", "bass", "mid", "treble", "spectrum", "beat"] },
];

/** The built-in groups the user has unfolded, remembered across models and launches. */
function loadOpenGroups(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem("ui:modGroups") ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function saveOpenGroups(set: Set<string>): void {
  try {
    localStorage.setItem("ui:modGroups", JSON.stringify([...set]));
  } catch {
    // Only a convenience.
  }
}

function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable; settings then last for this session only.
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

/**
 * Everything musical: the sequencer, MIDI, the audio player, and the
 * per-model macros and modulation routes, plus the music panel UI. The host
 * calls `frame` once per animation frame and `apply` to get the parameter
 * values the model should use.
 */
export class Studio {
  readonly audio = new AudioEngine();
  readonly sources = new ModSources();
  readonly seq: Sequencer;
  private midi: MidiInputs | null = null;
  private beats = new BeatDetector();
  private pending: NoteEvent[] = [];
  private settings: GlobalSettings;

  private def: ModelDefinition | null = null;
  private base: ParamValues = {};
  private modelSettings: ModelSettings = { v: MODEL_SETTINGS_VERSION, macros: {}, routes: [], reactions: [] };
  private macroOut: Record<string, number> = {};
  private paramControls: ParamControls | null = null;
  private macroControls: ParamControls | null = null;
  private onBaseChanged: (spec: ParamSpec) => void = () => {};
  private globalControls: ParamControls | null = null;
  /** Global Controls after modulation routes have pushed them, as the model sees them. */
  private globalOut: ParamValues = defaultGlobals();

  private learning = false;
  private learnTarget: string | null = null;
  private ledTimer = 0;
  /** The last value a MIDI knob gave each model parameter, so the model only rebuilds when a knob actually changes it. */
  private lastCcValue: ParamValues = {};
  private seqControls: { refresh(): void }[] = [];
  private seqTab!: HTMLElement;
  /** Each mixer strip's meter, and the level it last showed (meters fall back slowly, like a peak meter's). */
  private stripMeters: { key: TrackKey | "master"; level: number }[] = [];
  /** The mixer's meters, the Audio tab's band meters and the matrix rows' meters, each block drawn on one canvas. */
  private stripOverlay: LiveOverlay | null = null;
  private audioOverlay: LiveOverlay | null = null;
  private matrixOverlay: LiveOverlay | null = null;
  private builtinOverlay: LiveOverlay | null = null;
  /** The dock tab showing, so hidden meters cost nothing (and no layout is forced to ask). */
  private tab = "sequencer";
  /** Keys changed since the last frame, whose dependent controls refresh together once a frame. */
  private refreshKeys = new Set<string>();
  private refreshAll = false;
  private refreshFrame = 0;
  /** The melody view's size, kept by a ResizeObserver so drawing never asks the layout. */
  private melodySize = { w: 0, h: 0 };
  private showStrips: () => void = () => {};
  private ringCtx: CanvasRenderingContext2D | null = null;
  private melodyCtx: CanvasRenderingContext2D | null = null;
  /** What the melody view and chord chips last drew, to skip redundant redraws. */
  private melodyDrawn = "";
  private chipsDrawn = "";
  private captionsDrawn = "";
  /** Melody and sound preset chips, lit while the controls match them. */
  private presetChips: { button: HTMLButtonElement; values: Partial<SequencerState> }[] = [];
  private meterLevels: Record<string, number> = {};
  /** Live source bars in the matrix, refreshed while the Modulation tab is open. */
  private sourceMeters: { level: number; source: () => string }[] = [];
  /** Music that was playing when the simulation was paused, to resume with it. */
  private pausedMusic: { seq: boolean; file: boolean } | null = null;
  private player: HTMLAudioElement | null = null;
  /** The music feed handed to the model each frame; reused to avoid garbage. */
  private feed: MusicFrame = { ...SILENT_MUSIC, spectrum: new Float32Array(SILENT_MUSIC.spectrum.length), wave: new Float32Array(SILENT_MUSIC.wave.length) };
  private beatsNow = 0;
  /** When the live meters and modulation bars last redrew (see UI_INTERVAL), and whether this frame is one of those. */
  private uiAt = -1;
  private uiDue = true;
  /** Every other tick is one where the sidebar's modulation markers redraw; the meters redraw on all of them. */
  private uiTicks = 0;
  private markersDue = true;
  /** Smoothed milliseconds per frame, for choosing the live UI's rate. */
  private frameMs = 16;
  private lastTone = { hue: 210, pitch: 0.5 };
  private chordHue = 210;

  constructor() {
    const saved = load<Partial<GlobalSettings> & { volume?: number }>("music:global") ?? {};
    const seq = sanitizeState(saved.seq);
    window.addEventListener("pagehide", () => this.flushGlobal());
    // The volume slider became the master fader.
    if (typeof saved.volume === "number" && saved.seq && !("masterVolume" in saved.seq)) seq.masterVolume = saved.volume;
    delete saved.volume;
    this.settings = {
      thru: true, decay: 0.25, smoothing: 0.08, inputs: [], bindings: {}, dockHidden: false, musicOn: true, intensity: 1, mixerTrack: "drums", drumVoice: "kick",
      ...saved,
      seq,
      globals: sanitizeGlobals(saved.globals),
      presets: sanitizePresets(saved.presets),
    };
    if (![...TRACKS.map((t) => t.key), "master"].includes(this.settings.mixerTrack)) this.settings.mixerTrack = "drums";
    if (!DRUMS.some((d) => d.key === this.settings.drumVoice)) this.settings.drumVoice = "kick";
    this.seq = liveSeq = new Sequencer(this.audio, seq);
    this.audio.mix(this.seq.mixSettings());
    for (const t of SYNTH_TRACKS) this.audio.patch(t, this.seq.patch(t));
    this.sources.decay = this.settings.decay;
    this.sources.smoothing = this.settings.smoothing;
    this.buildDock();
    void this.initMidi();
  }

  private saveTimer = 0;

  /**
   * Save soon rather than now: a dragged slider or a turning MIDI knob calls
   * this many times a frame, and each save writes every music setting.
   */
  private saveGlobal(): void {
    if (this.saveTimer) return;
    this.saveTimer = window.setTimeout(() => this.flushGlobal(), 400);
  }

  /** Save right away, e.g. as the window closes. */
  flushGlobal(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    save("music:global", this.settings);
  }

  // ---- Per-model state ---------------------------------------------------

  /** Called when the host loads a model. `base` is the slider-bound values object. */
  setModel(def: ModelDefinition, base: ParamValues, controls: ParamControls, onBaseChanged: (spec: ParamSpec) => void): void {
    this.def = def;
    this.rowFlash = null;
    this.base = base;
    this.paramControls = controls;
    this.onBaseChanged = onBaseChanged;
    const saved = load<SavedModelSettings>(`music:model:${def.id}`);
    // Settings saved before the current defaults existed are replaced, so new default routes show up.
    this.modelSettings = saved && saved.v === MODEL_SETTINGS_VERSION
      ? { v: saved.v, macros: saved.macros, routes: saved.routes, reactions: savedReactions(def, saved) }
      : this.defaultModelSettings(def);
    // Macros the model gained since the save start at zero.
    for (const m of def.macros ?? []) if (typeof this.modelSettings.macros[m.key] !== "number") this.modelSettings.macros[m.key] = 0;
    // Drop anything that points at parameters the model no longer has.
    const valid = new Set(this.targets().map((t) => t.id));
    this.modelSettings.routes = this.modelSettings.routes.filter((r) => valid.has(r.target));
    this.macroOut = {};
    this.renderMacros();
    this.renderRoutes();
    this.renderBindings();
  }

  private defaultModelSettings(def: ModelDefinition): ModelSettings {
    const macros: Record<string, number> = {};
    for (const m of def.macros ?? []) macros[m.key] = 0;
    return { v: MODEL_SETTINGS_VERSION, macros, routes: (def.modulations ?? []).map((r) => ({ ...r })), reactions: defaultReactions(def) };
  }

  private saveModel(): void {
    if (this.def) save(`music:model:${this.def.id}`, this.modelSettings);
  }

  private renderMacros(): void {
    const macros = this.def?.macros ?? [];
    $("macros-model").textContent = this.def ? `only in ${this.def.name}` : "";
    this.macroControls = renderParamControls($("macros"), macroSpecs(macros, this.def?.params ?? []), this.modelSettings.macros, () => this.saveModel(), "macro:", undefined, { ...this.sliderHooks("macro:"), help: this.helpShown });
    if (macros.length === 0) $("macros").append(el("p", { className: "muted", textContent: "This model has no macros." }));
  }

  private helpShown = false;

  /** Show or hide what each macro does under its slider (the Parameters panel's ? covers both). */
  setHelp(on: boolean): void {
    this.helpShown = on;
    this.macroControls?.setHelp(on);
  }

  /** The ♪ button and badge on a panel's sliders: add a route to one, or show the routes pushing it. */
  sliderHooks(prefix: "" | "macro:" | "global:"): ControlOptions {
    return {
      addRoute: (key) => this.addRouteTo(prefix + key),
      showRouteOf: (key) => this.showRoutesTo(prefix + key),
    };
  }

  /** Everything a route can push: macros first, then number parameters, then the global controls, each its own group. */
  private targets(): { id: string; label: string; group: string }[] {
    if (!this.def) return [];
    return [
      ...(this.def.macros ?? []).map((m) => ({ id: `macro:${m.key}`, label: m.label, group: "Macros" })),
      ...modulatable(this.def).map((p) => ({ id: p.key, label: p.label, group: this.def!.name })),
      ...GLOBAL_NUMBERS.map((p) => ({ id: `global:${p.key}`, label: p.label, group: "Global controls" })),
    ];
  }

  /**
   * Add a route to a slider from the ♪ button beside it, with a source that
   * suits what the slider does, and show it in the matrix.
   */
  private addRouteTo(target: string): void {
    if (!this.targets().some((t) => t.id === target)) return;
    const used = new Set(this.modelSettings.routes.filter((r) => r.target === target).map((r) => r.source));
    const key = target.replace(/^(macro|global):/, "").toLowerCase();
    // Sizes and glows follow the bass, colours the melody, motion the kick; LFOs for the rest.
    const wants = /size|width|bright|glow|grain|dot|thick|reach|scale/.test(key) ? ["bass", "level", "lfoBar"]
      : /colour|hue|spread|shift/.test(key) ? ["tone", "chord", "lfoBar"]
      : /speed|spin|drift|wind|turn|rotation|snap|bounce|scatter|burst|punch/.test(key) ? ["kick", "snare", "level"]
      : ["lfoBar", "kick", "tone"];
    const source = [...wants, "kick", "snare", "hat", "tone", "bass", "lfoBeat"].find((id) => !used.has(id)) ?? "kick";
    this.modelSettings.routes.push({ source, target, amount: 0.3 });
    this.routesChanged();
    this.renderRoutes();
    this.showRoutesTo(target);
  }

  /** Open the Modulation tab and flash the routes that push a target. */
  private showRoutesTo(target: string): void {
    this.showTab("modulation");
    this.rowFlash = target;
    for (const row of document.querySelectorAll<HTMLElement>("#mod-routes .route")) {
      const hit = row.dataset.target === target;
      row.classList.toggle("flash", hit);
      if (hit) row.scrollIntoView({ block: "nearest" });
    }
    window.setTimeout(() => document.querySelectorAll(".route.flash").forEach((r) => r.classList.remove("flash")), 1600);
  }

  /** Scroll the sidebar to a route's target and flash it, so a route can be found from the matrix. */
  private locateTarget(target: string): void {
    const row = document.querySelector<HTMLElement>(`#sidebar .param[data-target="${CSS.escape(target.replace(/^global:/, "glob:"))}"]`);
    if (!row) return;
    // Unfold the panel and the group it sits in.
    for (const d of [row.closest<HTMLDetailsElement>(".param-group"), row.closest<HTMLDetailsElement>(".panel")]) if (d) d.open = true;
    row.scrollIntoView({ block: "center" });
    row.classList.add("flash");
    window.setTimeout(() => row.classList.remove("flash"), 1600);
  }

  /** Show one of the dock's tabs, unfolding the dock if it is hidden. */
  private showTab(name: string): void {
    const tabs = document.querySelectorAll<HTMLButtonElement>("#dock-tabs [data-tab]");
    tabs.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll<HTMLElement>("#dock-body .tab").forEach((p) => (p.hidden = p.dataset.tab !== name));
    this.tab = name;
    if ($("dock").classList.contains("collapsed")) this.setDockHidden(false);
  }

  private rowFlash: string | null = null;

  /** What the global colour controls do to the finished picture. */
  grade(): Grade {
    return gradeOf(this.globalOut, this.beatsNow);
  }

  // ---- The dice -----------------------------------------------------------

  /** Musical time in bars, for rolling again every so many. */
  bars(): number {
    return this.beatsNow / 4;
  }

  /** Everything the dice can change on this side, to put back with `restore`. */
  snapshot(): StudioSnapshot {
    return {
      globals: { ...this.settings.globals },
      model: { id: this.def?.id ?? "", settings: JSON.parse(JSON.stringify(this.modelSettings)) as ModelSettings },
      seq: { ...(this.settings.seq as unknown as ParamValues) },
    };
  }

  restore(s: StudioSnapshot): void {
    this.setGlobals(sanitizeGlobals(s.globals));
    if (this.def && s.model.id === this.def.id) {
      this.modelSettings = JSON.parse(JSON.stringify(s.model.settings)) as ModelSettings;
      this.macroOut = {};
      this.saveModel();
      this.renderMacros();
      this.renderRoutes();
    }
    const seq = this.settings.seq as unknown as ParamValues;
    for (const k in s.seq) if (!MUSIC_KEEPS.test(k)) seq[k] = s.seq[k];
    this.seq.reload();
    this.musicRolled();
  }

  /**
   * Roll the global controls. Roll and Wild sometimes land on a built-in
   * preset instead, so the big looks (Neon tunnel, Noir) turn up too.
   */
  rollGlobals(level: RollLevel): string {
    const g = { ...this.settings.globals };
    if (level >= 2 && chance(level === 2 ? 0.3 : 0.2)) {
      const p = pick(BUILT_IN_PRESETS.slice(1));
      this.setGlobals(presetValues(p));
      return p.name;
    }
    for (const spec of GLOBAL_SPECS) {
      if (spec.kind === "number") g[spec.key] = rollNumber(spec, g[spec.key] as number, level);
      else if (spec.kind === "choice") g[spec.key] = rollChoice(spec, g[spec.key] as string, level);
      // Negative is a lot; only Wild risks it, and rarely.
      else if (spec.kind === "boolean") g[spec.key] = level === 3 ? chance(0.12) : false;
    }
    // Hue cycle keeps turning the colours for ever: usually best left off.
    if (level >= 1 && chance(0.6)) g.hueCycle = 0;
    this.setGlobals(sanitizeGlobals(g));
    return level >= 2 ? `${COLOUR_SCHEMES.find((c) => c.value === g.palette)?.label ?? g.palette}` : "nudged";
  }

  /** Roll the model's macros: gentle moves, or at Roll and Wild a few pushed and the rest at zero. */
  rollMacros(level: RollLevel): string | null {
    const macros = this.def?.macros ?? [];
    if (macros.length === 0) return null;
    const m = this.modelSettings.macros;
    let on = 0;
    for (const spec of macros) {
      const v = m[spec.key] ?? 0;
      if (level === 0) m[spec.key] = v + (Math.random() * 2 - 1) * 0.1;
      else if (level === 1) m[spec.key] = v + (Math.random() * 2 - 1) * 0.3;
      else if (level === 2) m[spec.key] = chance(0.5) ? 0 : between(0.15, 0.8);
      else m[spec.key] = chance(0.25) ? 0 : Math.random();
      m[spec.key] = Math.round(Math.min(1, Math.max(0, m[spec.key])) * 100) / 100;
      if (m[spec.key] > 0) on++;
    }
    this.macroControls?.refresh();
    this.saveModel();
    return `${on} on`;
  }

  /**
   * Roll the modulation matrix: amounts drift at Nudge and Shake; Roll
   * rerolls about half the routes (a new slider each, as the row's own die
   * does) and the built-in strengths; Wild rerolls every route, sources too.
   */
  rollModulation(level: RollLevel): string {
    const targets = this.targets();
    const routes = this.modelSettings.routes;
    const sources = SOURCES.filter((s) => s.group !== "MIDI" && s.group !== "Advanced").map((s) => s.id);
    const reroll = (r: ModRoute, source: boolean) => {
      const others = targets.filter((t) => t.id !== r.target);
      const kind = (id: string) => (id.startsWith("macro:") ? "macro" : id.startsWith("global:") ? "global" : "param");
      const x = Math.random();
      const want = x < 0.5 ? "param" : x < 0.75 ? "macro" : "global";
      const pool = [others.filter((t) => kind(t.id) === want), others, targets].find((p) => p.length);
      if (pool) r.target = pick(pool).id;
      r.amount = randomStep(0.25, 1, 0.05) * (chance(0.5) ? -1 : 1);
      if (source) r.source = pick(sources);
    };
    if (level <= 1) {
      const width = level === 0 ? 0.1 : 0.3;
      for (const r of routes) r.amount = Math.round(Math.min(1, Math.max(-1, r.amount + (Math.random() * 2 - 1) * width)) * 20) / 20;
      if (level === 1) for (const row of this.modelSettings.reactions) row.amount = Math.round(Math.min(2, Math.max(0, row.amount + (Math.random() * 2 - 1) * 0.3)) * 20) / 20;
    } else {
      for (const r of routes) if (level === 3 || chance(0.5)) reroll(r, level === 3);
      // Roll keeps the count near where it is; Wild settles on two to six.
      if (level === 3) {
        const want = 2 + Math.floor(Math.random() * 5);
        while (routes.length > want) routes.splice(Math.floor(Math.random() * routes.length), 1);
        while (routes.length < want && targets.length) {
          const r: ModRoute = { source: pick(sources), target: targets[0].id, amount: 0.5 };
          reroll(r, true);
          routes.push(r);
        }
      } else if (chance(0.3) && routes.length < 6 && targets.length) {
        const r: ModRoute = { source: pick(sources), target: targets[0].id, amount: 0.5 };
        reroll(r, true);
        routes.push(r);
      } else if (chance(0.2) && routes.length > 1) {
        routes.splice(Math.floor(Math.random() * routes.length), 1);
      }
      for (const row of this.modelSettings.reactions) {
        row.amount = level === 3 ? randomStep(0.25, 2, 0.05) : randomStep(0.5, 1.5, 0.05);
        if (level === 3) row.off = chance(0.15) || undefined;
        else delete row.off;
      }
    }
    this.saveModel();
    this.renderRoutes();
    return `${routes.length} route${routes.length === 1 ? "" : "s"}`;
  }

  /**
   * Roll the music. Nudge moves the pattern sliders a little and gives one
   * track a fresh go; Shake moves them further and starts a new idea; Roll
   * can change the style, key, tempo and the named sounds; Wild also rolls
   * the synth controls themselves. Mutes, holds, volumes and pans are never
   * touched, so the mix stays yours.
   */
  rollMusic(level: RollLevel): string {
    const seq = this.settings.seq;
    const values = seq as unknown as ParamValues;
    const before = seq.style;
    // The style, scale and root aren't among the PARTS' controls.
    if (chance(SWITCH_CHANCE[level])) seq.style = pickOther(Object.keys(STYLES), seq.style);
    if (chance(SWITCH_CHANCE[level])) seq.scale = pickOther(Object.keys(SCALES), seq.scale);
    if (chance(SWITCH_CHANCE[level])) seq.root = pickOther(ROOTS.map((_, i) => i), seq.root);
    for (const { part, specs } of PARTS) {
      for (const spec of specs) {
        const key = spec.key;
        if (MUSIC_KEEPS.test(key) || spec.kind === "widget") continue;
        const sound = spec.group === "Sound";
        if (part === "Mixer" || part === "Master") {
          // Only the effects: sends at Roll and Wild, the master effects too.
          if (level >= 2 && /Echo$|Space$|^echo|^space/.test(key) && spec.kind === "number") {
            values[key] = key === "echoTime" ? randomStep(spec.min, spec.max, spec.step) : randomStep(spec.min, Math.min(spec.max, 0.6), spec.step);
          }
          continue;
        }
        if (sound) {
          // The synth and drum sounds: Wild rolls their controls; Roll picks named sounds below.
          if (level === 3 && spec.kind === "number" && !/Octave$|Pitch$/.test(key)) values[key] = randomStep(spec.min, spec.max, spec.step);
          else if (level === 3 && spec.kind === "choice") values[key] = pick(spec.options).value;
          continue;
        }
        // Drum hits and offsets come from the style below; steps only drift at Wild.
        if (/^(kick|snare|hat)(Density|Rotate|Length)$/.test(key) || /^grids/.test(key)) {
          if (level === 3 && key.endsWith("Length") && chance(0.25)) values[key] = pick([12, 16, 24, 32]);
          continue;
        }
        if (spec.kind === "number") {
          const band = MUSIC_BANDS[key] ?? (spec.max - spec.min === 1 ? [0.15, 0.85] as [number, number] : undefined);
          // Even Wild keeps the tempo somewhere a song can live.
          values[key] = key === "tempo" && level === 3 ? randomStep(band![0], band![1], spec.step) : rollNumber(spec, values[key] as number, level, band);
        }
        else if (spec.kind === "choice") values[key] = rollChoice(spec, values[key] as string, level);
      }
    }
    if (seq.style !== before) applyStyleDensities(seq);
    if (level >= 1) {
      this.rollDrums();
      if (chance(0.4)) Object.assign(seq, pick(MELODY_PRESETS).values);
    }
    if (level >= 2) {
      for (const t of SYNTH_TRACKS) if (chance(level === 3 ? 0.5 : 0.3)) Object.assign(seq, pick(SOUND_PRESETS[t]).values);
    }
    if (level === 0) this.seq.reroll(pick(["drums", "bass", "chords", "melody"] as const));
    else this.seq.newIdea();
    this.musicRolled();
    const style = STYLES[seq.style]?.label ?? seq.style;
    return level >= 2 ? `${style} · ${ROOTS[seq.root]} ${SCALES[seq.scale]?.label.toLowerCase() ?? seq.scale} · ${seq.tempo} bpm` : level === 1 ? "new idea" : "nudged";
  }

  /** After the dice or an undo changed many music controls at once. */
  private musicRolled(): void {
    this.seq.refreshHarmony();
    this.seqChanged();
    this.showDrumModes();
    this.melodyDrawn = this.chipsDrawn = "";
  }

  // ---- Per-frame ---------------------------------------------------------

  /** Advance sources and collect the notes that should reach the model this frame. */
  frame(nowSeconds: number, dt: number): NoteEvent[] {
    const bands = this.audio.bands();
    if (this.audio.filePlaying && ($("audio-beats") as HTMLInputElement).checked) {
      const v = this.beats.feed(bands.bass, nowSeconds);
      if (v > 0) this.pending.push({ note: 36, velocity: v, role: "kick", x: 0.5, source: "audio" });
    }
    this.audio.mix(this.seq.mixSettings());
    for (const t of SYNTH_TRACKS) this.audio.patch(t, this.seq.patch(t));
    const events = [...this.seq.drain(), ...this.pending];
    this.pending = [];
    for (const ev of events) {
      this.sources.trigger(ev);
      if (ev.role === "tone") this.lastTone = { hue: noteHue(ev.note), pitch: ev.x };
      if (ev.role === "chord") this.chordHue = noteHue(this.seq.key + this.seq.chord.root);
    }
    this.beatsNow = this.seq.beats(nowSeconds);
    this.sources.update(dt, this.beatsNow, bands);
    // The meters and modulation bars only redraw every few frames. Each redraw
    // makes the webview repaint the panels around them on the CPU, and doing
    // that every frame cut the frame rate by more than half while music played.
    this.frameMs += (Math.min(dt, 0.25) * 1000 - this.frameMs) * 0.05;
    const interval = this.frameMs > 30 ? UI_INTERVAL_SLOWER : this.frameMs > 19 ? UI_INTERVAL_SLOW : UI_INTERVAL;
    const sinceUi = nowSeconds - this.uiAt;
    this.uiDue = sinceUi >= interval || sinceUi < 0;
    if (this.uiDue) {
      this.markersDue = (++this.uiTicks & 1) === 0;
      this.drawSequencer(Math.min(sinceUi, 0.25));
      this.updateMeters();
      this.uiAt = nowSeconds;
    }
    return events;
  }

  /**
   * How strongly the model reacts to this source by itself: its row's amount
   * in the matrix, or 0 when music, or the row, is off or deleted.
   */
  reaction(source: ReactionSource): number {
    if (!this.settings.musicOn) return 0;
    const row = this.modelSettings.reactions.find((r) => r.source === source);
    return row && !row.off ? row.amount : 0;
  }

  /**
   * The continuous music feed for the model this frame: envelopes, bands,
   * spectrum and beat, scaled by Intensity and by each reaction row's amount.
   */
  music(): MusicFrame {
    const f = this.feed;
    const depth = this.settings.musicOn ? this.settings.intensity : 0;
    const val = (r: ReactionSource, v: number) => v * depth * this.reaction(r);
    const src = this.sources;
    f.kick = val("kick", src.raw("kick"));
    f.snare = val("snare", src.raw("snare"));
    f.hat = val("hat", src.raw("hat"));
    f.tone = val("tone", src.raw("tone"));
    f.bassline = val("bassline", src.raw("bassline"));
    f.chord = val("chord", src.raw("chord"));
    // The models read the bands as they are; only routes get the smoothed ones.
    f.level = val("level", src.raw("level"));
    f.bass = val("bass", src.raw("bass"));
    f.mid = val("mid", src.raw("mid"));
    f.treble = val("treble", src.raw("treble"));
    const shape = depth * this.reaction("spectrum");
    for (let i = 0; i < f.spectrum.length; i++) f.spectrum[i] = this.audio.spectrum[i] * shape;
    for (let i = 0; i < f.wave.length; i++) f.wave[i] = this.audio.scope[i] * shape;
    f.beats = this.beatsNow;
    // The beat pulse only means something while the sequencer keeps time.
    const phase = this.beatsNow - Math.floor(this.beatsNow);
    f.pulse = this.seq.playing ? val("beat", (1 - phase) ** 3) : 0;
    f.hue = this.lastTone.hue;
    f.pitch = this.lastTone.pitch;
    f.chordHue = this.chordHue;
    f.energy = Math.max(f.level, f.kick * 0.7 + f.snare * 0.45 + f.tone * 0.35 + f.bassline * 0.3 + f.chord * 0.25 + f.hat * 0.15);
    return f;
  }

  /**
   * Pause or resume the music along with the simulation. Pausing stops the
   * sequencer and the audio file; resuming restarts whatever was playing.
   */
  setPaused(paused: boolean): void {
    if (paused) {
      const file = !!this.player && !this.player.paused;
      this.pausedMusic = { seq: this.seq.playing, file };
      if (this.seq.playing) this.toggleSequencer();
      if (file) this.player!.pause();
      this.audio.allNotesOff();
    } else if (this.pausedMusic) {
      if (this.pausedMusic.seq && !this.seq.playing) this.toggleSequencer();
      if (this.pausedMusic.file && this.player) void this.player.play();
      this.pausedMusic = null;
    }
  }

  /** Fill `out` with modulated values and update the slider markers. */
  apply(out: ParamValues): void {
    if (!this.def) return;
    const depth = this.settings.musicOn ? this.settings.intensity : 0;
    // Routes can push the global controls too, by a share of each one's range.
    const g = this.globalOut, base = this.settings.globals;
    for (const k in base) g[k] = base[k];
    if (depth > 0) {
      for (const r of this.modelSettings.routes) {
        if (r.off || !r.target.startsWith("global:")) continue;
        const spec = GLOBAL_NUMBERS.find((p) => p.key === r.target.slice(7));
        const src = this.sources.get(r.source);
        if (!spec || src === 0) continue;
        g[spec.key] = Math.min(spec.max, Math.max(spec.min, (g[spec.key] as number) + r.amount * src * depth * (spec.max - spec.min)));
      }
    }
    // The global controls stand in for the sliders of the model's hidden
    // parameters, then macros and routes push on top, then Energy scales.
    setHidden(this.def, g, this.base);
    // The matrix's built-in rows stand in for the sliders the models' music reactions used to have.
    applyReactions(this.def, (src) => this.reaction(src as ReactionSource), this.base);
    applyModulation(this.def, this.base, this.modelSettings.macros, this.modelSettings.routes, this.sources, out, this.macroOut, depth);
    applyEnergy(this.def, g, out);
    if (this.uiDue && this.markersDue) {
      this.paramControls?.showModulation(out);
      this.macroControls?.showModulation(this.macroOut);
      this.globalControls?.showModulation(g);
    }
  }

  // ---- MIDI ---------------------------------------------------------------

  private async initMidi(): Promise<void> {
    this.midi = await openMidi((data) => this.onMidi(data));
    if (this.midi.kind === "none") {
      $("midi-inputs").textContent = "MIDI isn't available in this browser. It works in the desktop app.";
      return;
    }
    await this.refreshInputs(true);
  }

  private async refreshInputs(reconnect = false): Promise<void> {
    const box = $("midi-inputs");
    if (!this.midi) return;
    let names: string[] = [];
    try {
      names = await this.midi.list();
    } catch (e) {
      box.textContent = String(e);
      return;
    }
    box.replaceChildren();
    if (names.length === 0) {
      box.textContent = "No MIDI inputs found. Plug in a device and press Refresh.";
      return;
    }
    for (const name of names) {
      const input = el("input", { type: "checkbox", checked: this.settings.inputs.includes(name) });
      const status = el("span", { className: "muted" });
      input.addEventListener("change", () => void this.setInput(name, input.checked, status, input));
      box.append(el("label", { className: "check" }, input, ` ${name} `, status));
      if (reconnect && input.checked) void this.setInput(name, true, status, input);
    }
  }

  private async setInput(name: string, on: boolean, status: HTMLElement, box: HTMLInputElement): Promise<void> {
    try {
      if (on) await this.midi!.connect(name);
      else await this.midi!.disconnect(name);
      status.textContent = "";
      const set = new Set(this.settings.inputs);
      if (on) set.add(name);
      else set.delete(name);
      this.settings.inputs = [...set];
      this.saveGlobal();
    } catch (e) {
      status.textContent = String(e);
      box.checked = false;
    }
  }

  private onMidi(data: ArrayLike<number>): void {
    const text = dispatchMidi(data, {
      noteOn: (ev) => {
        this.pending.push(ev);
        if (this.settings.thru) {
          if (ev.role === "tone") this.audio.noteOn(ev.note, ev.velocity);
          else this.audio.drum(ev.role as DrumKind, ev.velocity, 0, this.seq.drumSound(ev.role as DrumKey));
        }
      },
      noteOff: (note) => {
        this.sources.release(note);
        this.audio.noteOff(note);
      },
      cc: (n, v) => this.onCc(n, v),
      pitchBend: (v) => this.sources.pitchBend(v),
    });
    if (text) {
      $("midi-last").textContent = `Last message: ${text}`;
      const led = $("midi-led");
      led.classList.add("on");
      window.clearTimeout(this.ledTimer);
      this.ledTimer = window.setTimeout(() => led.classList.remove("on"), 120);
    }
  }

  private onCc(n: number, v: number): void {
    this.sources.cc(n, v);
    if (this.learning && this.learnTarget) {
      for (const [cc, t] of Object.entries(this.settings.bindings)) {
        if (t === this.learnTarget) delete this.settings.bindings[cc];
      }
      this.settings.bindings[n] = this.learnTarget;
      this.saveGlobal();
      this.setLearning(false);
      this.renderBindings();
    }
    const binding = this.settings.bindings[n];
    if (!binding) return;
    if (binding.startsWith("gen#")) {
      this.setGen(binding.slice(4), v);
      return;
    }
    if (binding.startsWith("glob#")) {
      const spec = GLOBAL_SPECS.find((p) => p.key === binding.slice(5));
      if (!spec) return;
      this.settings.globals[spec.key] = knobValue(spec, v);
      this.globalControls?.refresh();
      this.globalsChanged();
      return;
    }
    if (!this.def) return;
    if (binding.startsWith("macro#")) {
      const m = this.def.macros?.[Number(binding.slice(6))];
      if (!m) return;
      this.modelSettings.macros[m.key] = v;
      this.macroControls?.refresh();
      this.saveModel();
    } else {
      const [modelId, key] = binding.split("/");
      if (modelId !== this.def.id) return;
      const spec = this.def.params.find((p) => p.key === key);
      if (!spec) return;
      this.base[key] = knobValue(spec, v);
      if (this.base[key] === this.lastCcValue[key]) return;
      this.lastCcValue[key] = this.base[key];
      this.paramControls?.refresh();
      this.onBaseChanged(spec);
    }
  }

  private setLearning(on: boolean): void {
    this.learning = on;
    this.learnTarget = null;
    $("midi-learn").classList.toggle("active", on);
    $("midi-learn").textContent = on ? "Cancel learn" : "MIDI learn";
    document.body.classList.toggle("learning", on);
    document.querySelectorAll(".param.learn-target").forEach((e) => e.classList.remove("learn-target"));
    $("midi-learn-help").textContent = on
      ? "Now click a slider in the sidebar, a macro or global control, or a sequencer control, then move a knob on your controller."
      : "Click MIDI learn, click a slider, macro or global control, then move a knob on your controller. Sequencer controls can be mapped too.";
  }

  /** Translate a sidebar row's data-target into a binding target. */
  private bindingFor(rowTarget: string): string | null {
    if (rowTarget.startsWith("gen:")) return `gen#${rowTarget.slice(4)}`;
    if (rowTarget.startsWith("glob:")) return `glob#${rowTarget.slice(5)}`;
    if (!this.def) return null;
    if (rowTarget.startsWith("macro:")) {
      const i = (this.def.macros ?? []).findIndex((m) => m.key === rowTarget.slice(6));
      return i >= 0 ? `macro#${i}` : null;
    }
    return `${this.def.id}/${rowTarget}`;
  }

  private bindingLabel(target: string): string | null {
    if (target.startsWith("gen#")) {
      const found = findSeqSpec(target.slice(4));
      return found ? `Sequencer: ${found.part} ${found.spec.label.toLowerCase()}` : null;
    }
    if (target.startsWith("glob#")) {
      const spec = GLOBAL_SPECS.find((p) => p.key === target.slice(5));
      return spec ? `Global: ${spec.label}` : null;
    }
    if (!this.def) return null;
    if (target.startsWith("macro#")) {
      const i = Number(target.slice(6));
      const m = this.def.macros?.[i];
      return m ? `Macro ${i + 1} (${m.label})` : `Macro ${i + 1}`;
    }
    const [modelId, key] = target.split("/");
    if (modelId !== this.def.id) return null;
    return this.def.params.find((p) => p.key === key)?.label ?? null;
  }

  private renderBindings(): void {
    const box = $("midi-bindings");
    box.replaceChildren();
    const rows = Object.entries(this.settings.bindings)
      .map(([cc, t]) => [cc, this.bindingLabel(t)] as const)
      .filter(([, label]) => label !== null);
    if (rows.length === 0) {
      box.append(el("p", { className: "muted", textContent: "No knobs mapped for this model yet. Macro and global mappings carry over to every model." }));
      return;
    }
    for (const [cc, label] of rows) {
      const remove = el("button", { type: "button", textContent: "Remove", className: "small" });
      remove.addEventListener("click", () => {
        delete this.settings.bindings[cc];
        this.saveGlobal();
        this.renderBindings();
      });
      box.append(el("div", { className: "binding" }, el("span", { textContent: `CC ${cc}` }), el("span", { textContent: `→ ${label}` }), remove));
    }
  }

  // ---- UI -------------------------------------------------------------------

  private buildDock(): void {
    const s = this.settings;
    for (const t of document.querySelectorAll<HTMLButtonElement>("#dock-tabs [data-tab]")) {
      t.addEventListener("click", () => this.showTab(t.dataset.tab!));
    }
    $("dock-toggle").addEventListener("click", () => this.setDockHidden(!$("dock").classList.contains("collapsed")));
    this.setDockHidden(s.dockHidden);

    $<HTMLButtonElement>("seq-play").addEventListener("click", () => this.toggleSequencer());
    this.buildSequencer();

    // Global controls and macros
    this.renderGlobals();
    $("global-reset").addEventListener("click", () => this.setGlobals(defaultGlobals()));
    this.buildPresets();
    $("macros-reset").addEventListener("click", () => {
      for (const k in this.modelSettings.macros) this.modelSettings.macros[k] = 0;
      this.macroControls?.refresh();
      this.saveModel();
    });

    // Modulation
    $("mod-add").addEventListener("click", () => {
      const targets = this.targets();
      if (targets.length === 0) return;
      // Start from a sound and a slider that nothing uses yet, so a new route does something visible.
      const routes = this.modelSettings.routes;
      const source = ["kick", "snare", "hat", "tone", "lfoBar", "bass", "env"].find((id) => !routes.some((r) => r.source === id)) ?? "kick";
      const target = targets.find((t) => !routes.some((r) => r.target === t.id)) ?? targets[0];
      routes.push({ source, target: target.id, amount: 0.5 });
      this.saveModel();
      this.renderRoutes();
    });
    $("mod-restore").addEventListener("click", () => {
      if (!this.def) return;
      // Put back the deleted ones, at full strength, in the model's own order; the rest stay as set.
      const kept = this.modelSettings.reactions;
      this.modelSettings.reactions = defaultReactions(this.def).map((d) => kept.find((r) => r.source === d.source) ?? d);
      this.saveModel();
      this.renderRoutes();
    });
    $("mod-defaults").addEventListener("click", () => {
      if (!this.def) return;
      this.modelSettings.routes = (this.def.modulations ?? []).map((r) => ({ ...r }));
      this.saveModel();
      this.renderRoutes();
    });
    $("mod-reset-builtins").addEventListener("click", () => {
      if (!this.def) return;
      this.modelSettings.reactions = defaultReactions(this.def);
      this.saveModel();
      this.renderRoutes();
    });
    const smooth = $<HTMLInputElement>("mod-smooth");
    const smoothOut = $("mod-smooth-readout");
    const showSmooth = () => (smoothOut.textContent = s.smoothing === 0 ? "off" : `${Math.round(s.smoothing * 1000)} ms`);
    smooth.value = String(s.smoothing);
    showSmooth();
    smooth.addEventListener("input", () => {
      s.smoothing = this.sources.smoothing = Number(smooth.value);
      showSmooth();
      this.saveGlobal();
    });
    const decay = $<HTMLInputElement>("mod-decay");
    const decayOut = $("mod-decay-readout");
    decay.value = String(s.decay);
    decayOut.textContent = `${s.decay.toFixed(2)} s`;
    decay.addEventListener("input", () => {
      s.decay = this.sources.decay = Number(decay.value);
      decayOut.textContent = `${s.decay.toFixed(2)} s`;
      this.saveGlobal();
    });
    const intensity = $<HTMLInputElement>("mod-intensity");
    const intensityOut = $("mod-intensity-readout");
    intensity.value = String(s.intensity);
    intensityOut.textContent = `${Math.round(s.intensity * 100)}%`;
    intensity.addEventListener("input", () => {
      s.intensity = Number(intensity.value);
      intensityOut.textContent = `${Math.round(s.intensity * 100)}%`;
      this.saveGlobal();
    });
    const enabled = $<HTMLButtonElement>("mod-enabled");
    const showEnabled = () => {
      enabled.classList.toggle("on", s.musicOn);
      enabled.title = s.musicOn ? "Music is driving the visuals. Click to stop it: the matrix and the models' reactions go quiet." : "Music is not driving the visuals. Click to let it.";
      document.querySelector(".mod-layout")?.classList.toggle("bypassed", !s.musicOn);
    };
    enabled.addEventListener("click", () => {
      s.musicOn = !s.musicOn;
      showEnabled();
      this.saveGlobal();
      enabled.blur();
    });
    showEnabled();

    // MIDI
    $("midi-refresh").addEventListener("click", () => void this.refreshInputs());
    const thru = $<HTMLInputElement>("midi-thru");
    thru.checked = s.thru;
    thru.addEventListener("change", () => { s.thru = thru.checked; this.saveGlobal(); });
    $("midi-learn").addEventListener("click", () => this.setLearning(!this.learning));
    const pickTarget = (e: PointerEvent) => {
      if (!this.learning) return;
      const row = (e.target as HTMLElement).closest<HTMLElement>(".param[data-target]");
      if (!row) return;
      const target = this.bindingFor(row.dataset.target!);
      if (!target) return;
      document.querySelectorAll(".param.learn-target").forEach((x) => x.classList.remove("learn-target"));
      row.classList.add("learn-target");
      this.learnTarget = target;
    };
    $("sidebar").addEventListener("pointerdown", pickTarget);
    document.querySelector<HTMLElement>('#dock-body .tab[data-tab="sequencer"]')?.addEventListener("pointerdown", pickTarget);

    // Audio file
    const file = $<HTMLInputElement>("audio-file");
    const audioPlay = $<HTMLButtonElement>("audio-play");
    file.addEventListener("change", () => {
      const f = file.files?.[0];
      if (!f) return;
      const player = (this.player = this.audio.loadFile(f));
      $("audio-name").textContent = f.name;
      audioPlay.disabled = false;
      player.addEventListener("play", () => (audioPlay.textContent = "Pause"));
      player.addEventListener("pause", () => (audioPlay.textContent = "Play"));
      void player.play().catch((e) => ($("audio-name").textContent = `Can't play ${f.name}: ${e}`));
    });
    audioPlay.addEventListener("click", () => {
      const player = this.player;
      if (!player) return;
      if (player.paused) void player.play();
      else player.pause();
    });
    const meters = $("meters");
    this.audioOverlay = new LiveOverlay(meters, (o) => { o.fill = o.colour("--cyan", "#2ad4ff"); });
    for (const k of ["level", "bass", "mid", "treble"]) {
      const track = el("div", { className: "meter-track" });
      meters.append(el("div", { className: "meter" }, el("span", { textContent: sourceLabel(k) }), track));
      this.meterLevels[k] = 0;
      this.audioOverlay.add(track, (g, x, y, w, h) => bar(g, x, y, w * Math.min(1, this.meterLevels[k]), h), () => this.meterLevels[k] > 0);
    }
  }

  private renderGlobals(): void {
    const box = $("global-controls");
    this.globalControls = renderParamControls(box, GLOBAL_SPECS, this.settings.globals, () => this.globalsChanged(), "glob:", undefined, this.sliderHooks("global:"));
    // The panel is short, so descriptions show as tooltips here instead of under each control.
    for (const row of box.querySelectorAll<HTMLElement>(".param[data-target]")) {
      row.title = GLOBAL_SPECS.find((p) => `glob:${p.key}` === row.dataset.target)?.description ?? "";
    }
    this.showRouteBadges();
  }

  private globalsChanged(): void {
    this.saveGlobal();
    this.showPreset();
  }

  private setGlobals(values: ParamValues): void {
    this.settings.globals = values;
    this.globalsChanged();
    this.renderGlobals();
  }

  // ---- Global presets -----------------------------------------------------

  private presets(): GlobalPreset[] {
    return [...BUILT_IN_PRESETS, ...this.settings.presets];
  }

  /** The preset the global controls are set to right now, if any; your own win over a built-in with the same values. */
  private currentPreset(): GlobalPreset | null {
    const g = this.settings.globals;
    return [...this.settings.presets].reverse().find((p) => matchesPreset(g, p)) ?? BUILT_IN_PRESETS.find((p) => matchesPreset(g, p)) ?? null;
  }

  private buildPresets(): void {
    const select = $<HTMLSelectElement>("preset-select");
    const saveRow = $("preset-save-row"), name = $<HTMLInputElement>("preset-name");
    select.addEventListener("change", () => {
      const p = this.presets()[Number(select.value)];
      if (p) this.setGlobals(presetValues(p));
      select.blur();
    });
    $("preset-save").addEventListener("click", () => {
      saveRow.hidden = false;
      const current = this.currentPreset();
      name.value = current && this.settings.presets.includes(current) ? current.name : "";
      name.focus();
    });
    const finish = (keep: boolean) => {
      const label = name.value.trim();
      if (keep && label) {
        // Saving under a name you already used replaces that preset.
        const values = { ...this.settings.globals };
        const mine = this.settings.presets.find((p) => p.name.toLowerCase() === label.toLowerCase());
        if (mine) mine.values = values;
        else this.settings.presets.push({ name: label, values });
        this.saveGlobal();
      }
      saveRow.hidden = true;
      name.blur();
      this.showPreset();
    };
    $("preset-save-ok").addEventListener("click", () => finish(true));
    $("preset-save-cancel").addEventListener("click", () => finish(false));
    name.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    $("preset-delete").addEventListener("click", () => {
      const current = this.currentPreset();
      const i = current ? this.settings.presets.indexOf(current) : -1;
      if (i < 0) return;
      this.settings.presets.splice(i, 1);
      this.saveGlobal();
      this.showPreset();
    });
    this.showPreset();
  }

  /** List the presets and select the one the controls match, or "Custom". */
  private showPreset(): void {
    const select = $<HTMLSelectElement>("preset-select");
    const current = this.currentPreset();
    const all = this.presets();
    const option = (value: string, label: string) => el("option", { value, textContent: label });
    const mine = this.settings.presets.map((p, i) => option(String(BUILT_IN_PRESETS.length + i), p.name));
    select.replaceChildren(
      option("", "Custom"),
      el("optgroup", { label: "Built in" }, ...BUILT_IN_PRESETS.map((p, i) => option(String(i), p.name))),
      ...(mine.length ? [el("optgroup", { label: "Yours" }, ...mine)] : []),
    );
    (select.firstElementChild as HTMLOptionElement).hidden = current !== null;
    select.value = current ? String(all.indexOf(current)) : "";
    $<HTMLButtonElement>("preset-delete").disabled = !current || !this.settings.presets.includes(current);
  }

  private setDockHidden(hidden: boolean): void {
    $("dock").classList.toggle("collapsed", hidden);
    $("dock-toggle").classList.toggle("on", !hidden);
    $("dock-toggle").title = hidden ? "Show the music panel (Enter plays the sequencer either way)" : "Hide the music panel; the music keeps playing";
    if (this.settings.dockHidden !== hidden) {
      this.settings.dockHidden = hidden;
      this.saveGlobal();
    }
  }

  toggleSequencer(): void {
    const play = $<HTMLButtonElement>("seq-play");
    if (this.seq.playing) this.seq.stop();
    else this.seq.start();
    play.textContent = this.seq.playing ? "Stop" : "Play";
    play.classList.toggle("playing", this.seq.playing);
  }

  // ---- Sequencer panel ---------------------------------------------------------

  /**
   * Build the sequencer tab: the song controls, the mixer strips, and the
   * selected track's controls beside them, loosely after FL Studio's mixer
   * and channel settings.
   */
  private buildSequencer(): void {
    const s = this.settings;
    const seq = s.seq;
    const values = seq as unknown as ParamValues;
    this.seqTab = document.querySelector<HTMLElement>('#dock-body .tab[data-tab="sequencer"]')!;
    const changed = (spec: ParamSpec) => {
      if (spec.key === "chordStyle") this.seq.refreshHarmony();
      this.seq.version++;
      this.refreshSoon(spec.key);
      this.saveGlobal();
    };
    const render = (box: HTMLElement, specs: ParamSpec[]) => {
      const c = renderParamControls(box, specs, values, changed, "gen:");
      this.seqControls.push(c);
      // The panel is short, so descriptions show in the hint line at the top instead of under each control.
      for (const row of box.querySelectorAll<HTMLElement>(".param[data-target]")) {
        const p = specs.find((x) => `gen:${x.key}` === row.dataset.target);
        if (p?.description) row.dataset.hint = `${p.label}: ${p.description}`;
      }
    };
    const specsOf = (part: string) => PARTS.find((p) => p.part === part)!.specs;
    const patternOf = (part: string) => specsOf(part).filter((p) => !p.group);
    // Sound controls go in their own column, so they don't need a foldable heading.
    const soundOf = (part: string) => specsOf(part).filter((p) => p.group === "Sound").map((p) => ({ ...p, group: undefined }));
    const spec = (part: string, key: string) => specsOf(part).find((p) => p.key === key) as NumberSpec;

    // Song
    const style = $<HTMLSelectElement>("seq-style");
    for (const [id, st] of Object.entries(STYLES)) style.append(el("option", { value: id, textContent: st.label }));
    style.value = seq.style;
    style.addEventListener("change", () => {
      seq.style = style.value;
      applyStyleDensities(seq);
      this.refreshSeqControls();
      this.seq.version++;
      this.saveGlobal();
      style.blur();
    });
    const scale = $<HTMLSelectElement>("seq-scale");
    for (const [id, sc] of Object.entries(SCALES)) scale.append(el("option", { value: id, textContent: sc.label }));
    scale.value = seq.scale;
    scale.addEventListener("change", () => { seq.scale = scale.value; this.seq.refreshHarmony(); this.saveGlobal(); scale.blur(); });
    const root = $<HTMLSelectElement>("seq-root");
    ROOTS.forEach((r, i) => root.append(el("option", { value: String(i), textContent: r })));
    root.value = String(seq.root);
    root.addEventListener("change", () => { seq.root = Number(root.value); this.seq.version++; this.saveGlobal(); root.blur(); });
    // A roll or an undo can change all three at once.
    this.seqControls.push({ refresh: () => { style.value = seq.style; scale.value = seq.scale; root.value = String(seq.root); } });
    render($("global-sliders"), specsOf("Song"));
    const mute = $<HTMLButtonElement>("seq-mute");
    const showMute = () => {
      mute.classList.toggle("active", !seq.sound);
      mute.textContent = seq.sound ? "Mute" : "Muted";
      mute.title = seq.sound ? "Silence the sequencer; the visuals keep reacting" : "Let the sequencer be heard again";
    };
    showMute();
    mute.addEventListener("click", () => {
      seq.sound = !seq.sound;
      if (!seq.sound) this.audio.allNotesOff();
      showMute();
      this.saveGlobal();
      mute.blur();
    });
    $("gen-new").addEventListener("click", () => { this.seq.newIdea(); this.saveGlobal(); });
    $("gen-fill").addEventListener("click", () => this.seq.fill());
    // Hold: the global one freezes every track; each track's own freezes just that one.
    const holds: [HTMLButtonElement, "drumsHold" | "bassHold" | "chordsHold" | "melodyHold"][] = [];
    const hold = $<HTMLButtonElement>("gen-hold");
    const showHolds = () => {
      hold.classList.toggle("active", seq.hold);
      for (const [b, key] of holds) {
        b.classList.toggle("active", seq.hold || seq[key]);
        b.classList.toggle("forced", seq.hold && !seq[key]);
      }
    };
    hold.addEventListener("click", () => {
      seq.hold = !seq.hold;
      showHolds();
      this.saveGlobal();
      hold.blur();
    });
    for (const t of TRACKS) {
      const holdKey = `${t.key}Hold` as const;
      const partHold = $<HTMLButtonElement>(`hold-${t.key}`);
      holds.push([partHold, holdKey]);
      partHold.addEventListener("click", () => {
        seq[holdKey] = !seq[holdKey];
        showHolds();
        this.saveGlobal();
        partHold.blur();
      });
    }
    showHolds();

    this.buildMixer(values, changed, spec);

    // Drums: the voices listed beside the rings, each with its mode, and the selected voice's controls to the right.
    const list = $("drum-voices");
    const panels = $("drum-voice");
    const ofKey = (part: string, keys: string[]) => keys.map((k) => specsOf(part).find((p) => p.key === k)!);
    for (const d of DRUMS) {
      const name = el("button", { type: "button", className: "drum-name", textContent: d.label, title: `Edit the ${d.label.toLowerCase()}` });
      name.style.setProperty("--voice", d.colour);
      const onKey = `${d.key}On` as const;
      const muteDrum = el("button", { type: "button", className: "small strip-btn mute", textContent: "M", title: `Mute the ${d.label.toLowerCase()}` });
      // The mode as a segmented switch; it's a .param row so MIDI learn can map it.
      const modeSpec = specsOf(d.label).find((p) => p.key === `${d.key}Mode`)!;
      const seg = el("div", { className: "param drum-mode", title: modeSpec.description ?? "" });
      seg.dataset.target = `gen:${d.key}Mode`;
      for (const m of DRUM_MODES) {
        const b = el("button", { type: "button", className: "small", textContent: m.label });
        b.dataset.mode = m.value;
        b.addEventListener("click", () => {
          values[`${d.key}Mode`] = m.value;
          changed(modeSpec);
          this.selectDrum(d.key);
          b.blur();
        });
        seg.append(b);
      }
      const row = el("div", { className: "drum-voice-row" }, el("div", { className: "drum-label" }, name, muteDrum), seg);
      row.dataset.voice = d.key;
      row.addEventListener("pointerdown", (e) => {
        if (!(e.target as HTMLElement).closest(".mute")) this.selectDrum(d.key);
      });
      const showDrum = () => {
        muteDrum.classList.toggle("active", !seq[onKey]);
        row.classList.toggle("off", !seq[onKey]);
      };
      muteDrum.addEventListener("click", () => {
        seq[onKey] = !seq[onKey];
        showDrum();
        this.seq.version++;
        this.saveGlobal();
        muteDrum.blur();
      });
      showDrum();
      list.append(row);

      // This voice's panel: a column per kind of control, the pattern ones shown by mode.
      const col = (cls: string, label: string, specs: ParamSpec[], sliders = "part-sliders") => {
        const box = el("div", { className: sliders });
        const c = el("div", { className: `track-col ${cls}` }, el("span", { className: "section-label", textContent: label }), box);
        render(box, specs);
        return c;
      };
      const euclidCol = col("voice-euclid", "Euclidean", ofKey(d.label, [`${d.key}Density`, `${d.key}Rotate`]));
      const gridsCol = col("voice-grids", "Grids", ofKey(d.label, [`${d.key}Fill`]));
      gridsCol.querySelector(".section-label")!.after(el("div", { className: "grids-slot" }));
      const patternCol = col("voice-pattern", "Pattern", ofKey(d.label, [`${d.key}Variation`, `${d.key}Length`, `${d.key}Reset`]));
      const soundCol = col("voice-sound", "Sound", soundOf(d.label), "part-sliders cols-2");
      const panel = el("div", { className: "track-cols drum-panel" }, euclidCol, gridsCol, patternCol, soundCol);
      panel.dataset.voice = d.key;
      panels.append(panel);
    }
    this.buildRing();
    render($("grids-controls"), specsOf("Drum map"));
    this.buildGridsPad();
    this.selectDrum(s.drumVoice);

    render($("bass-controls"), patternOf("Bass"));
    render($("bass-sound"), soundOf("Bass"));
    render($("chord-controls"), patternOf("Chords"));
    render($("chord-sound"), soundOf("Chords"));
    render($("melody-sound"), soundOf("Melody"));
    render($("master-controls"), specsOf("Master"));
    this.buildMelody(values, changed, render, specsOf("Melody"));
    this.buildSoundPresets();
    this.buildTrackTools();
    this.buildHints();
    this.showPresetChips();
    this.selectTrack(s.mixerTrack);
  }

  /**
   * The melody panel, laid out like Marbles: the marbles view with its
   * presets, then the rhythm (Marbles' t section), the notes (its X section)
   * and Déjà vu.
   */
  private buildMelody(
    values: ParamValues, changed: (spec: ParamSpec) => void, render: (box: HTMLElement, specs: ParamSpec[]) => void, specs: ParamSpec[],
  ): void {
    const seq = this.settings.seq;
    const pick = (keys: string[]) => keys.map((k) => specs.find((p) => p.key === k)!);
    const seg = (box: HTMLElement, key: string, labels?: string[]) => {
      const d = segmented(pick([key])[0], values, changed, "gen:", labels);
      this.seqControls.push(d);
      box.append(d.el);
    };
    const sliders = (box: HTMLElement, keys: string[]) => {
      const inner = el("div");
      box.append(inner);
      render(inner, pick(keys));
    };
    const rhythm = $("melody-rhythm");
    seg(rhythm, "melodyRhythm");
    seg(rhythm, "melodyRate", MELODY_RATE_LABELS);
    sliders(rhythm, ["melodyDensity", "melodyJitter"]);
    sliders($("melody-notes"), ["melodySpread", "melodyBias", "melodySteps", "melodyOctaves", "melodyLegato"]);
    const loop = $("melody-loop");
    sliders(loop, ["melodyDejaVu", "melodyLength"]);
    seg(loop, "melodyLoop");

    // Presets: a few settings of the controls above, to start from.
    const box = $("melody-presets");
    for (const p of MELODY_PRESETS) {
      const b = el("button", { type: "button", className: "small preset-chip", textContent: p.label });
      b.dataset.hint = `${p.label}: ${p.hint}.`;
      b.addEventListener("click", () => {
        Object.assign(seq, p.values);
        this.seqChanged();
        b.blur();
      });
      box.append(b);
      this.presetChips.push({ button: b, values: p.values });
    }

    // The view doubles as an X/Y pad for the distribution: up and down is Bias, across is Spread.
    const canvas = $<HTMLCanvasElement>("melody-view");
    this.melodyCtx = canvas.getContext("2d");
    new ResizeObserver(() => {
      this.melodySize = { w: canvas.clientWidth, h: canvas.clientHeight };
      this.melodyDrawn = "";
    }).observe(canvas);
    const move = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      seq.melodySpread = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 100) / 100;
      seq.melodyBias = Math.round(Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height)) * 100) / 100;
      this.seq.version++;
      this.refreshSeqControls();
    };
    let dragging = false;
    canvas.addEventListener("pointerdown", (e) => {
      dragging = true;
      canvas.setPointerCapture(e.pointerId);
      move(e);
    });
    canvas.addEventListener("pointermove", (e) => { if (dragging) move(e); });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      this.saveGlobal();
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
  }

  /** Named sounds above each synth track's sound controls. */
  private buildSoundPresets(): void {
    const seq = this.settings.seq;
    for (const box of this.seqTab.querySelectorAll<HTMLElement>(".sound-presets")) {
      const track = box.dataset.track as SynthTrack;
      for (const p of SOUND_PRESETS[track]) {
        const b = el("button", { type: "button", className: "small preset-chip", textContent: p.label });
        b.dataset.hint = `${p.label}: a starting sound. Tweak the controls below to make it your own.`;
        b.addEventListener("click", () => {
          Object.assign(seq, p.values);
          this.seqChanged();
          b.blur();
        });
        box.append(b);
        this.presetChips.push({ button: b, values: p.values });
      }
    }
  }

  /** Each track's Pattern / Sound switch and its die. */
  private buildTrackTools(): void {
    const s = this.settings;
    s.trackViews ??= {};
    for (const sw of this.seqTab.querySelectorAll<HTMLElement>(".view-switch")) {
      const track = sw.dataset.track!;
      const body = sw.closest<HTMLElement>(".track-body")!;
      const show = () => {
        const view = s.trackViews![track] === "sound" ? "sound" : "pattern";
        for (const b of sw.querySelectorAll<HTMLElement>("button")) b.classList.toggle("active", b.dataset.view === view);
        for (const cols of body.querySelectorAll<HTMLElement>(".track-cols[data-view]")) cols.hidden = cols.dataset.view !== view;
        this.melodyDrawn = "";
      };
      for (const b of sw.querySelectorAll<HTMLButtonElement>("button")) {
        b.dataset.hint = b.dataset.view === "sound"
          ? "Sound: pick how this track sounds, from a named sound or the synth's own controls."
          : "Pattern: what this track plays and how it changes.";
        b.addEventListener("click", () => {
          s.trackViews![track] = b.dataset.view!;
          show();
          this.saveGlobal();
          b.blur();
        });
      }
      show();
    }
    for (const t of TRACKS) {
      const b = $<HTMLButtonElement>(`dice-${t.key}`);
      b.innerHTML = `${DICE_ICON}<span>New</span>`;
      b.addEventListener("click", () => {
        if (t.key === "drums") this.rollDrums();
        this.seq.reroll(t.key);
        this.seqChanged();
        b.blur();
      });
    }
  }

  /** A new beat in the style's spirit: each drum gets new hits and a new offset, and the drum map a new spot. */
  private rollDrums(): void {
    const seq = this.settings.seq as unknown as Record<string, number>;
    const style = STYLES[this.settings.seq.style] ?? STYLES.broken;
    const r = Math.random;
    for (const d of DRUMS) {
      // Around the style's own count, give or take a few.
      const hits = Math.max(1, Math.min(d.max, Math.round(style.hits[d.key] + (r() - 0.4) * (d.key === "hat" ? 8 : 3))));
      seq[`${d.key}Density`] = Math.round((hits / d.max) * 100) / 100;
      // The kick keeps the downbeat; the others can start anywhere.
      seq[`${d.key}Rotate`] = d.key === "kick" ? 0 : Math.floor(r() * STEPS);
    }
    seq.gridsX = Math.round(Math.max(0, Math.min(1, style.map[0] + (r() - 0.5) * 0.5)) * 100) / 100;
    seq.gridsY = Math.round(Math.max(0, Math.min(1, style.map[1] + (r() - 0.5) * 0.5)) * 100) / 100;
  }

  /** After a preset or a die changed several controls at once: show them, and save. */
  private seqChanged(): void {
    this.seq.version++;
    this.refreshSeqControls();
    this.saveGlobal();
  }

  /**
   * The hint line in the tab bar: whatever the pointer is over says what it
   * does there, so the sequencer's controls explain themselves without a
   * paragraph under each one. Tooltips are moved into it as they're met.
   */
  private buildHints(): void {
    const hint = $("dock-hint");
    const idle = "Hover over anything to see what it does. New here? Press Play, then try New idea, or a melody preset.";
    let shown = "";
    const show = (text: string) => {
      if (text === shown) return;
      shown = text;
      hint.textContent = text;
      hint.classList.toggle("idle", text === idle);
    };
    const tab = this.seqTab;
    tab.addEventListener("mouseover", (e) => {
      let node = e.target as HTMLElement | null;
      while (node && node !== tab) {
        if (node.title) {
          node.dataset.hint = node.title;
          node.removeAttribute("title");
        }
        if (node.dataset.hint) return show(node.dataset.hint);
        node = node.parentElement;
      }
      show(idle);
    });
    tab.addEventListener("mouseleave", () => show(idle));
    const update = () => show(tab.hidden ? "" : idle);
    for (const t of document.querySelectorAll<HTMLButtonElement>("#dock-tabs [data-tab]")) t.addEventListener("click", update);
    // The buttons up here explain themselves too.
    for (const b of [$("seq-play"), $("seq-mute")]) {
      b.addEventListener("mouseenter", () => { if (!tab.hidden) show(b.id === "seq-play" ? "Play or stop the sequencer (Space pauses everything)." : b.title); });
      b.addEventListener("mouseleave", update);
    }
    update();
  }

  /** The mixer: a strip per track and a master strip. Clicking a strip opens its controls. */
  private buildMixer(values: ParamValues, changed: (spec: ParamSpec) => void, spec: (part: string, key: string) => NumberSpec): void {
    const seq = this.settings.seq;
    const box = $("mixer");
    const strips: { key: TrackKey | "master"; strip: HTMLElement; mute?: HTMLButtonElement; solo?: HTMLButtonElement }[] = [];
    const dial = (d: Dial) => {
      this.seqControls.push(d);
      return d.el;
    };
    const bands: [number, number, string][] = [[0, 0.7, "#2ad4ff"], [0.7, 0.85, "#ffb547"], [0.85, 1, "#ff2a4f"]];
    const overlay = (this.stripOverlay = new LiveOverlay(box, (o) => {
      bands[0][2] = o.colour("--meter-low", "#2ad4ff");
      bands[1][2] = o.colour("--meter-mid", "#ffb547");
      bands[2][2] = o.colour("--meter-high", "#ff2a4f");
    }));
    for (const t of [...TRACKS, { key: "master" as const, label: "Master" }]) {
      const strip = el("div", { className: `strip${t.key === "master" ? " master" : ""}` });
      strip.dataset.track = t.key;
      const readout = el("div", { className: "strip-readout" });
      const knobs = el("div", { className: "strip-knobs" });
      let volume: NumberSpec;
      if (t.key === "master") {
        knobs.append(dial(knob(spec("Master", "echoFeedback"), values, changed, "gen:", "Fdbk")),
          dial(knob(spec("Master", "spaceSize"), values, changed, "gen:", "Room")));
        volume = spec("Master", "masterVolume");
      } else {
        knobs.append(dial(knob(spec("Mixer", `${t.key}Pan`), values, changed, "gen:", "Pan")),
          dial(knob(spec("Mixer", `${t.key}Echo`), values, changed, "gen:", "Echo")),
          dial(knob(spec("Mixer", `${t.key}Space`), values, changed, "gen:", "Rev")));
        volume = spec("Mixer", `${t.key}Volume`);
      }
      const f = fader(volume, values, changed, "gen:", readout);
      this.seqControls.push(f);
      const meter = { key: t.key, level: 0 };
      this.stripMeters.push(meter);
      // -48 dB to +6 dB fills the meter, cyan to amber to red near the top.
      overlay.add(f.meter, (g, x, y, w, h) => {
        const top = y + h * (1 - meter.level);
        for (const [from, to, colour] of bands) {
          const y0 = y + h * (1 - to), y1 = y + h * (1 - from);
          if (top < y1) {
            g.fillStyle = colour;
            g.fillRect(x, Math.max(top, y0), w, y1 - Math.max(top, y0));
          }
        }
      }, () => meter.level > 0);
      const buttons = el("div", { className: "strip-buttons" });
      const entry: (typeof strips)[number] = { key: t.key, strip };
      if (t.key !== "master") {
        const key = t.key;
        const mute = el("button", { type: "button", className: "small strip-btn mute", textContent: "M", title: "Mute: stops the track, so the visuals stop reacting to it too" });
        const solo = el("button", { type: "button", className: "small strip-btn solo", textContent: "S", title: "Solo: play only the soloed tracks" });
        mute.addEventListener("click", () => {
          seq[`${key}On`] = !seq[`${key}On`];
          this.seq.version++;
          this.showStrips();
          this.saveGlobal();
          mute.blur();
        });
        solo.addEventListener("click", () => {
          seq[`${key}Solo`] = !seq[`${key}Solo`];
          this.seq.version++;
          this.showStrips();
          this.saveGlobal();
          solo.blur();
        });
        buttons.append(mute, solo);
        entry.mute = mute;
        entry.solo = solo;
      } else {
        buttons.append(el("span", { className: "muted", textContent: "Out" }));
      }
      strip.append(el("div", { className: "strip-name", textContent: t.label }), knobs, f.el, readout, buttons);
      strip.addEventListener("pointerdown", () => this.selectTrack(t.key));
      box.append(strip);
      strips.push(entry);
    }
    this.showStrips = () => {
      for (const { key, strip, mute, solo } of strips) {
        strip.classList.toggle("selected", key === this.settings.mixerTrack);
        if (key === "master") continue;
        mute!.classList.toggle("active", !seq[`${key}On`]);
        solo!.classList.toggle("active", seq[`${key}Solo`]);
        // Silent because it's muted, or because another track is soloed.
        strip.classList.toggle("silent", !this.seq.audible(key));
        this.seqTab.querySelector(`.track-body[data-track="${key}"]`)?.classList.toggle("off", !this.seq.audible(key));
      }
    };
  }

  /** Open a mixer strip's controls beside the mixer. */
  private selectTrack(key: TrackKey | "master"): void {
    for (const body of this.seqTab.querySelectorAll<HTMLElement>(".track-body")) body.hidden = body.dataset.track !== key;
    // The panel takes the track's colour.
    const panel = this.seqTab.querySelector<HTMLElement>(".part-track")!;
    for (const t of TRACKS) panel.classList.toggle(`part-${t.key}`, t.key === key);
    if (this.settings.mixerTrack !== key) {
      this.settings.mixerTrack = key;
      this.saveGlobal();
    }
    // The track's views were hidden, so draw them afresh.
    this.melodyDrawn = this.chipsDrawn = "";
    this.showStrips();
  }

  private refreshSeqControls(): void {
    for (const c of this.seqControls) c.refresh();
    this.showPresetChips();
  }

  /**
   * Refresh what depends on a changed control, once a frame however many
   * changes arrive: a dragged knob or a MIDI knob sends hundreds a second,
   * and each refresh walks every control in the sequencer.
   */
  private refreshSoon(key: string, all = false): void {
    this.refreshKeys.add(key);
    this.refreshAll ||= all;
    if (this.refreshFrame) return;
    this.refreshFrame = requestAnimationFrame(() => {
      this.refreshFrame = 0;
      const keys = [...this.refreshKeys];
      const all = this.refreshAll;
      this.refreshKeys.clear();
      this.refreshAll = false;
      // Steps and density change each other's readouts (hits, offset within the length),
      // and the mixer and the Master panel share some controls.
      if (all || keys.some((k) => /^(kick|snare|hat)(Length|Density|Rotate)$/.test(k) || /^(echo|space|master)/.test(k))) this.refreshSeqControls();
      if (keys.some((k) => /^(kick|snare|hat)Mode$/.test(k))) this.showDrumModes();
      this.showPresetChips();
    });
  }

  /** Light the preset chips whose settings match the controls. */
  private showPresetChips(): void {
    const seq = this.settings.seq as unknown as Record<string, unknown>;
    for (const { button, values } of this.presetChips) {
      const on = Object.entries(values).every(([k, v]) => (typeof v === "number" ? Math.abs((seq[k] as number) - v) < 1e-6 : seq[k] === v));
      button.classList.toggle("active", on);
    }
  }

  /** Set a sequencer control from a 0..1 knob position (MIDI CC). */
  private setGen(key: string, v: number): void {
    const found = findSeqSpec(key);
    if (!found) return;
    const values = this.settings.seq as unknown as ParamValues;
    const next = knobValue(found.spec, v);
    if (found.spec.kind === "choice" && next === values[key]) return;
    values[key] = next;
    if (key === "chordStyle") this.seq.refreshHarmony();
    this.seq.version++;
    // The control itself must follow the knob, then whatever depends on it, once a frame.
    this.refreshSoon(key, true);
    this.saveGlobal();
  }

  private ringSize = 176;
  private ringDrawn = "";
  private padCtx: CanvasRenderingContext2D | null = null;
  /** What the pad last drew, so it only redraws when the map position or modes change. */
  private padDrawn = "";

  /** Show each voice's mode, and in the open voice's panel only the controls its mode uses. */
  private showDrumModes(): void {
    const seq = this.settings.seq;
    for (const d of DRUMS) {
      const mode = seq[`${d.key}Mode`];
      for (const b of document.querySelectorAll<HTMLElement>(`.drum-mode[data-target="gen:${d.key}Mode"] button`)) {
        b.classList.toggle("active", b.dataset.mode === mode);
      }
      const panel = document.querySelector<HTMLElement>(`.drum-panel[data-voice="${d.key}"]`);
      if (!panel) continue;
      panel.querySelector<HTMLElement>(".voice-euclid")!.hidden = mode === "grids";
      panel.querySelector<HTMLElement>(".voice-grids")!.hidden = mode === "euclid";
    }
    // The drum map is shared by every voice, so it moves into whichever panel is open.
    const open = document.querySelector<HTMLElement>(`.drum-panel[data-voice="${this.settings.drumVoice}"] .grids-slot`);
    if (open && $("grids-map").parentElement !== open) open.append($("grids-map"));
    this.padDrawn = "";
    this.drawGridsPad();
  }

  /** Open a drum voice's controls. */
  private selectDrum(key: DrumKey): void {
    for (const row of document.querySelectorAll<HTMLElement>(".drum-voice-row")) row.classList.toggle("selected", row.dataset.voice === key);
    for (const panel of document.querySelectorAll<HTMLElement>(".drum-panel")) panel.hidden = panel.dataset.voice !== key;
    if (this.settings.drumVoice !== key) {
      this.settings.drumVoice = key;
      this.saveGlobal();
    }
    this.showDrumModes();
  }

  /** The drum map as an X/Y pad: drag the dot to move round it, double-click for the style's spot. */
  private buildGridsPad(): void {
    const pad = $<HTMLCanvasElement>("grids-pad");
    const dpr = window.devicePixelRatio || 1;
    pad.width = Math.round(PAD_WIDTH * dpr);
    pad.height = Math.round(PAD_HEIGHT * dpr);
    this.padCtx = pad.getContext("2d");
    this.padCtx?.scale(dpr, dpr);
    const seq = this.settings.seq;
    const move = (e: PointerEvent) => {
      const r = pad.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - r.left - PAD_INSET) / (r.width - 2 * PAD_INSET)));
      const y = Math.max(0, Math.min(1, 1 - (e.clientY - r.top - PAD_INSET) / (r.height - 2 * PAD_INSET)));
      seq.gridsX = Math.round(x * 100) / 100;
      seq.gridsY = Math.round(y * 100) / 100;
      this.seq.version++;
      this.refreshSeqControls();
      this.drawGridsPad();
    };
    let dragging = false;
    pad.addEventListener("pointerdown", (e) => {
      dragging = true;
      pad.setPointerCapture(e.pointerId);
      move(e);
    });
    pad.addEventListener("pointermove", (e) => { if (dragging) move(e); });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      this.saveGlobal();
    };
    pad.addEventListener("pointerup", end);
    pad.addEventListener("pointercancel", end);
    pad.addEventListener("dblclick", () => {
      [seq.gridsX, seq.gridsY] = (STYLES[seq.style] ?? STYLES.broken).map;
      this.seq.version++;
      this.refreshSeqControls();
      this.drawGridsPad();
      this.saveGlobal();
    });
  }

  private drawGridsPad(): void {
    const g = this.padCtx;
    if (!g) return;
    const seq = this.settings.seq;
    const drawn = `${seq.gridsX}|${seq.gridsY}`;
    if (drawn === this.padDrawn) return;
    this.padDrawn = drawn;
    const w = PAD_WIDTH, h = PAD_HEIGHT, i = PAD_INSET;
    const px = (x: number) => i + x * (w - 2 * i), py = (y: number) => h - i - y * (h - 2 * i);
    g.clearRect(0, 0, w, h);
    // The map's patterns sit on a grid; between them they blend.
    g.fillStyle = "#1c3442";
    for (let r = 0; r < GRIDS_ROWS; r++) {
      for (let c = 0; c < GRIDS_COLS; c++) {
        g.beginPath();
        g.arc(px(c / (GRIDS_COLS - 1)), py(r / (GRIDS_ROWS - 1)), 2, 0, Math.PI * 2);
        g.fill();
      }
    }
    const x = px(seq.gridsX), y = py(seq.gridsY);
    g.strokeStyle = "rgba(42, 212, 255, 0.35)";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, i);
    g.lineTo(x, h - i);
    g.moveTo(i, y);
    g.lineTo(w - i, y);
    g.stroke();
    g.fillStyle = "#2ad4ff";
    g.beginPath();
    g.arc(x, y, 5, 0, Math.PI * 2);
    g.fill();
    $("grids-name").textContent = gridsName(seq.gridsX, seq.gridsY);
  }

  /** The drum rings: drag one round to turn its pattern, double-click to put it back. */
  private buildRing(): void {
    const ring = $<HTMLCanvasElement>("drum-ring");
    const dpr = window.devicePixelRatio || 1;
    ring.width = ring.height = Math.round(this.ringSize * dpr);
    this.ringCtx = ring.getContext("2d");
    this.ringCtx?.scale(dpr, dpr);
    const seq = this.settings.seq as unknown as Record<string, number>;
    const at = (e: MouseEvent) => {
      const r = ring.getBoundingClientRect();
      const dx = e.clientX - r.left - r.width / 2, dy = e.clientY - r.top - r.height / 2;
      const radius = Math.hypot(dx, dy) / (r.width / 2);
      // Nearest ring, inner (kick) to outer (hat).
      let track = 0;
      RING_RADII.forEach((rr, i) => { if (Math.abs(rr - radius) < Math.abs(RING_RADII[track] - radius)) track = i; });
      return { track, angle: Math.atan2(dy, dx) };
    };
    let drag: { key: DrumKey; angle: number; rotate: number } | null = null;
    ring.addEventListener("pointerdown", (e) => {
      const { track, angle } = at(e);
      const key = DRUMS[track].key;
      this.selectDrum(key);
      drag = { key, angle, rotate: this.seq.rotation(key) };
      ring.setPointerCapture(e.pointerId);
    });
    ring.addEventListener("pointermove", (e) => {
      if (!drag) return;
      let delta = at(e).angle - drag.angle;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      const len = this.seq.length(drag.key);
      const next = (((drag.rotate + Math.round((delta / (Math.PI * 2)) * len)) % len) + len) % len;
      if (next !== seq[`${drag.key}Rotate`]) {
        seq[`${drag.key}Rotate`] = next;
        this.seq.version++;
        this.refreshSeqControls();
      }
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      this.saveGlobal();
    };
    ring.addEventListener("pointerup", end);
    ring.addEventListener("pointercancel", end);
    // Double-click puts a ring back where the style starts it.
    ring.addEventListener("dblclick", (e) => {
      const key = DRUMS[at(e).track].key;
      seq[`${key}Rotate`] = (STYLES[this.settings.seq.style] ?? STYLES.broken).rotate[key];
      this.seq.version++;
      this.refreshSeqControls();
      this.saveGlobal();
    });
  }

  /** Redraw the meters and the open track's views while the sequencer tab is showing. */
  private drawSequencer(elapsed: number): void {
    if (!this.seqTab || this.seqTab.hidden || $("dock").classList.contains("collapsed")) return;
    const peaks = this.audio.peaks();
    let key = "";
    for (const m of this.stripMeters) {
      // -48 dB to +6 dB fills the meter; it jumps up and falls back gently.
      const p = peaks[m.key];
      const h = p > 0 ? Math.max(0, (20 * Math.log10(p) + 48) / 54) : 0;
      m.level = h > m.level ? h : Math.max(h, m.level - 1.5 * elapsed);
      key += q(m.level) + ",";
    }
    this.stripOverlay?.draw(key);
    const track = this.settings.mixerTrack;
    if (track === "drums") {
      this.drawRing();
      this.drawGridsPad();
    }
    else if (track === "melody") this.drawMelody();
    else if (track === "chords") this.drawChords();
    if (track !== "master") this.drawCaptions();
  }

  private drawRing(): void {
    const g = this.ringCtx!;
    const size = this.ringSize, c = size / 2, R = size / 2 - 8;
    const seq = this.settings.seq;
    const playing = this.seq.playing && this.seq.current >= 0;
    // Nothing moved since the last draw: a redraw would only make the webview repaint the ring for nothing.
    const key = [this.seq.version, playing, this.seq.fillPending, this.seq.drumCurrent.join(","), DRUMS.map((d) => q(this.sources.get(d.role) * 0.3)).join(",")].join("|");
    if (key === this.ringDrawn) return;
    this.ringDrawn = key;
    g.clearRect(0, 0, size, size);
    // Each ring has its own number of steps, starting at the top.
    g.strokeStyle = "#1c3442";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(c, c - R * 0.2);
    g.lineTo(c, c - R - 6);
    g.stroke();
    DRUMS.forEach((d, i) => {
      const r = RING_RADII[i] * R;
      const len = this.seq.length(d.key);
      const angle = (pos: number) => -Math.PI / 2 + (pos / len) * Math.PI * 2;
      const on = this.seq.audible("drums") && seq[`${d.key}On`];
      g.globalAlpha = on ? 1 : 0.35;
      g.strokeStyle = "#1c3442";
      g.lineWidth = 1;
      g.beginPath();
      g.arc(c, c, r, 0, Math.PI * 2);
      g.stroke();
      const cur = playing ? this.seq.drumCurrent[i] : -1;
      if (cur >= 0) {
        // This ring's playhead: a short sweep across the ring.
        const a = angle(cur);
        g.strokeStyle = "rgba(217, 238, 242, 0.45)";
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(c + Math.cos(a) * (r - 7), c + Math.sin(a) * (r - 7));
        g.lineTo(c + Math.cos(a) * (r + 7), c + Math.sin(a) * (r + 7));
        g.stroke();
      }
      // The euclidean shape: a polygon through the pattern's hits.
      const base = this.seq.basePattern(i);
      const pts = base.map((hit, k) => (hit ? k : -1)).filter((k) => k >= 0);
      if (pts.length > 1) {
        g.strokeStyle = d.colour;
        g.globalAlpha = on ? 0.3 : 0.1;
        g.beginPath();
        pts.forEach((k, j) => {
          const x = c + Math.cos(angle(k)) * r, y = c + Math.sin(angle(k)) * r;
          if (j === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        });
        g.closePath();
        g.stroke();
      }
      const env = this.sources.get(d.role);
      // Fills land at the end of the bar, so they only show on a ring that's a bar long.
      const barLong = len === STEPS;
      for (let k = 0; k < len; k++) {
        const hit = this.seq.drumHit(i, k, barLong ? k : -1);
        const x = c + Math.cos(angle(k)) * r, y = c + Math.sin(angle(k)) * r;
        g.globalAlpha = on ? 1 : 0.35;
        if (!hit.on) {
          g.fillStyle = "#1c3442";
          g.beginPath();
          g.arc(x, y, 2, 0, Math.PI * 2);
          g.fill();
          continue;
        }
        const now = k === cur;
        const rad = 2.5 + 2.5 * hit.velocity + (now ? 3 * env : 0);
        if (hit.kind === "ghost") {
          g.strokeStyle = d.colour;
          g.lineWidth = 1.5;
          g.beginPath();
          g.arc(x, y, rad, 0, Math.PI * 2);
          g.stroke();
        } else {
          g.fillStyle = hit.kind === "fill" ? "#b48cff" : d.colour;
          if (!now) g.globalAlpha *= 0.55 + 0.45 * hit.velocity;
          g.beginPath();
          g.arc(x, y, rad, 0, Math.PI * 2);
          g.fill();
        }
      }
    });
    g.globalAlpha = 1;
    if (this.seq.fillPending) {
      g.fillStyle = "#b48cff";
      g.font = "11px 'Sora Variable', system-ui, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("fill", c, c);
    }
  }

  /**
   * The melody's marbles: the note loop as dots at their heights (a faint dot
   * where each value fell before Steps moved it), the rhythm loop as a row of
   * ticks underneath, the distribution Spread and Bias make down the left, and
   * the notes Steps allows as lines across.
   */
  private drawMelody(): void {
    const g = this.melodyCtx;
    if (!g) return;
    const canvas = g.canvas;
    const seq = this.seq;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = this.melodySize;
    if (w === 0) return;
    const cur = seq.melodyCursor;
    const key = [seq.version, cur.tick, cur.note, seq.playing, seq.chordIndex, seq.key, seq.audible("melody"), w, h, dpr].join("|");
    if (key === this.melodyDrawn) return;
    this.melodyDrawn = key;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const loop = seq.melodyLoop();
    const playing = seq.playing;
    const left = 34, right = w - 6, top = 8, bottom = h - 26;
    const y = (x: number) => bottom - x * (bottom - top);
    // The notes Steps allows, the chord's root brightest.
    for (const n of seq.melodyLadder()) {
      g.fillStyle = n.weight >= 255 ? "rgba(108, 157, 255, 0.4)" : n.weight >= 160 ? "rgba(108, 157, 255, 0.18)" : "rgba(255, 255, 255, 0.07)";
      g.fillRect(left, Math.round(y(n.x)) - 0.5, right - left, 1);
    }
    // Where notes are likely to land.
    const pdf = seq.distribution.pdf;
    g.beginPath();
    g.moveTo(4, y(0));
    for (let i = 0; i < pdf.length; i++) g.lineTo(4 + pdf[i] * 24, y((i + 0.5) / pdf.length));
    g.lineTo(4, y(1));
    g.closePath();
    g.fillStyle = "rgba(108, 157, 255, 0.22)";
    g.fill();
    g.strokeStyle = "rgba(108, 157, 255, 0.7)";
    g.lineWidth = 1;
    g.stroke();
    // Bias, as a tick on the curve's spine.
    g.fillStyle = "#6c9dff";
    g.fillRect(2, y(this.settings.seq.melodyBias) - 1, 6, 2);

    const L = loop.notes.length;
    const cell = (right - left) / Math.max(1, L);
    const cx = (k: number) => left + (k + 0.5) * cell;
    // A faint thread through the loop's notes, in order.
    g.strokeStyle = "rgba(108, 157, 255, 0.25)";
    g.lineWidth = 1.5;
    g.beginPath();
    loop.notes.forEach((n, k) => (k === 0 ? g.moveTo(cx(k), y(n.x)) : g.lineTo(cx(k), y(n.x))));
    g.stroke();
    const r = Math.max(2.5, Math.min(6, cell * 0.3));
    loop.notes.forEach((n, k) => {
      const now = playing && k === loop.note;
      if (Math.abs(n.raw - n.x) > 0.01) {
        // Where the value fell, and the note Steps moved it to.
        g.strokeStyle = "rgba(255, 255, 255, 0.12)";
        g.beginPath();
        g.moveTo(cx(k), y(n.raw));
        g.lineTo(cx(k), y(n.x));
        g.stroke();
        g.fillStyle = "rgba(255, 255, 255, 0.25)";
        g.beginPath();
        g.arc(cx(k), y(n.raw), 1.5, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = now ? "#e4ecff" : "#6c9dff";
      g.beginPath();
      g.arc(cx(k), y(n.x), now ? r + 1.5 : r, 0, Math.PI * 2);
      g.fill();
    });
    // The rhythm loop: which ticks play.
    const ty = h - 11;
    const tick = (right - left) / Math.max(1, loop.ticks.length);
    loop.ticks.forEach((t, k) => {
      const x = left + k * tick + 1.5, tw = Math.max(2, tick - 3);
      const now = playing && k === loop.tick;
      if (t.on) {
        g.fillStyle = now ? "#2ad4ff" : `rgba(108, 157, 255, ${0.35 + 0.55 * t.velocity})`;
        g.fillRect(x, ty - 4, tw, 8);
      } else {
        g.strokeStyle = now ? "#2ad4ff" : "rgba(255, 255, 255, 0.12)";
        g.strokeRect(x + 0.5, ty - 3.5, tw - 1, 7);
      }
    });
  }

  /** One line under each track's title saying, in words, what it's doing. */
  private drawCaptions(): void {
    const seq = this.seq;
    const s = this.settings.seq;
    const key = [seq.version, s.hold, s.melodyHold, s.energy, s.evolve].join("|");
    if (key === this.captionsDrawn) return;
    this.captionsDrawn = key;
    $("drums-caption").textContent = DRUMS.filter((d) => s[`${d.key}On`]).map((d) => {
      const mode = s[`${d.key}Mode`];
      const hits = seq.pulses(d.key);
      return mode === "grids" ? `${d.label} on the map` : `${d.label} ${hits}${mode === "both" ? " + map" : ""}`;
    }).join(" · ");
    $("bass-caption").textContent = ["Root notes only", "Roots and octaves", "Roots, octaves and fifths", "Chord notes", "Chord notes", "Chord notes and sevenths", "Chord and passing notes"][s.bassRange - 1] ?? "";
    const len = s.melodyLength;
    const dv = seq.held("melody") ? 0.5 : s.melodyDejaVu;
    const what = s.melodyLoop === "rhythm" ? " (rhythm only)" : s.melodyLoop === "notes" ? " (notes only)" : "";
    $("melody-caption").textContent = seq.held("melody") ? `Held: looping ${len} ticks`
      : dv < 0.04 ? "Every note is new"
      : dv < 0.47 ? `Repeats ${Math.round((1 - (2 * dv - 1) ** 2) * 100)}% of its last ${len} ticks${what}`
      : dv <= 0.53 ? `Looping ${len} ticks${what}`
      : `Shuffling a loop of ${len}${what}`;
  }

  /** The progression as chips, with the sounding chord lit. */
  private drawChords(): void {
    const seq = this.seq;
    const key = [seq.version, seq.chordIndex, seq.key, seq.cycle.map((c) => c.root + ":" + c.tones.join(",")).join(" ")].join("|");
    if (key === this.chipsDrawn) return;
    this.chipsDrawn = key;
    const box = $("chord-chips");
    box.replaceChildren(
      ...seq.cycle.map((c, i) => el("span", { className: `chip${i === seq.chordIndex ? " current" : ""}`, textContent: chordName(c, seq.key), title: c.numeral })),
    );
    if (seq.lift) box.append(el("span", { className: "chip lift", textContent: `+${seq.lift}`, title: "Epic has lifted the key for this pass" }));
  }

  private updateMeters(): void {
    if ($("dock").classList.contains("collapsed")) return;
    if (this.tab === "audio" && this.audioOverlay) {
      let key = "";
      for (const k in this.meterLevels) key += q((this.meterLevels[k] = this.sources.get(k))) + ",";
      this.audioOverlay.draw(key);
    } else if (this.tab === "modulation") {
      let key = "";
      for (const m of this.sourceMeters) key += q((m.level = Math.abs(this.sources.get(m.source())))) + ",";
      this.builtinOverlay?.draw(key);
      this.matrixOverlay?.draw(key);
    }
  }

  /** Draw the modulation matrix: the model's built-in reactions beside the routes. */
  private renderRoutes(): void {
    this.sourceMeters = [];
    this.renderReactions();
    const box = $("mod-routes");
    box.replaceChildren();
    this.matrixOverlay?.dispose();
    const overlay = (this.matrixOverlay = new LiveOverlay(box, (o) => { o.fill = o.colour("--cyan", "#2ad4ff"); }));
    const targets = this.targets();
    if (this.modelSettings.routes.length === 0) {
      box.append(el("p", { className: "muted", textContent: "No routes. Add one here, or with the ♪ button beside any slider." }));
    }
    // The MIDI sources only clutter the menu until a controller is connected or one is already in use.
    const midiShown = this.settings.inputs.length > 0 || this.modelSettings.routes.some((r) => r.source.startsWith("cc:") || r.source === "modwheel" || r.source === "pitchbend");
    this.modelSettings.routes.forEach((route, i) => {
      const on = el("input", { type: "checkbox", checked: !route.off, title: "Switch this route on or off" });
      const source = el("select");
      const groups = new Map<string, HTMLOptGroupElement>();
      for (const s of SOURCES) {
        if (s.group === "MIDI" && !midiShown) continue;
        let g = groups.get(s.group);
        if (!g) {
          g = el("optgroup", { label: s.group });
          groups.set(s.group, g);
          source.append(g);
        }
        g.append(el("option", { value: s.id, textContent: s.label }));
      }
      const ccGroup = groups.get("MIDI");
      if (ccGroup) for (const n of this.sources.ccList()) ccGroup.append(el("option", { value: `cc:${n}`, textContent: `CC ${n}` }));
      if (![...source.options].some((o) => o.value === route.source)) {
        (ccGroup ?? source).append(el("option", { value: route.source, textContent: sourceLabel(route.source) }));
      }
      source.value = route.source;
      source.addEventListener("change", () => { route.source = source.value; this.routesChanged(); source.blur(); });

      const meter = el("div", { className: "meter-track", title: "What this sound is doing right now" });
      const live = { level: 0, source: () => route.source };
      this.sourceMeters.push(live);
      overlay.add(meter, (g, x, y, w, h) => bar(g, x, y, w * Math.min(1, live.level), h), () => live.level > 0);

      // The arrow finds the slider in the sidebar.
      const locate = el("button", { type: "button", className: "small locate", textContent: "→", title: "Show this slider in the sidebar" });
      locate.addEventListener("click", () => { this.locateTarget(route.target); locate.blur(); });

      const target = el("select");
      const targetGroups = new Map<string, HTMLOptGroupElement>();
      for (const t of targets) {
        let g = targetGroups.get(t.group);
        if (!g) {
          g = el("optgroup", { label: t.group });
          targetGroups.set(t.group, g);
          target.append(g);
        }
        g.append(el("option", { value: t.id, textContent: t.label }));
      }
      target.value = route.target;
      target.addEventListener("change", () => {
        route.target = target.value;
        row.dataset.target = route.target;
        this.routesChanged();
        target.blur();
        this.locateTarget(route.target);
      });

      const amount = el("input", { type: "range", min: "-1", max: "1", step: "0.05", value: String(route.amount), title: "How far it pushes, as a share of the slider's range. Double-click to zero." });
      const readout = el("span", { className: "readout", textContent: formatAmount(route.amount) });
      const setAmount = (v: number) => {
        route.amount = v;
        readout.textContent = formatAmount(v);
        this.routesChanged();
      };
      amount.addEventListener("input", () => setAmount(Number(amount.value)));
      amount.addEventListener("dblclick", () => { amount.value = "0"; setAmount(0); });
      const roll = diceButton("Roll a random slider and amount for this route; the sound stays");
      roll.addEventListener("click", () => {
        // A different slider when there is one, pushed a clear amount either way.
        // Half the rolls land on the model's own sliders, the rest on macros or
        // global controls, so the long global list doesn't crowd them out.
        const others = targets.filter((t) => t.id !== route.target);
        const kind = (id: string) => (id.startsWith("macro:") ? "macro" : id.startsWith("global:") ? "global" : "param");
        const r = Math.random();
        const want = r < 0.5 ? "param" : r < 0.75 ? "macro" : "global";
        const pool = [others.filter((t) => kind(t.id) === want), others, targets].find((p) => p.length)!;
        route.target = pool[Math.floor(Math.random() * pool.length)].id;
        route.amount = randomStep(0.25, 1, 0.05) * (Math.random() < 0.5 ? -1 : 1);
        this.routesChanged();
        this.renderRoutes();
      });
      const remove = el("button", { type: "button", textContent: "×", className: "small", title: "Remove route" });
      remove.addEventListener("click", () => {
        this.modelSettings.routes.splice(i, 1);
        this.routesChanged();
        this.renderRoutes();
      });
      const row = el("div", { className: `route${route.off ? " off" : ""}${this.rowFlash === route.target ? " flash" : ""}` }, on, source, meter, locate, target, amount, readout, roll, remove);
      row.dataset.target = route.target;
      on.addEventListener("change", () => {
        route.off = !on.checked || undefined;
        row.classList.toggle("off", !on.checked);
        this.routesChanged();
      });
      box.append(row);
    });
    this.showRouteBadges();
  }

  private routesChanged(): void {
    this.saveModel();
    this.showRouteBadges();
  }

  /**
   * The model's built-in reactions, as matrix rows grouped by the kind of
   * sound they listen to. Each group folds to one strength slider that sets
   * every row in it; unfolded, each row has its own strength, switch and ×.
   */
  private renderReactions(): void {
    const box = $("mod-builtins");
    box.replaceChildren();
    this.builtinOverlay?.dispose();
    const overlay = (this.builtinOverlay = new LiveOverlay(box, (o) => { o.fill = o.colour("--cyan", "#2ad4ff"); }));
    $("mod-builtins-title").textContent = this.def ? `Built into ${this.def.name}` : "Built into this model";
    const all = this.def?.reactions ?? [];
    if (all.length === 0) {
      box.append(el("p", { className: "muted", textContent: "This model doesn't react to music by itself; routes are how music reaches it." }));
    }
    const rows = this.modelSettings.reactions;
    const open = loadOpenGroups();
    for (const group of REACTION_GROUPS) {
      const inGroup = rows.filter((r) => group.sources.includes(r.source) && all.some((a) => a.source === r.source));
      if (inGroup.length === 0) continue;
      const details = el("details", { className: "mod-group", open: open.has(group.name) });
      const summary = el("summary");
      const name = el("span", { className: "mod-group-name", textContent: group.name, title: `${group.text}. Click to see each reaction.` });
      const master = el("input", { type: "range", min: "0", max: "2", step: "0.05", title: `How strongly ${this.def?.name ?? "the model"} reacts to ${group.name.toLowerCase()}: sets every reaction in the group. Double-click for 100%.` });
      const masterOut = el("span", { className: "readout" });
      const strengths: ((v: number) => void)[] = [];
      const showMaster = () => {
        const on = inGroup.filter((r) => !r.off);
        const amounts = on.map((r) => r.amount);
        const same = amounts.every((a) => Math.abs(a - amounts[0]) < 0.001);
        const mean = amounts.length ? amounts.reduce((a, b) => a + b, 0) / amounts.length : 0;
        master.value = String(mean);
        paintRange(master);
        masterOut.textContent = on.length === 0 ? "off" : same ? pct(amounts[0]) : `~${pct(mean)}`;
        summary.classList.toggle("off", on.length === 0);
      };
      const setAll = (v: number) => {
        for (const r of inGroup) r.amount = v;
        strengths.forEach((f) => f(v));
        showMaster();
        this.saveModel();
      };
      master.addEventListener("input", () => setAll(Number(master.value)));
      master.addEventListener("dblclick", () => setAll(1));
      // The slider sits in the summary, so dragging it must not fold the group.
      for (const ev of ["click", "pointerdown"] as const) master.addEventListener(ev, (e) => e.stopPropagation());
      summary.append(name, master, masterOut);
      details.append(summary);
      details.addEventListener("toggle", () => {
        if (details.open) open.add(group.name);
        else open.delete(group.name);
        saveOpenGroups(open);
      });
      const body = el("div", { className: "mod-rows" });
      for (const row of inGroup) {
        const spec = all.find((r) => r.source === row.source)!;
        const on = el("input", { type: "checkbox", checked: !row.off, title: "Switch this reaction on or off" });
        const source = el("span", { className: "fixed", textContent: REACTION_LABELS[row.source], title: `Always listens to this sound` });
        const meter = el("div", { className: "meter-track", title: "What this sound is doing right now" });
        const live = { level: 0, source: () => REACTION_METERS[row.source] };
        this.sourceMeters.push(live);
        overlay.add(meter, (g, x, y, w, h) => bar(g, x, y, w * Math.min(1, live.level), h), () => live.level > 0);
        const target = el("span", { className: "fixed builtin", title: spec.text, textContent: spec.label });
        const amount = el("input", { type: "range", min: "0", max: "2", step: "0.05", value: String(row.amount), title: "How strongly the model reacts. 100% is as designed. Double-click for 100%." });
        paintRange(amount);
        const readout = el("span", { className: "readout", textContent: pct(row.amount) });
        const setAmount = (v: number) => {
          row.amount = v;
          readout.textContent = pct(v);
          paintRange(amount);
          showMaster();
          this.saveModel();
        };
        strengths.push((v) => { amount.value = String(v); readout.textContent = pct(v); paintRange(amount); });
        amount.addEventListener("input", () => setAmount(Number(amount.value)));
        amount.addEventListener("dblclick", () => { amount.value = "1"; setAmount(1); });
        const remove = el("button", { type: "button", textContent: "×", className: "small", title: "Remove this reaction (Restore built-ins brings it back)" });
        remove.addEventListener("click", () => {
          rows.splice(rows.indexOf(row), 1);
          this.saveModel();
          this.renderRoutes();
        });
        const r = el("div", { className: `route reaction-row${row.off ? " off" : ""}`, title: spec.text }, on, source, meter, el("span", { className: "muted", textContent: "→" }), target, amount, readout, remove);
        on.addEventListener("change", () => {
          row.off = !on.checked || undefined;
          r.classList.toggle("off", !on.checked);
          showMaster();
          this.saveModel();
        });
        body.append(r);
      }
      showMaster();
      details.append(body);
      box.append(details);
    }
    const missing = all.length - rows.length;
    const restore = $("mod-restore");
    restore.hidden = missing <= 0;
    restore.textContent = `Restore built-ins (${missing})`;
  }

  /** Under each sidebar slider, name the routes pushing it. */
  private showRouteBadges(): void {
    const params: Record<string, string[]> = {};
    const macros: Record<string, string[]> = {};
    const globals: Record<string, string[]> = {};
    for (const r of this.modelSettings.routes) {
      if (r.off || r.amount === 0) continue;
      const text = `${sourceLabel(r.source)} ${formatAmount(r.amount)}`;
      const [bucket, key] = r.target.startsWith("macro:") ? [macros, r.target.slice(6)]
        : r.target.startsWith("global:") ? [globals, r.target.slice(7)]
        : [params, r.target];
      (bucket[key] ??= []).push(text);
    }
    const join = (m: Record<string, string[]>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.join(", ")]));
    this.paramControls?.showRoutes(join(params));
    this.macroControls?.showRoutes(join(macros));
    this.globalControls?.showRoutes(join(globals));
  }
}


/** A control's value for a 0..1 knob position (MIDI CC): numbers snap to their step, dropdowns pick by slice. */
/** Saved presets with anything malformed dropped. */
function sanitizePresets(saved: unknown): GlobalPreset[] {
  if (!Array.isArray(saved)) return [];
  return saved
    .filter((p): p is GlobalPreset => !!p && typeof p.name === "string" && p.name.trim() !== "" && !!p.values && typeof p.values === "object")
    .map((p) => ({ name: p.name.trim(), values: sanitizeGlobals(p.values) }));
}

function knobValue(spec: ParamSpec, v: number): number | boolean | string {
  if (spec.kind === "number") {
    const raw = spec.min + v * (spec.max - spec.min);
    return Math.min(spec.max, Math.max(spec.min, Math.round(raw / spec.step) * spec.step));
  }
  if (spec.kind === "boolean") return v >= 0.5;
  if (spec.kind === "widget") return 0;
  return spec.options[Math.min(spec.options.length - 1, Math.floor(v * spec.options.length))].value;
}

/** Every built-in reaction of the model, on at full strength. */
function defaultReactions(def: ModelDefinition): ReactionRow[] {
  return (def.reactions ?? []).map((r) => ({ source: r.source, amount: 1 }));
}

/**
 * The reaction rows from a save, keeping only the model's own and dropping
 * anything malformed. Saves from before reactions were rows only listed
 * those switched off, so every reaction comes back with those off.
 */
function savedReactions(def: ModelDefinition, saved: SavedModelSettings): ReactionRow[] {
  if (!Array.isArray(saved.reactions)) {
    const muted = saved.muted ?? [];
    return defaultReactions(def).map((r) => (muted.includes(r.source) ? { ...r, off: true } : r));
  }
  const own = new Set((def.reactions ?? []).map((r) => r.source));
  const seen = new Set<ReactionSource>();
  return saved.reactions.filter((r) => {
    if (!r || !own.has(r.source) || seen.has(r.source)) return false;
    seen.add(r.source);
    return true;
  }).map((r) => ({
    source: r.source,
    amount: typeof r.amount === "number" && Number.isFinite(r.amount) ? Math.min(2, Math.max(0, r.amount)) : 1,
    ...(r.off ? { off: true } : {}),
  }));
}

/** The small die on a matrix row that rerolls just that row. */
function diceButton(title: string): HTMLButtonElement {
  const b = el("button", { type: "button", className: "small dice", title });
  b.innerHTML = DICE_ICON;
  b.setAttribute("aria-label", title);
  return b;
}

function formatAmount(v: number): string {
  return `${v > 0 ? "+" : ""}${Math.round(v * 100)}%`;
}
