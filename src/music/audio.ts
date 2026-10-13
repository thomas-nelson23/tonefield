import type { NoteRole } from "../models/types";
import type { AudioBands } from "./modulation";

export type Waveform = "triangle" | "sawtooth" | "square" | "sine";

/** The sound of a chord style: oscillator shape, filter brightness and attack in seconds. */
export interface ChordTone {
  wave: Waveform;
  cutoff: number;
  attack: number;
  /** Seconds for the chord to fade after it ends. */
  release?: number;
  /** Cents between each note's two detuned oscillators; 0 plays one oscillator. */
  spread?: number;
  /** Filter wobble: speed in Hz and depth as a share of the cutoff. */
  wobbleRate?: number;
  wobbleDepth?: number;
}

const SILENT: AudioBands = { level: 0, bass: 0, mid: 0, treble: 0 };
const SPECTRUM_BINS = 48;
const WAVE_POINTS = 128;

export function midiToHz(note: number): number {
  return 440 * 2 ** ((note - 69) / 12);
}

/**
 * Sound for the app: a small drum kit and synth for the sequencer and MIDI,
 * an audio-file player, and an analyser on the master bus whose band levels
 * feed the modulation layer. The AudioContext is created lazily because
 * browsers only allow it after a user gesture.
 */
export class AudioEngine {
  ctx: AudioContext | null = null;
  waveform: Waveform = "triangle";
  private master!: GainNode;
  private analyser!: AnalyserNode;
  private freq = new Uint8Array(0);
  private wave = new Float32Array(0);
  private noise!: AudioBuffer;
  private voices = new Map<number, { osc: OscillatorNode; gain: GainNode }>();
  private player: HTMLAudioElement | null = null;
  private playerSource: MediaElementAudioSourceNode | null = null;
  private smoothed: AudioBands = { ...SILENT };
  /** Log-spaced spectrum of what's playing, 0..1 per bin, refreshed by `bands`. */
  readonly spectrum = new Float32Array(SPECTRUM_BINS);
  /** A downsampled waveform snapshot, -1..1, refreshed by `bands`. */
  readonly scope = new Float32Array(WAVE_POINTS);
  private volume = 0.7;

