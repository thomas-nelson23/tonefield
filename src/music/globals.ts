import type { ModelDefinition, ParamSpec, ParamValues } from "../models/types";
import { GRAVITY_MODES } from "../models/lib/gravity";
import { COLOUR_SCHEMES } from "../models/lib/visual";
import type { Grade } from "../ui/grade";

/**
 * Global Controls: knobs that stay put when you switch models and push every
 * model the same way. The colour sliders work on the finished picture (see
 * ui/grade.ts). Colour scheme, gravity, trails and the tunnel set values the
 * models have no sliders for (`hidden` on ParamSpec), and Energy multiplies
 * the sliders tagged `global: "energy"`.
 */

const MODEL_OWN = "model";

export const GLOBAL_SPECS: ParamSpec[] = [
  { kind: "choice", key: "palette", label: "Colour scheme", group: "Color", default: "notes",
    description: "Where every model takes its colours from.",
    options: COLOUR_SCHEMES },
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
    description: "Where gravity pulls in every model. Each model's own: Fabric hangs down, the others float free.",
    options: [{ value: MODEL_OWN, label: "Each model's own" }, ...GRAVITY_MODES] },
  { kind: "number", key: "gravity", label: "Gravity strength", min: 0, max: 5, step: 0.05, default: 1, group: "Gravity",
    description: "How hard gravity pulls, as a multiple of each model's normal pull. 0 switches it off." },
  { kind: "number", key: "energy", label: "Energy", min: 0, max: 4, step: 0.05, default: 1, group: "Motion", curve: 2,
    description: "Multiplies each model's motion sliders (speed, spin, drift, wind) on top of everything else. It does not scale the modulation matrix: Intensity there does that." },
  { kind: "number", key: "trails", label: "Trails", min: -1, max: 1, step: 0.01, default: 0, group: "Motion",
    description: "Lengthens every model's fading trails, or cuts them below zero. Near the top they pile up into smoky echoes." },
  { kind: "number", key: "zoom", label: "Tunnel zoom", min: -1, max: 1, step: 0.01, default: 0, group: "Motion",
    description: "Trails fly outward like flying through a tunnel, or inward below zero." },
  { kind: "number", key: "spin", label: "Tunnel spin", min: -90, max: 90, step: 1, default: 0, group: "Motion",
    description: "Trails turn round the centre, degrees per second. With zoom it makes a spiral." },
];

export function defaultGlobals(): ParamValues {
  const values: ParamValues = {};
  for (const p of GLOBAL_SPECS) if (p.kind !== "widget") values[p.key] = p.default;
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

const clamp = (spec: Extract<ParamSpec, { kind: "number" }>, v: number) => Math.min(spec.max, Math.max(spec.min, v));

/**
 * Set the model's hidden parameters in `base` from the global controls in `g`,
 * before macros and modulation push them: the global controls stand in for
 * the sliders those parameters no longer have.
 */
export function setHidden(def: ModelDefinition, g: ParamValues, base: ParamValues): void {
  for (const spec of def.params) {
    if (!spec.hidden) continue;
    const key = spec.key;
    if (spec.kind === "number") {
      let v = spec.default;
      if (spec.global === "gravity") v *= g.gravity as number;
      else if (key === "afterglow") v += (g.trails as number) * (spec.max - spec.min);
      else if (key === "zoom") v = g.zoom as number;
      else if (key === "spin") v = g.spin as number;
      base[key] = clamp(spec, v);
    } else if (spec.kind === "choice") {
      let want = spec.default;
      if (key === "gravityMode" && g.gravityMode !== MODEL_OWN) want = g.gravityMode as string;
      else if (key === "colours") want = g.palette as string;
      base[key] = spec.options.some((o) => o.value === want) ? want : spec.default;
    } else if (spec.kind === "boolean") {
      base[key] = spec.default;
    }
  }
}

/**
 * Multiply the sliders tagged `global: "energy"` in `out` by the global
 * Energy. Runs after macros and modulation, so it acts on top of everything.
 */
export function applyEnergy(def: ModelDefinition, g: ParamValues, out: ParamValues): void {
  const energy = g.energy as number;
  if (energy === 1) return;
  for (const spec of def.params) {
    if (spec.kind !== "number" || spec.global !== "energy" || spec.resetOnChange) continue;
    let v = clamp(spec, (out[spec.key] as number) * energy);
    if (spec.step >= 1) v = Math.round(v);
    out[spec.key] = v;
  }
}

/** What the colour controls do to the finished picture this frame. */
export function gradeOf(g: ParamValues, beats: number): Grade {
  return {
    hue: (g.hueShift as number) + (g.hueCycle as number) * beats,
    saturation: g.saturation as number,
    brightness: g.brightness as number,
    contrast: g.contrast as number,
    invert: g.invert as boolean,
  };
}

/** A named set of global control values. Keys left out keep their defaults. */
export interface GlobalPreset {
  name: string;
  values: ParamValues;
}

export const BUILT_IN_PRESETS: GlobalPreset[] = [
  { name: "Neutral", values: {} },
  { name: "Neon tunnel", values: { palette: "rainbow", saturation: 1.8, contrast: 1.2, trails: 0.25, zoom: 0.35, spin: 20 } },
  { name: "Inferno", values: { palette: "fire", contrast: 1.3, brightness: 1.1, energy: 1.6, gravityMode: "up", gravity: 1.5, trails: 0.15 } },
  { name: "Deep freeze", values: { palette: "ice", saturation: 0.8, brightness: 0.9, energy: 0.5, trails: 0.35, gravityMode: "down", gravity: 0.6 } },
  { name: "Daydream", values: { hueCycle: 10, saturation: 1.3, contrast: 0.8, energy: 0.7, trails: 0.5, zoom: 0.1, spin: -8 } },
  { name: "Whirlpool", values: { palette: "rainbow", gravityMode: "swirl", gravity: 2, trails: 0.3, zoom: -0.2, spin: 35 } },
  { name: "Deep sea", values: { palette: "bio", contrast: 1.2, energy: 0.8, trails: 0.3, gravityMode: "center", gravity: 0.6 } },
  { name: "Noir", values: { saturation: 0, contrast: 1.6, brightness: 1.1, trails: 0.2 } },
  { name: "Negative", values: { invert: true, hueShift: 180, saturation: 1.2 } },
  { name: "Chaos", values: { hueCycle: 45, saturation: 1.6, energy: 3, trails: 0.15, zoom: 0.5, spin: 60 } },
];

/** The full set of values a preset stands for. */
export function presetValues(p: GlobalPreset): ParamValues {
  return sanitizeGlobals({ ...defaultGlobals(), ...p.values });
}

/** True when `values` are exactly what the preset sets. */
export function matchesPreset(values: ParamValues, p: GlobalPreset): boolean {
  const want = presetValues(p);
  return GLOBAL_SPECS.every((s) => want[s.key] === values[s.key]);
}
