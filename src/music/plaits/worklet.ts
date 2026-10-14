// The Plaits voices on the audio thread: one processor with an output each
// for bass, chords and melody, fed notes and patches by message.

import { Synth } from "./dsp";
import type { SynthMessage } from "./patch";

declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

class PlaitsProcessor extends AudioWorkletProcessor {
  private synth = new Synth(sampleRate);
  private outs: Float32Array[] = [];

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<SynthMessage[]>) => {
      for (const msg of e.data) this.synth.post(msg);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const outs = this.outs;
    for (let i = 0; i < outputs.length; i++) outs[i] = outputs[i][0];
    this.synth.render(outs, currentFrame, outs[0].length);
    return true;
  }
}

registerProcessor("plaits", PlaitsProcessor);
