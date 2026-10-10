import { SILENT_MUSIC, type ModRoute, type ModelDefinition, type MusicFrame, type NoteEvent, type ParamSpec, type ParamValues, type ReactionSource } from "../models/types";
import { noteHue } from "../models/lib/music";
import { renderParamControls, type ParamControls } from "../ui/controls";
import { AudioEngine, BeatDetector, type Waveform } from "./audio";
import { dispatchMidi, openMidi, type MidiInputs } from "./midi";
import { applyModulation, macroSpecs, modulatable, ModSources, SOURCES, sourceLabel, type NumberSpec } from "./modulation";
import { GLOBAL_SPECS, applyGlobals, canvasFilter, defaultGlobals, sanitizeGlobals } from "./globals";
import {
  BASS_STYLES, CHORD_SPEED_LABELS, CHORD_STYLES, DRUM_RESETS, DRUMS, MAX_DRUM_LENGTH, MELODY_STYLES, ROOTS, SCALES, STEPS, STYLES,
  Sequencer, applyStyleDensities, chordName, sanitizeState, type DrumKey, type SequencerState,
} from "./sequencer";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface GlobalSettings {
  seq: SequencerState;
  volume: number;
  thru: boolean;
  decay: number;
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
}

/**
 * Bump when models' default routes change enough that saved per-model
 * settings should be replaced by the new defaults.
 */
const MODEL_SETTINGS_VERSION = 5;

interface ModelSettings {
  v: number;
  macros: Record<string, number>;
  routes: ModRoute[];
  /** Built-in reactions switched off for this model. */
  muted: ReactionSource[];
}

/** The global controls a route can push. */
const GLOBAL_NUMBERS = GLOBAL_SPECS.filter((p): p is NumberSpec => p.kind === "number");

const pct = (v: number) => `${Math.round(v * 100)}%`;
const choices = (rec: Record<string, { label: string }>) => Object.entries(rec).map(([value, o]) => ({ value, label: o.label }));
const BASS_RANGE_LABELS = ["Root only", "+ octave", "+ fifth", "+ third", "+ low fifth", "+ seventh", "+ passing"];
/** Drum ring radii as a share of the canvas radius, kick innermost. */
const RING_RADII = [0.4, 0.68, 0.94];

/** The running sequencer, so drum readouts can show hits for the pattern's current length. */
let liveSeq: Sequencer | null = null;

function drumSpecs(key: DrumKey): ParamSpec[] {
  return [
    { kind: "number", key: `${key}Density`, label: "Density", min: 0, max: 1, step: 0.01, default: 0.3,
      format: () => {
        const n = liveSeq?.pulses(key) ?? 0;
        return `${n} hit${n === 1 ? "" : "s"}`;
      },
      description: "How many hits the ring spreads evenly round its pattern." },
    { kind: "number", key: `${key}Variation`, label: "Variation", min: 0, max: 1, step: 0.01, default: 0.3, format: pct,
      description: "How much each bar strays: ghost notes, dropped hits and nudges." },
    { kind: "number", key: `${key}Length`, label: "Steps", min: 1, max: MAX_DRUM_LENGTH, step: 1, default: 16, format: (v) => `${v}`,
      description: "How many sixteenths the pattern has before it repeats. Anything but 16 drifts against the bar." },
    { kind: "number", key: `${key}Rotate`, label: "Offset", min: 0, max: MAX_DRUM_LENGTH - 1, step: 1, default: 0,
      format: (v) => `${liveSeq ? v % liveSeq.length(key) : v}`,
      description: "Turns the pattern round its ring, so it starts on a different step." },
    { kind: "choice", key: `${key}Reset`, label: "Reset", options: DRUM_RESETS, default: "0",
      description: "Brings the pattern back to its start every so many bars." },
  ];
}

/**
 * The sequencer's controls, by part. They're drawn as sliders and dropdowns,
 * and can be mapped to a MIDI knob (as `gen#<key>`).
 */
