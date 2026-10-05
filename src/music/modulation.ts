import type { MacroSpec, ModRoute, ModelDefinition, NoteEvent, ParamSpec, ParamValues } from "../models/types";

/**
 * The modulation layer. Music sources (note envelopes, LFOs, audio bands,
 * MIDI controllers) are kept here as 0..1 signals, and every frame the host
 * combines them with the slider values, macros and routes into the
 * parameter values the model actually sees.
 */

export interface SourceInfo {
  id: string;
  label: string;
  group: string;
  /** Bipolar sources swing -1..1 instead of 0..1. */
  bipolar?: boolean;
}

export const SOURCES: SourceInfo[] = [
  { id: "env", label: "Any note", group: "Notes" },
  { id: "kick", label: "Kick", group: "Notes" },
  { id: "snare", label: "Snare", group: "Notes" },
  { id: "hat", label: "Hi-hat", group: "Notes" },
  { id: "tone", label: "Melody notes", group: "Notes" },
  { id: "bassline", label: "Bass notes", group: "Notes" },
  { id: "chord", label: "Chords", group: "Notes" },
  { id: "velocity", label: "Last velocity", group: "Notes" },
  { id: "pitch", label: "Last pitch", group: "Notes" },
  { id: "gate", label: "Held MIDI notes", group: "Notes" },
  { id: "lfoBar", label: "LFO, 1 bar", group: "Tempo" },
  { id: "lfoBeat", label: "LFO, 1 beat", group: "Tempo" },
  { id: "ramp", label: "Ramp, 1 bar", group: "Tempo" },
  { id: "level", label: "Sound level", group: "Audio" },
  { id: "bass", label: "Bass", group: "Audio" },
  { id: "mid", label: "Mids", group: "Audio" },
  { id: "treble", label: "Treble", group: "Audio" },
  { id: "modwheel", label: "Mod wheel (CC 1)", group: "MIDI" },
  { id: "pitchbend", label: "Pitch bend", group: "MIDI", bipolar: true },
];

/** CC numbers offered as sources even before a controller has sent them. */
const COMMON_CCS = [2, 7, 10, 11, 16, 17, 18, 19, 71, 74];

export function sourceLabel(id: string): string {
  if (id.startsWith("cc:")) return `CC ${id.slice(3)}`;
  return SOURCES.find((s) => s.id === id)?.label ?? id;
}

export interface AudioBands {
  level: number;
  bass: number;
  mid: number;
  treble: number;
}

export class ModSources {
  readonly values: Record<string, number> = {};
  /** Seconds for a note envelope to fall to ~37%. */
  decay = 0.25;
  private held = new Set<number>();
  private seenCcs = new Set<number>(COMMON_CCS);

  constructor() {
    for (const s of SOURCES) this.values[s.id] = 0;
  }

  /** Advance envelopes and LFOs. `beats` is the musical clock in quarter notes. */
  update(dt: number, beats: number, bands: AudioBands): void {
    const fall = Math.exp(-dt / Math.max(0.02, this.decay));
    for (const id of ["env", "kick", "snare", "hat", "tone", "bassline"]) this.values[id] *= fall;
    // Chords ring longer than single notes.
    this.values.chord *= Math.exp(-dt / Math.max(0.05, this.decay * 2.5));
    this.values.lfoBar = 0.5 - 0.5 * Math.cos((beats / 4) * Math.PI * 2);
    this.values.lfoBeat = 0.5 - 0.5 * Math.cos(beats * Math.PI * 2);
    this.values.ramp = (beats / 4) % 1;
    this.values.level = bands.level;
    this.values.bass = bands.bass;
    this.values.mid = bands.mid;
    this.values.treble = bands.treble;
    this.values.gate = this.held.size > 0 ? 1 : 0;
  }

  trigger(ev: NoteEvent): void {
    const v = this.values;
    v.env = Math.max(v.env, ev.velocity);
    v[ev.role] = Math.max(v[ev.role], ev.velocity);
    v.velocity = ev.velocity;
    if (ev.role === "tone") v.pitch = ev.x;
    if (ev.source === "midi" && ev.role === "tone") this.held.add(ev.note);
  }

