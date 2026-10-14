import { GrayScott, type StepRequest } from "./grayscott";

/**
 * Living ink's chemistry on its own thread. The main thread sends `reset` to
 * start a grid and `step` requests to advance it; each step comes back as a
 * `shade` message carrying the shaded grid (the buffer travels back and
 * forth rather than being copied).
 */

export type WorkerIn =
  | { type: "reset"; w: number; h: number; pattern: string }
  | ({ type: "step" } & StepRequest);

export type WorkerOut = { type: "shade"; shade: Uint8ClampedArray<ArrayBuffer>; steps: number };

let sim: GrayScott | null = null;
// This file is only ever a worker; the DOM lib's `self` is a Window to the type checker.
const scope = self as unknown as { postMessage(msg: WorkerOut, transfer: Transferable[]): void; onmessage: ((e: MessageEvent<WorkerIn>) => void) | null };

scope.onmessage = (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  if (msg.type === "reset") {
    sim = new GrayScott(msg.w, msg.h, msg.pattern);
    return;
  }
  if (!sim || sim.w * sim.h !== msg.shade.length) return;
  sim.run(msg);
  const out: WorkerOut = { type: "shade", shade: msg.shade, steps: sim.steps };
  scope.postMessage(out, [msg.shade.buffer]);
};
