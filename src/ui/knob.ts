import type { ParamSpec, ParamValues } from "../models/types";

type NumberSpec = Extract<ParamSpec, { kind: "number" }>;

/** A knob or fader: its element and a way to re-read its value (after MIDI or a reset). */
export interface Dial {
  el: HTMLElement;
  refresh(): void;
}

const SVG = "http://www.w3.org/2000/svg";
/** Knobs sweep 270°, from bottom-left round to bottom-right. */
const SWEEP = 1.5 * Math.PI;
const START = 0.75 * Math.PI;

function arc(r: number, a0: number, a1: number): string {
  const x0 = r + Math.cos(a0) * (r - 3), y0 = r + Math.sin(a0) * (r - 3);
  const x1 = r + Math.cos(a1) * (r - 3), y1 = r + Math.sin(a1) * (r - 3);
  const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
  const sweep = a1 >= a0 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r - 3} ${r - 3} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/**
 * Shared drag handling: drag up or down to change the value (Shift for fine
 * control), scroll to nudge it, double-click to put it back to its default.
 * `pixels` is how far a drag goes for the whole range.
 */
function draggable(
  target: HTMLElement, spec: NumberSpec, values: ParamValues, onChange: (spec: ParamSpec) => void, show: () => void, pixels: number,
): void {
  const set = (v: number) => {
    const snapped = Math.min(spec.max, Math.max(spec.min, Math.round(v / spec.step) * spec.step));
    if (snapped === values[spec.key]) return;
    values[spec.key] = Number(snapped.toFixed(6));
    show();
    onChange(spec);
  };
  let drag: { y: number; v: number } | null = null;
  // A mouse reports hundreds of moves a second; the value is applied once a
  // frame, from the last one, since every application redraws the control.
  let pending: number | null = null;
  let frame = 0;
  const apply = () => {
    frame = 0;
    if (pending !== null) set(pending);
    pending = null;
  };
  target.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || document.body.classList.contains("learning")) return;
    drag = { y: e.clientY, v: values[spec.key] as number };
    target.setPointerCapture(e.pointerId);
    target.classList.add("dragging");
    e.preventDefault();
  });
  target.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const range = spec.max - spec.min;
    pending = drag.v + ((drag.y - e.clientY) / (e.shiftKey ? pixels * 5 : pixels)) * range;
    if (!frame) frame = requestAnimationFrame(apply);
  });
  const end = () => {
    if (frame) cancelAnimationFrame(frame);
    apply();
    drag = null;
    target.classList.remove("dragging");
  };
  target.addEventListener("pointerup", end);
  target.addEventListener("pointercancel", end);
  target.addEventListener("dblclick", () => set(spec.default));
  target.addEventListener("wheel", (e) => {
    e.preventDefault();
    const nudge = Math.max(spec.step, (spec.max - spec.min) / 50);
    set((values[spec.key] as number) + (e.deltaY < 0 ? nudge : -nudge));
  }, { passive: false });
}

function describe(spec: NumberSpec, v: number): string {
  const value = spec.format ? spec.format(v) : String(v);
  return `${spec.label}: ${value}${spec.description ? `\n${spec.description}` : ""}\nDrag up or down, Shift for fine, double-click to reset.`;
}

/**
 * A small knob in the style of a mixer strip. Bipolar knobs (a range that
 * crosses zero, like pan) light up from the centre. The label shows the value
 * while it's being turned. The row carries `data-target` for MIDI learn.
 */
export function knob(spec: NumberSpec, values: ParamValues, onChange: (spec: ParamSpec) => void, targetPrefix: string, label: string): Dial {
  const size = 26, r = size / 2;
  const row = document.createElement("div");
  row.className = "param knob";
  row.dataset.target = targetPrefix + spec.key;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  const track = document.createElementNS(SVG, "path");
  track.setAttribute("class", "knob-track");
  track.setAttribute("d", arc(r, START, START + SWEEP));
  const value = document.createElementNS(SVG, "path");
  value.setAttribute("class", "knob-value");
  const cap = document.createElementNS(SVG, "circle");
  cap.setAttribute("class", "knob-cap");
  cap.setAttribute("cx", String(r));
  cap.setAttribute("cy", String(r));
  cap.setAttribute("r", String(r - 6));
  const pointer = document.createElementNS(SVG, "line");
  pointer.setAttribute("class", "knob-pointer");
  svg.append(track, value, cap, pointer);
  const name = document.createElement("span");
  name.className = "knob-label";
  row.append(svg, name);
  const bipolar = spec.min < 0 && spec.max > 0;
  // Refreshing every control after a change is cheap only if an unchanged knob touches nothing.
  let shown = NaN;
  let shownName = "";
  const show = () => {
    const v = values[spec.key] as number;
    const text = row.classList.contains("dragging") && spec.format ? spec.format(v) : label;
    if (text !== shownName) {
      shownName = text;
      name.textContent = text;
    }
    if (v === shown) return;
    shown = v;
    const f = (v - spec.min) / (spec.max - spec.min);
    const a = START + f * SWEEP;
    const from = bipolar ? START + ((0 - spec.min) / (spec.max - spec.min)) * SWEEP : START;
    value.setAttribute("d", Math.abs(a - from) < 0.01 ? "" : arc(r, Math.min(from, a), Math.max(from, a)));
    pointer.setAttribute("x1", (r + Math.cos(a) * 2).toFixed(2));
    pointer.setAttribute("y1", (r + Math.sin(a) * 2).toFixed(2));
    pointer.setAttribute("x2", (r + Math.cos(a) * (r - 6)).toFixed(2));
    pointer.setAttribute("y2", (r + Math.sin(a) * (r - 6)).toFixed(2));
    row.title = describe(spec, v);
  };
  draggable(row, spec, values, onChange, show, 160);
  row.addEventListener("pointerup", show);
  show();
  return { el: row, refresh: show };
}

/**
 * A vertical channel fader with a level meter beside it. `readout` gets the
 * formatted value. The meter's level is drawn over `meter` by the mixer's
 * live overlay (see ui/overlay.ts), so the fader itself never changes per frame.
 */
export function fader(
  spec: NumberSpec, values: ParamValues, onChange: (spec: ParamSpec) => void, targetPrefix: string, readout: HTMLElement,
): Dial & { meter: HTMLElement } {
  const row = document.createElement("div");
  row.className = "param fader";
  row.dataset.target = targetPrefix + spec.key;
  const meterBox = document.createElement("div");
  meterBox.className = "meter-v";
  const slot = document.createElement("div");
  slot.className = "fader-slot";
  const thumb = document.createElement("div");
  thumb.className = "fader-thumb";
  // The unity mark, where the fader neither boosts nor cuts.
  const unity = document.createElement("div");
  unity.className = "fader-unity";
  unity.style.bottom = `${((spec.default - spec.min) / (spec.max - spec.min)) * 100}%`;
  slot.append(unity, thumb);
  row.append(meterBox, slot);
  let shown = NaN;
  const show = () => {
    const v = values[spec.key] as number;
    if (v === shown) return;
    shown = v;
    thumb.style.bottom = `${((v - spec.min) / (spec.max - spec.min)) * 100}%`;
    readout.textContent = spec.format ? spec.format(v) : String(v);
    row.title = describe(spec, v);
  };
  draggable(row, spec, values, onChange, show, 140);
  show();
  return { el: row, refresh: show, meter: meterBox };
}
