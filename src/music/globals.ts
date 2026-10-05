import type { ModelDefinition, ParamSpec, ParamValues } from "../models/types";
import { GRAVITY_MODES } from "../models/lib/gravity";

/**
 * Global Controls: knobs that stay put when you switch models and push every
 * model the same way. Colour works on the finished picture (a filter over the
 * canvas) plus each model's colour dropdown; Speed runs the simulation clock
 * faster or slower; Gravity, Motion and Size move the matching sliders in
 * whichever model is showing (see `global` on ParamSpec).
 */

const MODEL_OWN = "model";

export const GLOBAL_SPECS: ParamSpec[] = [
  { kind: "choice", key: "palette", label: "Colour scheme", group: "Color", default: MODEL_OWN,
    description: "Overrides every model's colour dropdown.",
    options: [
      { value: MODEL_OWN, label: "Each model's own" },
      { value: "notes", label: "Follow the melody" },
      { value: "rainbow", label: "Rainbow, cycling with the beat" },
      { value: "fire", label: "Fire" },
      { value: "ice", label: "Ice" },
    ] },
  { kind: "number", key: "hueShift", label: "Hue shift", min: -180, max: 180, step: 1, default: 0, group: "Color",
    description: "Turns every colour round the colour wheel." },
  { kind: "number", key: "hueCycle", label: "Hue cycle", min: 0, max: 90, step: 1, default: 0, group: "Color",
    description: "Keeps turning the colours with the music, degrees per beat." },
  { kind: "number", key: "saturation", label: "Saturation", min: 0, max: 3, step: 0.05, default: 1, group: "Color",
    description: "0 is black and white, 1 as the model draws it, 3 is neon." },
  { kind: "number", key: "brightness", label: "Brightness", min: 0.2, max: 3, step: 0.05, default: 1, group: "Color",
    description: "Darkens or blows out the whole picture." },
  { kind: "number", key: "contrast", label: "Contrast", min: 0.3, max: 3, step: 0.05, default: 1, group: "Color",
    description: "Low washes everything into haze; high makes it punchy and hard-edged." },
  { kind: "boolean", key: "invert", label: "Negative", default: false, group: "Color",
    description: "Inverts every colour: black backgrounds turn white." },
  { kind: "choice", key: "gravityMode", label: "Direction", group: "Gravity", default: MODEL_OWN,
    description: "Overrides every model's gravity direction.",
    options: [{ value: MODEL_OWN, label: "Each model's own" }, ...GRAVITY_MODES] },
  { kind: "number", key: "gravity", label: "Gravity strength", min: 0, max: 4, step: 0.05, default: 1, group: "Gravity",
    description: "Multiplies every model's gravity. 0 switches it off; 4 is four times as strong." },
  { kind: "number", key: "speed", label: "Speed", min: 0, max: 4, step: 0.05, default: 1, group: "Speed",
    description: "How fast everything moves. 0 freezes the motion while the music plays on; 4 is fast-forward." },
  { kind: "number", key: "energy", label: "Energy", min: 0, max: 4, step: 0.05, default: 1, group: "Motion",
    description: "Multiplies how wildly things move and how hard hits land." },
  { kind: "number", key: "trails", label: "Trails", min: -1, max: 1, step: 0.01, default: 0, group: "Motion",
    description: "Lengthens every model's afterglow (or cuts it, below zero)." },
  { kind: "number", key: "zoom", label: "Tunnel zoom", min: -1, max: 1, step: 0.01, default: 0, group: "Motion",
    description: "Adds to every model's tunnel zoom: trails fly outward, or inward below zero." },
  { kind: "number", key: "spin", label: "Tunnel spin", min: -90, max: 90, step: 1, default: 0, group: "Motion",
    description: "Adds to every model's tunnel spin, degrees per second." },
  { kind: "number", key: "size", label: "Size", min: 0.2, max: 4, step: 0.05, default: 1, group: "Size",
    description: "Multiplies glow, grain and line sizes." },
];

export function defaultGlobals(): ParamValues {
  const values: ParamValues = {};
  for (const p of GLOBAL_SPECS) values[p.key] = p.default;
  return values;
}

/** Saved values with anything missing or out of date replaced by the default. */
export function sanitizeGlobals(saved: unknown): ParamValues {
  const values = defaultGlobals();
  if (!saved || typeof saved !== "object") return values;
  const s = saved as ParamValues;
  for (const p of GLOBAL_SPECS) {
    const v = s[p.key];
    if (p.kind === "number" && typeof v === "number" && Number.isFinite(v)) values[p.key] = Math.min(p.max, Math.max(p.min, v));
    else if (p.kind === "boolean" && typeof v === "boolean") values[p.key] = v;
    else if (p.kind === "choice" && p.options.some((o) => o.value === v)) values[p.key] = v as string;
  }
  return values;
}

/** Scheme names some models call by another name. */
const PALETTE_ALIASES: Record<string, string[]> = { fire: ["ember"], ice: ["ocean"] };

/**
 * Push the model's parameter values in `out` by the global controls in `g`.
 * Runs after macros and modulation, so the globals act on top of everything.
 */
export function applyGlobals(def: ModelDefinition, g: ParamValues, out: ParamValues): void {
  const gravity = g.gravity as number, energy = g.energy as number, size = g.size as number;
  for (const spec of def.params) {
    if (spec.resetOnChange) continue;
    const key = spec.key;
    if (spec.kind === "number") {
      let v = out[key] as number;
      const before = v;
      if (spec.global === "gravity") v *= gravity;
      else if (spec.global === "energy") v *= energy;
      else if (spec.global === "size") v *= size;
      if (key === "afterglow") v += (g.trails as number) * (spec.max - spec.min);
      else if (key === "zoom") v += g.zoom as number;
      else if (key === "spin") v += g.spin as number;
      if (v === before) continue;
      v = Math.min(spec.max, Math.max(spec.min, v));
      if (spec.step >= 1) v = Math.round(v);
      out[key] = v;
    } else if (spec.kind === "choice") {
      let want: string | null = null;
      if (key === "gravityMode" && g.gravityMode !== MODEL_OWN) want = g.gravityMode as string;
      else if ((key === "colours" || key === "palette") && g.palette !== MODEL_OWN) want = g.palette as string;
      if (want === null) continue;
      const names = [want, ...(PALETTE_ALIASES[want] ?? [])];
      const hit = names.find((n) => spec.options.some((o) => o.value === n));
      if (hit) out[key] = hit;
    }
  }
}

/** The CSS filter for the canvas, or "" when the colour controls are all neutral. */
export function canvasFilter(g: ParamValues, beats: number): string {
  const parts: string[] = [];
  const hue = ((((g.hueShift as number) + (g.hueCycle as number) * beats) % 360) + 360) % 360;
  if (hue > 0.5 && hue < 359.5) parts.push(`hue-rotate(${hue.toFixed(1)}deg)`);
  if (g.saturation !== 1) parts.push(`saturate(${g.saturation})`);
  if (g.brightness !== 1) parts.push(`brightness(${g.brightness})`);
  if (g.contrast !== 1) parts.push(`contrast(${g.contrast})`);
  if (g.invert) parts.push("invert(1)");
  return parts.join(" ");
}
