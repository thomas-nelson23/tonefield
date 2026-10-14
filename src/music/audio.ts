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
  /** Filter resonance, 0..1. */
  reso?: number;
}

export type TrackKey = "drums" | "bass" | "chords" | "melody";
export type DrumKind = "kick" | "snare" | "hat";

/** A drum's sound: pitch in semitones, decay and tone 0..1 with 0.5 the stock sound. */
export interface DrumSound {
  pitch: number;
  decay: number;
  tone: number;
}

/** The bass synth. Everything but `wave` is 0..1; the defaults in the sequencer give the stock sound. */
export interface BassTone {
  wave: Waveform;
  sub: number;
  cutoff: number;
  reso: number;
  /** How far the filter opens on each note. */
  env: number;
  /** How quickly it closes again. */
  decay: number;
  glide: number;
  drive: number;
}

/** The melody synth, all 0..1 but `wave`. */
export interface MelodyTone {
  wave: Waveform;
  bright: number;
  reso: number;
  attack: number;
  release: number;
  /** A second, detuned oscillator. */
  thick: number;
  vibrato: number;
  glide: number;
}

/** The mixer: per-track gain, pan -1..1 and effect sends 0..1, per-drum gain and pan, and the master effects. */
export interface MixSettings {
  master: number;
  tracks: Record<TrackKey, { volume: number; pan: number; echo: number; space: number }>;
  drums: { volume: number; pan: number }[];
  /** Seconds between echoes. */
  echoTime: number;
  echoFeedback: number;
  /** Reverb length, 0..1. */
  spaceSize: number;
}

interface Channel {
  input: GainNode;
  pan: StereoPannerNode | GainNode;
  echo: GainNode;
  space: GainNode;
  meter: AnalyserNode;
}

const TRACK_KEYS: TrackKey[] = ["drums", "bass", "chords", "melody"];
const DRUM_KINDS: DrumKind[] = ["kick", "snare", "hat"];

const SILENT: AudioBands = { level: 0, bass: 0, mid: 0, treble: 0 };
const SPECTRUM_BINS = 48;
const WAVE_POINTS = 128;

export function midiToHz(note: number): number {
  return 440 * 2 ** ((note - 69) / 12);
}

/**
 * Sound for the app: a small drum kit and synths for the sequencer and MIDI,
 * an audio-file player, and an analyser on the master bus whose band levels
 * feed the modulation layer. Each sequencer track has a mixer channel
 * (fader, pan, a meter and sends to a shared echo and reverb), and each drum
 * has its own fader and pan inside the drum channel. The AudioContext is
 * created lazily because browsers only allow it after a user gesture.
 */
