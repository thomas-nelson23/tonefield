import type { ParamSpec } from "./models/types";

/**
 * The dice. Every part of the app that can be rolled (the model's sliders,
 * the macros, the global controls, the modulation matrix, the music) rolls
 * with the same four levels, so one setting says how far a roll may go:
 *
 *   Nudge  every slider moves a little from where it is; nothing switches
 *   Shake  sliders move further and the odd switch or dropdown flips
 *   Roll   fresh values across each slider's useful band; dropdowns and the model may change
 *   Wild   whole ranges, every switch, rebuild sizes and the stranger corners
 *
 * The level is an index into LEVELS. Helpers here keep the rolls consistent.
 */
export type RollLevel = 0 | 1 | 2 | 3;

export const LEVELS: { name: string; hint: string }[] = [
  { name: "Nudge", hint: "Every slider moves a little from where it is. Nothing switches, and the music keeps its idea." },
  { name: "Shake", hint: "Sliders move further, the odd dropdown flips, the music gets a new idea in the same style." },
  { name: "Roll", hint: "Fresh values across the useful part of every range. Dropdowns, presets, the style and the model can change." },
  { name: "Wild", hint: "Anything goes: whole ranges, every switch, rebuild sizes, new sounds and the stranger corners." },
];

/** How likely each level is to flip a dropdown or switch. */
export const SWITCH_CHANCE: number[] = [0, 0.15, 0.5, 0.8];

export const chance = (p: number): boolean => Math.random() < p;
export const between = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);
export const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];

/** A random entry other than `current`, or `current` when it's the only one. */
export function pickOther<T>(list: readonly T[], current: T): T {
  const others = list.filter((x) => x !== current);
  return others.length ? pick(others) : current;
}

export type NumberSpec = Extract<ParamSpec, { kind: "number" }>;

/** A random value from `lo` to `hi` on the given step. */
export function randomStep(lo: number, hi: number, step: number): number {
  const steps = Math.round((hi - lo) / step);
  return Number((lo + Math.floor(Math.random() * (steps + 1)) * step).toFixed(6));
}

const snap = (spec: NumberSpec, v: number): number =>
  Number(Math.min(spec.max, Math.max(spec.min, spec.min + Math.round((v - spec.min) / spec.step) * spec.step)).toFixed(6));

/**
 * A number parameter's next value at a roll level. `band` is the useful part
 * of its range (the spec's own `random` band when none is given); Nudge and
 * Shake move from `current` by a tenth or a third of the band, Roll lands
 * anywhere in it, and Wild anywhere in the whole range.
 */
export function rollNumber(spec: NumberSpec, current: number, level: RollLevel, band?: [number, number]): number {
  const [lo, hi] = level === 3 ? [spec.min, spec.max] : band ?? spec.random ?? [spec.min, spec.max];
  if (level >= 2) return randomStep(lo, hi, spec.step);
  // A value already outside the band is nudged from where it is, not yanked into the band.
  const width = (hi - lo) * (level === 0 ? 0.1 : 0.35);
  const v = current + (Math.random() * 2 - 1) * width;
  return snap(spec, Math.min(Math.max(hi, current), Math.max(Math.min(lo, current), v)));
}

/** A choice's next value: switches with the level's chance, to any other option. */
export function rollChoice(spec: Extract<ParamSpec, { kind: "choice" }>, current: string, level: RollLevel): string {
  if (!chance(SWITCH_CHANCE[level])) return current;
  return pickOther(spec.options.map((o) => o.value), current);
}

export const DICE_ICON =
  '<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="1.5" width="11" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.3"/><g fill="currentColor"><circle cx="4.6" cy="4.6" r="1.1"/><circle cx="7" cy="7" r="1.1"/><circle cx="9.4" cy="9.4" r="1.1"/></g></svg>';

export const LOCK_ICON =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="5.5" width="8" height="5.5" rx="1"/><path class="shackle" d="M4 5.5V4a2 2 0 0 1 4 0v1.5"/></svg>';
