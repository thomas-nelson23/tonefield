import type { ParamSpec, ParamValues } from "../models/types";
import type { Dial } from "./knob";

/**
 * A choice as a row of buttons, every option in view, for choices short
 * enough to fit: one click to hear each. Works for a choice spec, or for a
 * whole-number spec given a label per value. The row is a `.param` with
 * `data-target`, so MIDI learn can map it like any other control.
 */
export function segmented(
  spec: ParamSpec, values: ParamValues, onChange: (spec: ParamSpec) => void, targetPrefix: string, labels?: string[],
): Dial {
  const options = spec.kind === "choice"
    ? spec.options
    : (labels ?? []).map((label, i) => ({ value: String(i), label }));
  const row = document.createElement("div");
  row.className = "param seg-param";
  row.dataset.target = targetPrefix + spec.key;
  if (spec.description) row.dataset.hint = `${spec.label}: ${spec.description}`;
  const name = document.createElement("span");
  name.className = "seg-label";
  name.textContent = spec.label;
  const seg = document.createElement("div");
  seg.className = "segmented";
  const buttons = options.map((o) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "small";
    b.textContent = o.label;
    b.addEventListener("click", () => {
      values[spec.key] = spec.kind === "choice" ? o.value : Number(o.value);
      refresh();
      onChange(spec);
      b.blur();
    });
    seg.append(b);
    return b;
  });
  const refresh = () => {
    const v = String(values[spec.key]);
    options.forEach((o, i) => buttons[i].classList.toggle("active", o.value === v));
  };
  refresh();
  row.append(name, seg);
  return { el: row, refresh };
}