const PARTS: { part: string; specs: ParamSpec[] }[] = [
  { part: "Global", specs: [
    { kind: "number", key: "tempo", label: "Tempo", min: 40, max: 240, step: 1, default: 112, format: (v) => `${v} BPM` },
    { kind: "number", key: "swing", label: "Swing", min: 0, max: 0.8, step: 0.05, default: 0, format: pct,
      description: "Delays every second sixteenth for a shuffled feel." },
  ] },
  ...DRUMS.map((d) => ({ part: d.label, specs: drumSpecs(d.key) })),
  { part: "Bass", specs: [
    { kind: "choice", key: "bassStyle", label: "Style", options: choices(BASS_STYLES), default: "pulse" },
    { kind: "number", key: "bassDensity", label: "Density", min: 0, max: 1, step: 0.01, default: 0.4, format: pct,
      description: "How many notes the bass plays." },
    { kind: "number", key: "bassRange", label: "Range", min: 1, max: 7, step: 1, default: 3, format: (v) => BASS_RANGE_LABELS[v - 1] ?? String(v),
      description: "Which notes it may leave the root for: octave, fifth, chord tones, then passing notes." },
    { kind: "number", key: "bassVariation", label: "Variation", min: 0, max: 1, step: 0.01, default: 0.3, format: pct,
      description: "How much the bass line changes from bar to bar." },
  ] },
  { part: "Chords", specs: [
    { kind: "choice", key: "chordStyle", label: "Style", options: choices(CHORD_STYLES), default: "pop" },
    { kind: "number", key: "chordSpeed", label: "Change every", min: 0, max: CHORD_SPEED_LABELS.length - 1, step: 1, default: 2,
      format: (v) => CHORD_SPEED_LABELS[v] ?? String(v), description: "How long each chord lasts." },
    { kind: "number", key: "chordVariation", label: "Variation", min: 0, max: 1, step: 0.01, default: 0.3, format: pct,
      description: "How often the progression switches and chords are swapped for substitutes typical of the style." },
    { kind: "number", key: "chordDensity", label: "Rhythm density", min: 0, max: 1, step: 0.01, default: 0.3, format: pct,
      description: "Low holds each chord; high plays it in a busy rhythm." },
    { kind: "number", key: "chordRhythm", label: "Rhythm variation", min: 0, max: 1, step: 0.01, default: 0.25, format: pct,
      description: "How much the chord rhythm changes from bar to bar." },
  ] },
  { part: "Melody", specs: [
    { kind: "choice", key: "melodyStyle", label: "Style", options: choices(MELODY_STYLES), default: "wander" },
    { kind: "number", key: "melodyRange", label: "Range", min: 2, max: 16, step: 1, default: 8, format: (v) => `${v} notes`,
      description: "How many scale notes the melody moves across." },
    { kind: "number", key: "melodyDensity", label: "Density", min: 0, max: 1, step: 0.01, default: 0.4, format: pct,
      description: "How many melody notes play." },
    { kind: "number", key: "melodyGroove", label: "Groove", min: 0, max: 1, step: 0.01, default: 0.3, format: pct,
      description: "Adds rhythm: syncopated, clipped notes, and the second half-bar answers the first." },
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
  private modelSettings: ModelSettings = { v: MODEL_SETTINGS_VERSION, macros: {}, routes: [], muted: [] };
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
  private seqControls: ParamControls[] = [];
  private ringCtx: CanvasRenderingContext2D | null = null;
  private melodyCtx: CanvasRenderingContext2D | null = null;
  /** What the melody view and chord chips last drew, to skip redundant redraws. */
  private melodyDrawn = "";
  private chipsDrawn = "";
  private leds: { el: HTMLElement; level: () => number }[] = [];
  private meterBars: Record<string, HTMLElement> = {};
  /** Live source bars in the matrix, refreshed while the Modulation tab is open. */
  private sourceMeters: { bar: HTMLElement; source: () => string }[] = [];
  /** Music that was playing when the simulation was paused, to resume with it. */
  private pausedMusic: { seq: boolean; file: boolean } | null = null;
  private player: HTMLAudioElement | null = null;
  /** The music feed handed to the model each frame; reused to avoid garbage. */
  private feed: MusicFrame = { ...SILENT_MUSIC, spectrum: new Float32Array(SILENT_MUSIC.spectrum.length), wave: new Float32Array(SILENT_MUSIC.wave.length) };
  private beatsNow = 0;
  private lastTone = { hue: 210, pitch: 0.5 };
  private chordHue = 210;

  constructor() {
    const saved = load<Partial<GlobalSettings>>("music:global") ?? {};
    const seq = sanitizeState(saved.seq);
    this.settings = {
      volume: 0.7, thru: true, decay: 0.25, inputs: [], bindings: {}, dockHidden: false, musicOn: true, intensity: 1,
      ...saved,
      seq,
      globals: sanitizeGlobals(saved.globals),
    };
    this.seq = liveSeq = new Sequencer(this.audio, seq);
    this.audio.setVolume(this.settings.volume);
    this.sources.decay = this.settings.decay;
    this.buildDock();
    void this.initMidi();
  }

  private saveGlobal(): void {
    save("music:global", this.settings);
  }

  // ---- Per-model state ---------------------------------------------------

  /** Called when the host loads a model. `base` is the slider-bound values object. */
  setModel(def: ModelDefinition, base: ParamValues, controls: ParamControls, onBaseChanged: (spec: ParamSpec) => void): void {
    this.def = def;
    this.base = base;
    this.paramControls = controls;
    this.onBaseChanged = onBaseChanged;
    const saved = load<ModelSettings>(`music:model:${def.id}`);
    // Settings saved before the current defaults existed are replaced, so new default routes show up.
    this.modelSettings = saved && saved.v === MODEL_SETTINGS_VERSION ? { ...saved, muted: saved.muted ?? [] } : this.defaultModelSettings(def);
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
    return { v: MODEL_SETTINGS_VERSION, macros, routes: (def.modulations ?? []).map((r) => ({ ...r })), muted: [] };
  }

  private saveModel(): void {
    if (this.def) save(`music:model:${this.def.id}`, this.modelSettings);
  }

  private renderMacros(): void {
    const macros = this.def?.macros ?? [];
    $("macros-model").textContent = this.def ? `only in ${this.def.name}` : "";
    this.macroControls = renderParamControls($("macros"), macroSpecs(macros, this.def?.params ?? []), this.modelSettings.macros, () => this.saveModel(), "macro:");
    if (macros.length === 0) $("macros").append(el("p", { className: "muted", textContent: "This model has no macros." }));
  }

  /** Everything a route can push: macros first, then number parameters, then the global controls. */
  private targets(): { id: string; label: string }[] {
    if (!this.def) return [];
    return [
      ...(this.def.macros ?? []).map((m) => ({ id: `macro:${m.key}`, label: `Macro: ${m.label}` })),
      ...modulatable(this.def).map((p) => ({ id: p.key, label: p.label })),
      ...GLOBAL_NUMBERS.map((p) => ({ id: `global:${p.key}`, label: `Global: ${p.label}` })),
    ];
  }

  /** The global controls this frame, after modulation. */
  globals(): ParamValues {
    return this.globalOut;
  }

  /** The CSS filter the global colour controls put over the canvas. */
  canvasFilter(): string {
    return canvasFilter(this.globalOut, this.beatsNow);
  }

  // ---- Per-frame ---------------------------------------------------------

  /** Advance sources and collect the notes that should reach the model this frame. */
  frame(nowSeconds: number, dt: number): NoteEvent[] {
    const bands = this.audio.bands();
    if (this.audio.filePlaying && ($("audio-beats") as HTMLInputElement).checked) {
      const v = this.beats.feed(bands.bass, nowSeconds);
      if (v > 0) this.pending.push({ note: 36, velocity: v, role: "kick", x: 0.5, source: "audio" });
    }
    const events = [...this.seq.drain(), ...this.pending];
    this.pending = [];
    for (const ev of events) {
      this.sources.trigger(ev);
      if (ev.role === "tone") this.lastTone = { hue: noteHue(ev.note), pitch: ev.x };
      if (ev.role === "chord") this.chordHue = noteHue(this.seq.key + this.seq.chord.root);
    }
    this.beatsNow = this.seq.beats(nowSeconds);
    this.sources.update(dt, this.beatsNow, bands);
    this.drawSequencer();
    this.updateMeters();
    return events;
  }

  /** Whether the model's own reaction to this kind of note is switched on. */
  reacts(role: ReactionSource): boolean {
    return this.settings.musicOn && !this.modelSettings.muted.includes(role);
  }

  /**
   * The continuous music feed for the model this frame: envelopes, bands,
   * spectrum and beat, scaled by Intensity, with switched-off reactions zeroed.
   */
  music(): MusicFrame {
    const f = this.feed;
    const depth = this.settings.musicOn ? this.settings.intensity : 0;
    const muted = this.modelSettings.muted;
    const val = (r: ReactionSource, v: number) => (muted.includes(r) ? 0 : v * depth);
    const src = this.sources;
    f.kick = val("kick", src.get("kick"));
    f.snare = val("snare", src.get("snare"));
    f.hat = val("hat", src.get("hat"));
    f.tone = val("tone", src.get("tone"));
    f.bassline = val("bassline", src.get("bassline"));
    f.chord = val("chord", src.get("chord"));
    f.level = val("level", src.get("level"));
    f.bass = val("bass", src.get("bass"));
    f.mid = val("mid", src.get("mid"));
    f.treble = val("treble", src.get("treble"));
    const shape = muted.includes("spectrum") ? 0 : depth;
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
    applyModulation(this.def, this.base, this.modelSettings.macros, this.modelSettings.routes, this.sources, out, this.macroOut, depth);
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
    applyGlobals(this.def, g, out);
    this.paramControls?.showModulation(out);
    this.macroControls?.showModulation(this.macroOut);
    this.globalControls?.showModulation(g);
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
          else this.audio.hit(ev.role, ev.note, ev.velocity, 0);
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
      this.saveGlobal();
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
    const tabs = document.querySelectorAll<HTMLButtonElement>("#dock-tabs [data-tab]");
    for (const t of tabs) {
      t.addEventListener("click", () => {
        tabs.forEach((b) => b.classList.toggle("active", b === t));
        document.querySelectorAll<HTMLElement>("#dock-body .tab").forEach((p) => (p.hidden = p.dataset.tab !== t.dataset.tab));
        if ($("dock").classList.contains("collapsed")) this.setDockHidden(false);
      });
    }
    $("dock-toggle").addEventListener("click", () => this.setDockHidden(!$("dock").classList.contains("collapsed")));
    this.setDockHidden(s.dockHidden);

    $<HTMLButtonElement>("seq-play").addEventListener("click", () => this.toggleSequencer());
    this.buildSequencer();

    // Global controls and macros
    this.renderGlobals();
    $("global-reset").addEventListener("click", () => {
      this.settings.globals = defaultGlobals();
      this.saveGlobal();
      this.renderGlobals();
    });
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
    $("mod-defaults").addEventListener("click", () => {
      if (!this.def) return;
      this.modelSettings = this.defaultModelSettings(this.def);
      this.saveModel();
      this.renderMacros();
      this.renderRoutes();
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
    const enabled = $<HTMLInputElement>("mod-enabled");
    enabled.checked = s.musicOn;
    enabled.addEventListener("change", () => {
      s.musicOn = enabled.checked;
      document.querySelector(".mod-layout")?.classList.toggle("bypassed", !s.musicOn);
      this.saveGlobal();
    });
    document.querySelector(".mod-layout")?.classList.toggle("bypassed", !s.musicOn);

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
    for (const k of ["level", "bass", "mid", "treble"]) {
      const bar = el("div", { className: "meter-fill" });
      meters.append(el("div", { className: "meter" }, el("span", { textContent: sourceLabel(k) }), el("div", { className: "meter-track" }, bar)));
      this.meterBars[k] = bar;
    }
  }

  private renderGlobals(): void {
    const box = $("global-controls");
    this.globalControls = renderParamControls(box, GLOBAL_SPECS, this.settings.globals, () => this.saveGlobal(), "glob:");
    // The panel is short, so descriptions show as tooltips here instead of under each control.
    for (const row of box.querySelectorAll<HTMLElement>(".param[data-target]")) {
      row.title = GLOBAL_SPECS.find((p) => `glob:${p.key}` === row.dataset.target)?.description ?? "";
    }
    this.showRouteBadges();
  }

  private setDockHidden(hidden: boolean): void {
    $("dock").classList.toggle("collapsed", hidden);
    $("dock-toggle").textContent = hidden ? "Show music" : "Hide music";
    $("dock-toggle").title = hidden ? "Show the music panel" : "Hide the music panel";
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

  /** Build the Global, Drums, Bass, Chords and Melody sections. */
  private buildSequencer(): void {
    const s = this.settings;
    const seq = s.seq;
    const values = seq as unknown as ParamValues;
    const changed = (spec: ParamSpec) => {
      if (spec.key === "chordStyle") this.seq.refreshHarmony();
      // Steps and density change each other's readouts (hits, offset within the length).
      if (/^(kick|snare|hat)(Length|Density|Rotate)$/.test(spec.key)) this.refreshSeqControls();
      this.seq.version++;
      this.saveGlobal();
    };
    const render = (box: HTMLElement, specs: ParamSpec[]) => {
      const c = renderParamControls(box, specs, values, changed, "gen:");
      this.seqControls.push(c);
      // The panel is short, so descriptions show as tooltips instead of under each control.
      for (const row of box.querySelectorAll<HTMLElement>(".param[data-target]")) {
        row.title = specs.find((p) => `gen:${p.key}` === row.dataset.target)?.description ?? "";
      }
    };
    const specsOf = (part: string) => PARTS.find((p) => p.part === part)!.specs;

    // Global
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
    const wave = $<HTMLSelectElement>("seq-wave");
    wave.addEventListener("change", () => { this.audio.waveform = wave.value as Waveform; wave.blur(); });
    render($("global-sliders"), specsOf("Global"));
    const volume = $<HTMLInputElement>("seq-volume");
    volume.value = String(s.volume);
    volume.addEventListener("input", () => { s.volume = Number(volume.value); this.audio.setVolume(s.volume); this.saveGlobal(); });
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
    // Hold: the global one freezes every part; each part's own freezes just that part.
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

    // Parts on and off, with a light that flashes as each one plays.
    const parts: [string, "drumsOn" | "bassOn" | "chordsOn" | "melodyOn", () => number][] = [
      ["drums", "drumsOn", () => Math.max(this.sources.get("kick"), this.sources.get("snare"), this.sources.get("hat"))],
      ["bass", "bassOn", () => this.sources.get("bassline")],
      ["chords", "chordsOn", () => this.sources.get("chord")],
      ["melody", "melodyOn", () => this.sources.get("tone")],
    ];
    for (const [id, key, level] of parts) {
      const holdKey = `${id}Hold` as "drumsHold" | "bassHold" | "chordsHold" | "melodyHold";
      const partHold = $<HTMLButtonElement>(`hold-${id}`);
      holds.push([partHold, holdKey]);
      partHold.addEventListener("click", () => {
        seq[holdKey] = !seq[holdKey];
        showHolds();
        this.saveGlobal();
        partHold.blur();
      });
      const box = $<HTMLInputElement>(`part-${id}`);
      const section = box.closest(".seq-part")!;
      box.checked = seq[key];
      section.classList.toggle("off", !seq[key]);
      box.addEventListener("change", () => {
        seq[key] = box.checked;
        section.classList.toggle("off", !box.checked);
        this.seq.version++;
        this.saveGlobal();
      });
      this.leds.push({ el: $(`led-${id}`), level });
    }
    showHolds();

    // Drums: one row per track beside the rings.
    const tracks = $("drum-tracks");
    for (const d of DRUMS) {
      const sliders = el("div", { className: "drum-sliders" });
      const name = el("div", { className: "drum-name", textContent: d.label });
      name.style.color = d.colour;
      tracks.append(el("div", { className: "drum-track" }, name, sliders));
      render(sliders, specsOf(d.label));
    }
    this.buildRing();

    render($("bass-controls"), specsOf("Bass"));
    render($("chord-controls"), specsOf("Chords"));
    render($("melody-controls"), specsOf("Melody"));
    this.melodyCtx = $<HTMLCanvasElement>("melody-view").getContext("2d");
  }

  private refreshSeqControls(): void {
    for (const c of this.seqControls) c.refresh();
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
    this.refreshSeqControls();
    this.saveGlobal();
  }

  private ringSize = 176;

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

  /** Redraw the sequencer's views while its tab is open. */
  private drawSequencer(): void {
    const canvas = this.ringCtx?.canvas;
    if (!canvas || canvas.offsetParent === null || $("dock").classList.contains("collapsed")) return;
    for (const l of this.leds) l.el.style.opacity = String(0.15 + 0.85 * Math.min(1, l.level()));
    this.drawRing();
    this.drawMelody();
    this.drawChords();
  }

  private drawRing(): void {
    const g = this.ringCtx!;
    const size = this.ringSize, c = size / 2, R = size / 2 - 8;
    const seq = this.settings.seq;
    g.clearRect(0, 0, size, size);
    const playing = this.seq.playing && this.seq.current >= 0;
    // Each ring has its own number of steps, starting at the top.
    g.strokeStyle = "#30363d";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(c, c - R * 0.2);
    g.lineTo(c, c - R - 6);
    g.stroke();
    DRUMS.forEach((d, i) => {
      const r = RING_RADII[i] * R;
      const len = this.seq.length(d.key);
      const angle = (pos: number) => -Math.PI / 2 + (pos / len) * Math.PI * 2;
      const on = seq.drumsOn;
      g.globalAlpha = on ? 1 : 0.35;
      g.strokeStyle = "#30363d";
      g.lineWidth = 1;
      g.beginPath();
      g.arc(c, c, r, 0, Math.PI * 2);
      g.stroke();
      const cur = playing ? this.seq.drumCurrent[i] : -1;
      if (cur >= 0) {
        // This ring's playhead: a short sweep across the ring.
        const a = angle(cur);
        g.strokeStyle = "rgba(230, 237, 243, 0.4)";
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
          g.fillStyle = "#30363d";
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
          g.fillStyle = hit.kind === "fill" ? "#d2a8ff" : d.colour;
          if (!now) g.globalAlpha *= 0.55 + 0.45 * hit.velocity;
          g.beginPath();
          g.arc(x, y, rad, 0, Math.PI * 2);
          g.fill();
        }
      }
    });
    g.globalAlpha = 1;
    if (this.seq.fillPending) {
      g.fillStyle = "#d2a8ff";
      g.font = "11px system-ui, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("fill", c, c);
    }
  }

  /** The melody of the bar as a line of glowing notes, high notes higher. */
  private drawMelody(): void {
    const g = this.melodyCtx;
    if (!g) return;
    const canvas = g.canvas;
    const seq = this.settings.seq;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const key = [this.seq.version, this.seq.current, this.seq.chordIndex, seq.melodyDensity, seq.melodyRange, seq.melodyGroove, seq.melodyStyle, seq.melodyOn, seq.scale, seq.root, w, h, dpr].join("|");
    if (key === this.melodyDrawn) return;
    this.melodyDrawn = key;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const col = w / STEPS, pad = 5;
    const y = (x: number) => pad + (1 - x) * (h - pad * 2);
    if (this.seq.playing && this.seq.current >= 0) {
      g.fillStyle = "rgba(230, 237, 243, 0.08)";
      g.fillRect(this.seq.current * col, 0, col, h);
    }
    const notes = this.seq.melodyBar();
    g.strokeStyle = "rgba(88, 166, 255, 0.35)";
    g.lineWidth = 1.5;
    g.beginPath();
    notes.forEach((n, i) => {
      const x = (n.step + 0.5) * col;
      if (i === 0) g.moveTo(x, y(n.x));
      else g.lineTo(x, y(n.x));
    });
    g.stroke();
    for (const n of notes) {
      const x = (n.step + 0.5) * col;
      g.fillStyle = "rgba(88, 166, 255, 0.18)";
      g.fillRect(x, y(n.x) - 1.5, Math.max(0, (n.length - 0.5) * col), 3);
      g.fillStyle = n.step === this.seq.current ? "#a5d6ff" : "#58a6ff";
      g.beginPath();
      g.arc(x, y(n.x), 2 + 2.5 * n.velocity, 0, Math.PI * 2);
      g.fill();
    }
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
    for (const k in this.meterBars) this.meterBars[k].style.width = `${this.sources.get(k) * 100}%`;
    for (const m of this.sourceMeters) {
      if (!m.bar.isConnected || m.bar.offsetParent === null) continue;
      m.bar.style.width = `${Math.min(1, Math.abs(this.sources.get(m.source()))) * 100}%`;
    }
  }

  /** Draw the modulation matrix: the model's built-in reactions, then its routes. */
  private renderRoutes(): void {
    this.sourceMeters = [];
    this.renderReactions();
    const box = $("mod-routes");
    box.replaceChildren();
    const targets = this.targets();
    if (this.modelSettings.routes.length === 0) {
      box.append(el("p", { className: "muted", textContent: "No routes. Add one to let a sound or controller push a slider." }));
    }
    this.modelSettings.routes.forEach((route, i) => {
      const on = el("input", { type: "checkbox", checked: !route.off, title: "Switch this route on or off" });
      const source = el("select");
      const groups = new Map<string, HTMLOptGroupElement>();
      for (const s of SOURCES) {
        let g = groups.get(s.group);
        if (!g) {
          g = el("optgroup", { label: s.group });
          groups.set(s.group, g);
          source.append(g);
        }
        g.append(el("option", { value: s.id, textContent: s.label }));
      }
      const ccGroup = groups.get("MIDI")!;
      for (const n of this.sources.ccList()) ccGroup.append(el("option", { value: `cc:${n}`, textContent: `CC ${n}` }));
      if (![...source.options].some((o) => o.value === route.source)) {
        ccGroup.append(el("option", { value: route.source, textContent: sourceLabel(route.source) }));
      }
      source.value = route.source;
      source.addEventListener("change", () => { route.source = source.value; this.routesChanged(); source.blur(); });

      const meterFill = el("div", { className: "meter-fill" });
      this.sourceMeters.push({ bar: meterFill, source: () => route.source });
      const meter = el("div", { className: "meter-track", title: "What this sound is doing right now" }, meterFill);

      const target = el("select");
      for (const t of targets) target.append(el("option", { value: t.id, textContent: t.label }));
      target.value = route.target;
      target.addEventListener("change", () => { route.target = target.value; this.routesChanged(); target.blur(); });

      const amount = el("input", { type: "range", min: "-1", max: "1", step: "0.05", value: String(route.amount), title: "How far it pushes, as a share of the slider's range. Double-click to zero." });
      const readout = el("span", { className: "readout", textContent: formatAmount(route.amount) });
      const setAmount = (v: number) => {
        route.amount = v;
        readout.textContent = formatAmount(v);
        this.routesChanged();
      };
      amount.addEventListener("input", () => setAmount(Number(amount.value)));
      amount.addEventListener("dblclick", () => { amount.value = "0"; setAmount(0); });
      const remove = el("button", { type: "button", textContent: "×", className: "small", title: "Remove route" });
      remove.addEventListener("click", () => {
        this.modelSettings.routes.splice(i, 1);
        this.routesChanged();
        this.renderRoutes();
      });
      const row = el("div", { className: `route${route.off ? " off" : ""}` }, on, source, meter, el("span", { className: "muted", textContent: "→" }), target, amount, readout, remove);
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

  /** List the model's built-in reactions, each with a switch and a live meter. */
  private renderReactions(): void {
    const box = $("mod-reactions");
    box.replaceChildren();
    const reactions = this.def?.reactions ?? [];
    if (reactions.length === 0) {
      box.append(el("p", { className: "muted", textContent: "This model doesn't react to music by itself; routes are how music reaches it." }));
      return;
    }
    for (const r of reactions) {
      const input = el("input", { type: "checkbox", checked: !this.modelSettings.muted.includes(r.source) });
      input.addEventListener("change", () => {
        const muted = new Set(this.modelSettings.muted);
        if (input.checked) muted.delete(r.source);
        else muted.add(r.source);
        this.modelSettings.muted = [...muted];
        this.saveModel();
      });
      const fill = el("div", { className: "meter-fill" });
      this.sourceMeters.push({ bar: fill, source: () => REACTION_METERS[r.source] });
      box.append(el("label", { className: "reaction" }, input, el("span", { className: "reaction-role", textContent: REACTION_LABELS[r.source] }), el("div", { className: "meter-track" }, fill), el("span", { className: "muted", textContent: r.text })));
    }
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
function knobValue(spec: ParamSpec, v: number): number | boolean | string {
  if (spec.kind === "number") {
    const raw = spec.min + v * (spec.max - spec.min);
    return Math.min(spec.max, Math.max(spec.min, Math.round(raw / spec.step) * spec.step));
  }
  if (spec.kind === "boolean") return v >= 0.5;
  return spec.options[Math.min(spec.options.length - 1, Math.floor(v * spec.options.length))].value;
}

function formatAmount(v: number): string {
  return `${v > 0 ? "+" : ""}${Math.round(v * 100)}%`;
}
