import type { ParamSpec } from "../types";

/**
 * A shared "where does gravity pull" option for models with a gravity field.
 * Models add `gravityModeParam()` to their params and call `gravityAt` per
 * body (or once, for the uniform modes) to get the acceleration.
 */

export type GravityMode =
  | "off" | "down" | "up" | "left" | "right"
  | "center" | "outward" | "corners" | "walls" | "swirl" | "spin";

export const GRAVITY_MODES: { value: GravityMode; label: string }[] = [
  { value: "down", label: "Down" },
  { value: "up", label: "Up" },
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "center", label: "Toward the centre" },
  { value: "outward", label: "Out from the centre" },
  { value: "corners", label: "Toward the nearest corner" },
  { value: "walls", label: "Toward the nearest wall" },
  { value: "swirl", label: "Swirl around the centre" },
  { value: "spin", label: "Down, slowly rotating" },
  { value: "off", label: "Off" },
];

/**
 * The model's own gravity direction. No dropdown of its own: the global
 * Direction picks it ("Each model's own" keeps `def`); macros can still switch it.
 */
export function gravityModeParam(def: GravityMode): ParamSpec {
  return { kind: "choice", key: "gravityMode", label: "Gravity direction", options: GRAVITY_MODES, default: def, hidden: true };
}

/** True for modes that pull the same way everywhere, so callers can compute once per step. */
export function isUniform(mode: string): boolean {
  return mode === "off" || mode === "down" || mode === "up" || mode === "left" || mode === "right" || mode === "spin";
}

/** Unit direction of a uniform mode. `time` (seconds) turns the "spin" mode. */
export function uniformDir(mode: string, time = 0): [number, number] {
  switch (mode) {
    case "down": return [0, 1];
    case "up": return [0, -1];
    case "left": return [-1, 0];
    case "right": return [1, 0];
    case "spin": {
      // One full turn every 20 seconds, starting pointing down.
      const a = Math.PI / 2 + time * ((Math.PI * 2) / 20);
      return [Math.cos(a), Math.sin(a)];
    }
    default: return [0, 0];
  }
}

/**
 * Acceleration at (x, y) for a field of strength `g` (px/s²) in a w×h box.
 * Point modes ease off within `soft` pixels of their target so bodies settle
 * instead of jittering across it.
 */
export function gravityAt(mode: string, g: number, x: number, y: number, w: number, h: number, time = 0, soft = 40): [number, number] {
  if (g === 0 || mode === "off") return [0, 0];
  if (isUniform(mode)) {
    const [dx, dy] = uniformDir(mode, time);
    return [dx * g, dy * g];
  }
  let tx: number, ty: number;
  switch (mode) {
    case "corners":
      tx = x < w / 2 ? 0 : w;
      ty = y < h / 2 ? 0 : h;
      break;
    case "walls": {
      // Straight at whichever edge is closest.
      const dl = x, dr = w - x, dt = y, db = h - y;
      const m = Math.min(dl, dr, dt, db);
      if (m === dl) return [-g, 0];
      if (m === dr) return [g, 0];
      if (m === dt) return [0, -g];
      return [0, g];
    }
    default:
      tx = w / 2;
      ty = h / 2;
  }
  const dx = tx - x, dy = ty - y;
  const d = Math.hypot(dx, dy) || 1;
  const ease = d / (d + soft);
  const ux = dx / d, uy = dy / d;
  if (mode === "outward") return [-ux * g, -uy * g];
  if (mode === "swirl") {
    // Mostly sideways around the centre, with a little inward pull to keep the orbit.
    return [(-uy * 0.85 + ux * 0.35) * g * ease, (ux * 0.85 + uy * 0.35) * g * ease];
  }
  return [ux * g * ease, uy * g * ease];
}