  ensure(): AudioContext {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return this.ctx;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    // A gentle limiter so stacked notes don't clip.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 6;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.6;
    this.master.connect(comp).connect(this.analyser).connect(ctx.destination);
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.wave = new Float32Array(this.analyser.fftSize);
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return ctx;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  /** Play a drum hit or a short synth note at audio time `time`. */
  hit(role: NoteRole, note: number, velocity: number, time: number, length = 0.2): void {
    const ctx = this.ensure();
    const t = Math.max(time, ctx.currentTime);
    if (role === "kick") {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.setValueAtTime(150, t);
      osc.frequency.exponentialRampToValueAtTime(42, t + 0.18);
      gain.gain.setValueAtTime(velocity, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
      osc.connect(gain).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.42);
    } else if (role === "snare" || role === "hat") {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      const snare = role === "snare";
      filter.type = snare ? "bandpass" : "highpass";
      filter.frequency.value = snare ? 1800 : 7000;
      const len = snare ? 0.18 : 0.05;
      gain.gain.setValueAtTime(velocity * (snare ? 0.7 : 0.35), t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + len);
      src.connect(filter).connect(gain).connect(this.master);
      src.start(t, Math.random() * 0.5);
      src.stop(t + len + 0.02);
      if (snare) {
        // A short tonal body under the noise.
        const osc = ctx.createOscillator();
        const g2 = ctx.createGain();
        osc.frequency.value = 190;
        g2.gain.setValueAtTime(velocity * 0.4, t);
        g2.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        osc.connect(g2).connect(this.master);
        osc.start(t);
        osc.stop(t + 0.12);
      }
    } else {
      const { osc, gain } = this.voice(note, velocity, t);
      gain.gain.setTargetAtTime(0, t + length, 0.08);
      osc.stop(t + length + 0.6);
    }
  }

  /** A bass note: a filtered saw over a sine sub, with a plucky filter envelope. */
  bass(note: number, velocity: number, time: number, length: number): void {
    const ctx = this.ensure();
    const t = Math.max(time, ctx.currentTime);
    const hz = midiToHz(note);
    const saw = ctx.createOscillator();
    saw.type = "sawtooth";
    saw.frequency.value = hz;
    const sub = ctx.createOscillator();
    sub.frequency.value = hz;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 3;
    filter.frequency.setValueAtTime(220 + velocity * 1300, t);
    filter.frequency.exponentialRampToValueAtTime(160, t + 0.3);
    const subGain = ctx.createGain();
    subGain.gain.value = 0.9;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(velocity * 0.3, t + 0.008);
    gain.gain.setTargetAtTime(velocity * 0.22, t + 0.01, 0.2);
    gain.gain.setTargetAtTime(0, t + length, 0.04);
    saw.connect(filter).connect(gain);
    sub.connect(subGain).connect(gain);
    gain.connect(this.master);
    for (const o of [saw, sub]) {
      o.start(t);
      o.stop(t + length + 0.3);
    }
  }

  /** A chord: one slightly detuned voice per note through a shared filter. */
  chord(notes: number[], velocity: number, time: number, length: number, tone: ChordTone): void {
    const ctx = this.ensure();
    const t = Math.max(time, ctx.currentTime);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(tone.cutoff * (0.6 + 0.6 * velocity), t);
    filter.frequency.exponentialRampToValueAtTime(tone.cutoff * 0.45, t + Math.max(0.15, length));
    const gain = ctx.createGain();
    const level = (velocity * 0.32) / Math.sqrt(Math.max(1, notes.length)) / ((tone.spread ?? 0) > 0 ? Math.SQRT2 : 1);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(level, t + tone.attack);
    gain.gain.setTargetAtTime(level * 0.7, t + tone.attack, 0.25);
    const release = Math.max(0.06, tone.release ?? 0.06);
    gain.gain.setTargetAtTime(0, t + length, release / 3);
    filter.connect(gain).connect(this.master);
    const end = t + length + release * 2 + 0.3;
    if (tone.wobbleDepth && tone.wobbleRate) {
      // A slow LFO on the filter, so the chord sweeps open and closed.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = tone.wobbleRate;
      const depth = ctx.createGain();
      depth.gain.value = tone.cutoff * tone.wobbleDepth * 0.9;
      lfo.connect(depth).connect(filter.frequency);
      lfo.start(t);
      lfo.stop(end);
    }
    const spread = tone.spread ?? 0;
    for (const n of notes) {
      for (const side of spread > 0 ? [-1, 1] : [0]) {
        const osc = ctx.createOscillator();
        osc.type = tone.wave;
        osc.frequency.value = midiToHz(n);
        osc.detune.value = side * spread * 0.5 + (Math.random() - 0.5) * 10;
        osc.connect(filter);
        osc.start(t);
        osc.stop(end);
      }
    }
  }

  /** Start a held synth note (MIDI keyboard). */
  noteOn(note: number, velocity: number): void {
    const ctx = this.ensure();
    this.noteOff(note);
    this.voices.set(note, this.voice(note, velocity, ctx.currentTime));
  }

  noteOff(note: number): void {
    const v = this.voices.get(note);
    if (!v || !this.ctx) return;
    this.voices.delete(note);
    const t = this.ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setTargetAtTime(0, t, 0.08);
    v.osc.stop(t + 0.6);
  }

  /** Release every held note, e.g. when playback pauses. */
  allNotesOff(): void {
    for (const note of [...this.voices.keys()]) this.noteOff(note);
  }

  private voice(note: number, velocity: number, t: number): { osc: OscillatorNode; gain: GainNode } {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = this.waveform;
    osc.frequency.value = midiToHz(note);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(600 + velocity * 4000, t);
    filter.frequency.exponentialRampToValueAtTime(500, t + 0.5);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(velocity * 0.3, t + 0.01);
    gain.gain.setTargetAtTime(velocity * 0.18, t + 0.01, 0.15);
    osc.connect(filter).connect(gain).connect(this.master);
    osc.start(t);
    return { osc, gain };
  }

  /** Load an audio file to play through the analyser. */
  loadFile(file: File): HTMLAudioElement {
    const ctx = this.ensure();
    if (this.player) {
      this.player.pause();
      URL.revokeObjectURL(this.player.src);
    }
    const el = new Audio(URL.createObjectURL(file));
    el.loop = true;
    this.playerSource?.disconnect();
    this.playerSource = ctx.createMediaElementSource(el);
    this.playerSource.connect(this.master);
    this.player = el;
    return el;
  }

  get filePlaying(): boolean {
    return !!this.player && !this.player.paused;
  }

  /** Band levels of everything that's playing, roughly 0..1. */
  bands(): AudioBands {
    if (!this.ctx) return SILENT;
    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getFloatTimeDomainData(this.wave);
    let sum = 0;
    for (let i = 0; i < this.wave.length; i++) sum += this.wave[i] * this.wave[i];
    const binHz = this.ctx.sampleRate / this.analyser.fftSize;
    const band = (lo: number, hi: number) => {
      const a = Math.max(1, Math.floor(lo / binHz));
      const b = Math.min(this.freq.length - 1, Math.ceil(hi / binHz));
      let s = 0;
      for (let i = a; i <= b; i++) s += this.freq[i];
      return s / ((b - a + 1) * 255);
    };
    const raw: AudioBands = {
      level: Math.min(1, Math.sqrt(sum / this.wave.length) * 3),
      bass: Math.min(1, band(30, 200) * 1.3),
      mid: Math.min(1, band(200, 2000) * 1.6),
      treble: Math.min(1, band(2000, 12000) * 2.2),
    };
    // Fast attack, slower release, so levels read as pulses rather than noise.
    const s = this.smoothed;
    for (const k of ["level", "bass", "mid", "treble"] as const) {
      s[k] = raw[k] > s[k] ? raw[k] : s[k] * 0.88 + raw[k] * 0.12;
    }
    this.analyseShape(binHz);
    return s;
  }

  /** Fill `spectrum` (40 Hz..14 kHz, log-spaced) and `scope` from the analyser data just read. */
  private analyseShape(binHz: number): void {
    const n = this.spectrum.length;
    const lo = Math.log(40), hi = Math.log(14000);
    for (let i = 0; i < n; i++) {
      const a = Math.max(1, Math.floor(Math.exp(lo + ((hi - lo) * i) / n) / binHz));
      const b = Math.max(a, Math.min(this.freq.length - 1, Math.floor(Math.exp(lo + ((hi - lo) * (i + 1)) / n) / binHz)));
      let sum = 0;
      for (let k = a; k <= b; k++) sum += this.freq[k];
      // Treble bins read quieter, so they get a gentle lift.
      const v = Math.min(1, (sum / ((b - a + 1) * 255)) * (1.2 + (i / n) * 0.8));
      this.spectrum[i] = v > this.spectrum[i] ? v : this.spectrum[i] * 0.85 + v * 0.15;
    }
    const step = this.wave.length / this.scope.length;
    for (let i = 0; i < this.scope.length; i++) this.scope[i] = this.wave[Math.floor(i * step)];
  }
}

/**
 * Finds kick-like onsets in the bass band of an audio file so a song can
 * trigger the same note reactions as the sequencer.
 */
export class BeatDetector {
  private avg = 0;
  private last = 0;

  /** Returns a velocity when a beat lands, else 0. `now` is in seconds. */
  feed(bass: number, now: number): number {
    const hit = bass > 0.25 && bass > this.avg * 1.3 && now - this.last > 0.22;
    this.avg = this.avg * 0.95 + bass * 0.05;
    if (!hit) return 0;
    this.last = now;
    return Math.min(1, 0.4 + bass * 0.6);
  }
}