  release(note: number): void {
    this.held.delete(note);
  }

  cc(n: number, value: number): void {
    this.values[`cc:${n}`] = value;
    if (n === 1) this.values.modwheel = value;
    this.seenCcs.add(n);
  }

  pitchBend(value: number): void {
    this.values.pitchbend = value;
  }

  /** Every CC worth listing in a source menu, lowest first. */
  ccList(): number[] {
    return [...this.seenCcs].filter((n) => n !== 1).sort((a, b) => a - b);
  }

  get(id: string): number {
    return this.values[id] ?? 0;
  }
}

export type NumberSpec = Extract<ParamSpec, { kind: "number" }>;

/** Parameters that can be modulated: numbers that don't rebuild the model. */
export function modulatable(def: ModelDefinition): NumberSpec[] {
  return def.params.filter((p): p is NumberSpec => p.kind === "number" && !p.resetOnChange);
}

/** Macros as slider specs, so the same control code can draw them. Without a description, it lists what each one pushes. */
export function macroSpecs(macros: MacroSpec[], params: ParamSpec[]): NumberSpec[] {
  const label = (key: string) => params.find((p) => p.key === key)?.label ?? key;
  return macros.map((m) => ({
    kind: "number", key: m.key, label: m.label, min: 0, max: 1, step: 0.01, default: 0,
    description: m.description ?? m.targets
      .map((t) => ("set" in t ? `${label(t.param)} switches` : `${label(t.param)} ${t.amount >= 0 ? "up" : "down"}`))
      .join(", "),
  }));
}

/**
 * Write the values the model should see into `out`: slider values, pushed by
 * macros, pushed by modulation routes, clamped to each parameter's range.
 * Also returns the effective macro values for the UI.
 */
export function applyModulation(
  def: ModelDefinition,
  base: ParamValues,
  macroBase: Record<string, number>,
  routes: ModRoute[],
  sources: ModSources,
  out: ParamValues,
  macroOut: Record<string, number>,
  /** Global music intensity: scales every route, 0 turns modulation off. */
  depth = 1,
): void {
  for (const k in base) out[k] = base[k];

  const macros = def.macros ?? [];
  for (const m of macros) macroOut[m.key] = macroBase[m.key] ?? 0;
  const offsets: Record<string, number> = {};
  for (const r of routes) {
    const src = sources.get(r.source);
    if (src === 0 || r.off || depth === 0) continue;
    const push = r.amount * src * depth;
    if (r.target.startsWith("macro:")) {
      const key = r.target.slice(6);
      if (key in macroOut) macroOut[key] += push;
    } else {
      offsets[r.target] = (offsets[r.target] ?? 0) + push;
    }
  }
  // Dropdowns and checkboxes a macro has turned far enough to switch.
  const switched: ParamValues = {};
  for (const m of macros) {
    const v = (macroOut[m.key] = Math.min(1, Math.max(0, macroOut[m.key])));
    if (v === 0) continue;
    for (const t of m.targets) {
      if ("set" in t) {
        if (v >= t.at) switched[t.param] = t.set;
      } else {
        offsets[t.param] = (offsets[t.param] ?? 0) + t.amount * v;
      }
    }
  }
  for (const key in switched) {
    const spec = def.params.find((p) => p.key === key);
    if (spec && spec.kind !== "number" && !spec.resetOnChange) out[key] = switched[key];
  }

  for (const key in offsets) {
    const spec = def.params.find((p) => p.key === key);
    if (!spec || spec.kind !== "number" || spec.resetOnChange) continue;
    const range = spec.max - spec.min;
    let v = (base[key] as number) + offsets[key] * range;
    v = Math.min(spec.max, Math.max(spec.min, v));
    if (spec.step >= 1) v = Math.round(v);
    out[key] = v;
  }
}