export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private channels = {} as Record<TrackKey, Channel>;
  private drumOut = {} as Record<DrumKind, { gain: GainNode; pan: StereoPannerNode | GainNode }>;
  private echoDelay!: DelayNode;
  private echoFeedback!: GainNode;
  private reverb!: ConvolverNode;
  private mixSettings: MixSettings | null = null;
  /** What `mix` last applied, so unchanged values aren't rescheduled every frame. */
  private applied = new Map<string, number>();
  private reverbBuiltAt = -1;
  private reverbSize = -1;
  /** Long enough to cover the time between meter redraws, so short peaks aren't missed. */
  private meterData = new Float32Array(2048);
  private masterPeak = 0;
  private lastHz: Partial<Record<TrackKey, number>> = {};
  private driveCurves = new Map<number, Float32Array<ArrayBuffer>>();
  private analyser!: AnalyserNode;
  private freq = new Uint8Array(0);
  private wave = new Float32Array(0);
  private noise!: AudioBuffer;
  private voices = new Map<number, { gain: GainNode; stop: (at: number) => void; release: number }>();
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
    this.buildMixer(ctx);
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.wave = new Float32Array(this.analyser.fftSize);
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return ctx;
  }

  /** The mixer channels, the per-drum faders, and the shared echo and reverb they send to. */
  private buildMixer(ctx: AudioContext): void {
    const panner = () => (ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain());
    // Echo: a delay with a darkening feedback loop.
    this.echoDelay = ctx.createDelay(3);
    this.echoFeedback = ctx.createGain();
    const echoIn = ctx.createGain();
    const echoTone = ctx.createBiquadFilter();
    echoTone.type = "lowpass";
    echoTone.frequency.value = 3500;
    echoIn.connect(this.echoDelay).connect(echoTone).connect(this.echoFeedback).connect(this.echoDelay);
    echoTone.connect(this.master);
    this.reverb = ctx.createConvolver();
    this.reverb.connect(this.master);
    for (const key of TRACK_KEYS) {
      const input = ctx.createGain();
      const pan = panner();
      const echo = ctx.createGain();
      const space = ctx.createGain();
      const meter = ctx.createAnalyser();
      meter.fftSize = this.meterData.length;
      input.connect(pan).connect(this.master);
      pan.connect(meter);
      pan.connect(echo).connect(echoIn);
      pan.connect(space).connect(this.reverb);
      echo.gain.value = space.gain.value = 0;
      this.channels[key] = { input, pan, echo, space, meter };
    }
    for (const kind of DRUM_KINDS) {
      const gain = ctx.createGain();
      const pan = panner();
      gain.connect(pan).connect(this.channels.drums.input);
      this.drumOut[kind] = { gain, pan };
    }
    this.applied.clear();
    if (this.mixSettings) this.mix(this.mixSettings);
  }

  /** Set the mixer. Cheap to call every frame: only values that changed are applied. */
  mix(m: MixSettings): void {
    this.mixSettings = m;
    const ctx = this.ctx;
    if (!ctx) return;
    const set = (id: string, param: AudioParam, v: number) => {
      if (this.applied.get(id) === v) return;
      this.applied.set(id, v);
      param.setTargetAtTime(v, ctx.currentTime, 0.02);
    };
    const setPan = (id: string, node: StereoPannerNode | GainNode, v: number) => {
      if ("pan" in node) set(id, node.pan, Math.max(-1, Math.min(1, v)));
    };
    this.volume = m.master;
    set("master", this.master.gain, m.master);
    for (const key of TRACK_KEYS) {
      const t = m.tracks[key], ch = this.channels[key];
      set(`${key}.v`, ch.input.gain, t.volume);
      setPan(`${key}.p`, ch.pan, t.pan);
      set(`${key}.e`, ch.echo.gain, t.echo);
      set(`${key}.s`, ch.space.gain, t.space * 0.8);
    }
    DRUM_KINDS.forEach((kind, i) => {
      const d = m.drums[i];
      if (!d) return;
      set(`${kind}.v`, this.drumOut[kind].gain.gain, d.volume);
      setPan(`${kind}.p`, this.drumOut[kind].pan, d.pan);
    });
    set("echo.t", this.echoDelay.delayTime, Math.min(3, m.echoTime));
    set("echo.f", this.echoFeedback.gain, Math.min(0.9, m.echoFeedback));
    // Rebuilding the reverb is the one costly change, so a dragged slider rebuilds it at most a few times a second.
    if (m.spaceSize !== this.reverbSize && ctx.currentTime - this.reverbBuiltAt > 0.15) {
      this.reverbSize = m.spaceSize;
      this.reverbBuiltAt = ctx.currentTime;
      this.reverb.buffer = this.impulse(ctx, m.spaceSize);
    }
  }

  /** A stereo burst of decaying noise as the reverb's room. */
  private impulse(ctx: AudioContext, size: number): AudioBuffer {
    const seconds = 0.5 + size * 3.5;
    const len = Math.round(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const x = i / len;
        data[i] = (Math.random() * 2 - 1) * (1 - x) ** (2 + 2 * (1 - size)) * Math.min(1, i / (ctx.sampleRate * 0.01));
      }
    }
    return buf;
  }

  /** Peak level of each track and the master since the last call, 0..1 and above when clipping. */
  peaks(): Record<TrackKey | "master", number> {
    const out = { drums: 0, bass: 0, chords: 0, melody: 0, master: this.masterPeak };
    if (!this.ctx) return out;
    for (const key of TRACK_KEYS) {
      this.channels[key].meter.getFloatTimeDomainData(this.meterData);
      let p = 0;
      for (let i = 0; i < this.meterData.length; i++) p = Math.max(p, Math.abs(this.meterData[i]));
      out[key] = p;
    }
    return out;
  }

  /** Where a sound for a track goes: its mixer channel, or the master before the mixer exists. */
  private out(track: TrackKey): AudioNode {
    return this.channels[track]?.input ?? this.master;
  }

  /** Play a drum hit at audio time `time`. */
  drum(kind: DrumKind, velocity: number, time: number, sound: DrumSound = { pitch: 0, decay: 0.5, tone: 0.5 }): void {
    const ctx = this.ensure();
    const t = Math.max(time, ctx.currentTime);
    const dest = this.drumOut[kind]?.gain ?? this.master;
    const p = 2 ** (sound.pitch / 12);
    // Decay 0.5 is the stock length; each end is a bit over twice or half as long.
    const dk = 2 ** ((sound.decay - 0.5) * 2.5);
    if (kind === "kick") {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      // Tone is punch: how high the pitch sweep starts.
      osc.frequency.setValueAtTime(150 * p * 2 ** ((sound.tone - 0.5) * 2), t);
      osc.frequency.exponentialRampToValueAtTime(42 * p, t + 0.18 * Math.min(1.5, dk));
      const len = 0.4 * dk;
      gain.gain.setValueAtTime(velocity, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + len);
      osc.connect(gain).connect(dest);
      osc.start(t);
      osc.stop(t + len + 0.02);
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    const snare = kind === "snare";
    filter.type = snare ? "bandpass" : "highpass";
    // A hat's tone is its brightness; a snare's is how much rattle it has against its body.
    filter.frequency.value = snare ? 1800 * p : Math.min(16000, 7000 * p * 2 ** ((sound.tone - 0.5) * 2));
    const len = snare ? 0.18 * dk : 0.05 * dk ** 1.6;
    const noise = snare ? 0.7 * (0.4 + 1.2 * sound.tone) : 0.35;
    gain.gain.setValueAtTime(velocity * noise, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(filter).connect(gain).connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + len + 0.02);
    if (snare) {
      // A short tonal body under the noise.
      const osc = ctx.createOscillator();
      const g2 = ctx.createGain();
      osc.frequency.value = 190 * p;
      const body = 0.1 * dk;
      g2.gain.setValueAtTime(velocity * 0.4 * (1.6 - 1.2 * sound.tone), t);
      g2.gain.exponentialRampToValueAtTime(0.001, t + body);
      osc.connect(g2).connect(dest);
      osc.start(t);
      osc.stop(t + body + 0.02);
    }
  }

  /** A bass note: a filtered oscillator over a sine sub, with a plucky filter envelope. */
  bass(note: number, velocity: number, time: number, length: number, tone: BassTone): void {
    const ctx = this.ensure();
    const t = Math.max(time, ctx.currentTime);
    const hz = midiToHz(note);
    const glide = tone.glide ** 2 * 0.3;
    const from = this.lastHz.bass;
    this.lastHz.bass = hz;
    const saw = ctx.createOscillator();
    saw.type = tone.wave;
    const sub = ctx.createOscillator();
    for (const o of [saw, sub]) {
      if (glide > 0.005 && from) {
        o.frequency.setValueAtTime(from, t);
        o.frequency.exponentialRampToValueAtTime(hz, t + glide);
      } else o.frequency.value = hz;
    }
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.7 + tone.reso * 7.7;
    const cut = 2 ** ((tone.cutoff - 0.5) * 4);
    filter.frequency.setValueAtTime(Math.min(18000, (220 + velocity * 2600 * tone.env) * cut), t);
    filter.frequency.exponentialRampToValueAtTime(160 * cut, t + 0.3 * 2 ** ((tone.decay - 0.5) * 3));
    const subGain = ctx.createGain();
    subGain.gain.value = tone.sub * 1.2;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(velocity * 0.3, t + 0.008);
    gain.gain.setTargetAtTime(velocity * 0.22, t + 0.01, 0.2);
    gain.gain.setTargetAtTime(0, t + length, 0.04);
    saw.connect(filter).connect(gain);
    sub.connect(subGain).connect(gain);
    if (tone.drive > 0.01) {
      const shaper = ctx.createWaveShaper();
      shaper.curve = this.driveCurve(tone.drive);
      const makeup = ctx.createGain();
      makeup.gain.value = 1 / (1 + tone.drive * 1.5);
      gain.connect(shaper).connect(makeup).connect(this.out("bass"));
    } else gain.connect(this.out("bass"));
    for (const o of [saw, sub]) {
      o.start(t);
      o.stop(t + length + 0.3);
    }
  }

  /** A soft-clipping curve, cached per drive amount. */
  private driveCurve(drive: number): Float32Array<ArrayBuffer> {
    const key = Math.round(drive * 50);
    let curve = this.driveCurves.get(key);
    if (!curve) {
      const k = 1 + (key / 50) * 12;
      curve = new Float32Array(1024);
      for (let i = 0; i < curve.length; i++) {
        const x = (i / (curve.length - 1)) * 2 - 1;
        curve[i] = Math.tanh(k * x) / Math.tanh(k);
      }
      this.driveCurves.set(key, curve);
    }
    return curve;
  }

  /** A melody note of `length` seconds. */
  melody(note: number, velocity: number, time: number, length: number, tone: MelodyTone): void {
    const ctx = this.ensure();
    const t = Math.max(time, ctx.currentTime);
    const v = this.voice(note, velocity, t, tone);
    const release = this.releaseTau(tone);
    v.gain.gain.setTargetAtTime(0, t + Math.max(length, this.attackTime(tone)), release);
    v.stop(t + Math.max(length, this.attackTime(tone)) + release * 7);
  }

  /** A chord: one slightly detuned voice per note through a shared filter. */
  chord(notes: number[], velocity: number, time: number, length: number, tone: ChordTone): void {
    const ctx = this.ensure();
    const t = Math.max(time, ctx.currentTime);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 1 + (tone.reso ?? 0) * 11;
    filter.frequency.setValueAtTime(tone.cutoff * (0.6 + 0.6 * velocity), t);
    filter.frequency.exponentialRampToValueAtTime(tone.cutoff * 0.45, t + Math.max(0.15, length));
    const gain = ctx.createGain();
    const level = (velocity * 0.32) / Math.sqrt(Math.max(1, notes.length)) / ((tone.spread ?? 0) > 0 ? Math.SQRT2 : 1);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(level, t + tone.attack);
    gain.gain.setTargetAtTime(level * 0.7, t + tone.attack, 0.25);
    const release = Math.max(0.06, tone.release ?? 0.06);
    gain.gain.setTargetAtTime(0, t + length, release / 3);
    filter.connect(gain).connect(this.out("chords"));
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

  /** Start a held synth note (MIDI keyboard), on the melody synth. */
  noteOn(note: number, velocity: number, tone: MelodyTone): void {
    const ctx = this.ensure();
    this.noteOff(note);
    this.voices.set(note, { ...this.voice(note, velocity, ctx.currentTime, tone), release: this.releaseTau(tone) });
  }

  noteOff(note: number): void {
    const v = this.voices.get(note);
    if (!v || !this.ctx) return;
    this.voices.delete(note);
    const t = this.ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setTargetAtTime(0, t, v.release);
    v.stop(t + v.release * 7);
  }

  /** Release every held note, e.g. when playback pauses. */
  allNotesOff(): void {
    for (const note of [...this.voices.keys()]) this.noteOff(note);
  }

  private attackTime(tone: MelodyTone): number {
    return 0.01 + tone.attack ** 2 * 1.2;
  }

  /** Time constant of a melody note's fade once it ends. */
  private releaseTau(tone: MelodyTone): number {
    return 0.08 + tone.release ** 2 * 0.9;
  }

  /** A melody synth voice, sounding from `t` until it's stopped. */
  private voice(note: number, velocity: number, t: number, tone: MelodyTone): { gain: GainNode; stop: (at: number) => void } {
    const ctx = this.ctx!;
    const hz = midiToHz(note);
    const glide = tone.glide ** 2 * 0.25;
    const from = this.lastHz.melody;
    this.lastHz.melody = hz;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 1 + tone.reso * 11;
    const bright = 2 ** ((tone.bright - 0.5) * 3);
    filter.frequency.setValueAtTime(Math.min(18000, (600 + velocity * 4000) * bright), t);
    filter.frequency.exponentialRampToValueAtTime(500 * bright, t + 0.5);
    const gain = ctx.createGain();
    const attack = this.attackTime(tone);
    const level = velocity * 0.3 / (tone.thick > 0.01 ? Math.SQRT2 : 1);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(level, t + attack);
    gain.gain.setTargetAtTime(level * 0.6, t + attack, 0.15);
    filter.connect(gain).connect(this.out("melody"));
    const oscs: OscillatorNode[] = [];
    for (const side of tone.thick > 0.01 ? [-1, 1] : [0]) {
      const osc = ctx.createOscillator();
      osc.type = tone.wave;
      if (glide > 0.005 && from) {
        osc.frequency.setValueAtTime(from, t);
        osc.frequency.exponentialRampToValueAtTime(hz, t + glide);
      } else osc.frequency.value = hz;
      osc.detune.value = side * tone.thick * 18;
      osc.connect(filter);
      osc.start(t);
      oscs.push(osc);
    }
    if (tone.vibrato > 0.01) {
      // Vibrato that eases in, as a singer's would.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 5.5;
      const depth = ctx.createGain();
      depth.gain.setValueAtTime(0, t);
      depth.gain.linearRampToValueAtTime(tone.vibrato * 45, t + 0.25);
      lfo.connect(depth);
      for (const o of oscs) depth.connect(o.detune);
      lfo.start(t);
      oscs.push(lfo);
    }
    return { gain, stop: (at) => oscs.forEach((o) => o.stop(at)) };
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
    let sum = 0, peak = 0;
    for (let i = 0; i < this.wave.length; i++) {
      sum += this.wave[i] * this.wave[i];
      peak = Math.max(peak, Math.abs(this.wave[i]));
    }
    this.masterPeak = peak;
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
