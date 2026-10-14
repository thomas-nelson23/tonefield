import type { ParamSpec, ParamValues } from "../models/types";

export interface ParamControls {
  /** Re-read values (e.g. after a MIDI controller moved one) into the controls. */
  refresh(): void;
  /** Mark where modulation has pushed each slider. */
  showModulation(effective: Record<string, number | boolean | string>): void;
  /** Name the routes pushing each parameter, e.g. "Kick +40%", under its control. */
  showRoutes(labels: Record<string, string>): void;
}

/** Fill a slider's track up to its thumb (the CSS reads `--fill`). */
export function paintRange(input: HTMLInputElement): void {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const fill = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
  input.style.setProperty("--fill", `${fill}%`);
}

/** Group headings the user has folded away, remembered across models and launches. */
function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem("ui:collapsedGroups") ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function saveCollapsed(set: Set<string>): void {
  try {
    localStorage.setItem("ui:collapsedGroups", JSON.stringify([...set]));
  } catch {
    // Only a convenience.
  }
}

/** Parameters Randomize leaves alone: the keys, and a callback after one is locked or unlocked. */
export interface ParamLocks {
  keys: Set<string>;
  changed(): void;
}

const LOCK_ICON =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="5.5" width="8" height="5.5" rx="1"/><path class="shackle" d="M4 5.5V4a2 2 0 0 1 4 0v1.5"/></svg>';

/**
 * Builds sliders, checkboxes and dropdowns from a model's parameter specs. `onChange`
 * receives the spec that changed so the host can decide whether to reset.
 * Each row carries `data-target` (`targetPrefix` + key) so MIDI learn can find it.
 * Specs marked `hidden` get no control. With `locks`, each row gets a padlock
 * that keeps the parameter out of Randomize.
 */
export function renderParamControls(
  container: HTMLElement,
  specs: ParamSpec[],
  values: ParamValues,
  onChange: (spec: ParamSpec) => void,
  targetPrefix = "",
  locks?: ParamLocks,
): ParamControls {
  container.replaceChildren();
  const refreshers: (() => void)[] = [];
  const badges: Record<string, HTMLElement> = {};
  const sliders: { spec: Extract<ParamSpec, { kind: "number" }>; marker: HTMLElement; readout: HTMLElement; shown: boolean; drawn: string }[] = [];
  // Parameters with a group go under a foldable heading, in the order groups first appear.
  const groups = new Map<string, HTMLElement>();
  const collapsed = loadCollapsed();
  const parentFor = (group: string | undefined): HTMLElement => {
    if (!group) return container;
    let body = groups.get(group);
    if (!body) {
      const details = document.createElement("details");
      details.className = "param-group";
      // Remembered per panel, so folding "Gravity" in the sidebar leaves the global one alone.
      const name = targetPrefix + group;
      details.open = !collapsed.has(name);
      const summary = document.createElement("summary");
      summary.textContent = group;
      body = document.createElement("div");
      details.append(summary, body);
      details.addEventListener("toggle", () => {
        if (details.open) collapsed.delete(name);
        else collapsed.add(name);
        saveCollapsed(collapsed);
      });
      container.append(details);
      groups.set(group, body);
    }
    return body;
  };

  for (const spec of specs) {
    if (spec.hidden) continue;
    const row = document.createElement("div");
    row.className = "param";
    row.dataset.target = targetPrefix + spec.key;
    const id = `param-${targetPrefix.replace(":", "-")}${spec.key}`;

    if (spec.kind === "number") {
      const label = document.createElement("label");
      label.htmlFor = id;
      const name = document.createElement("span");
      name.textContent = spec.label;
      const readout = document.createElement("span");
      readout.className = "readout";
      label.append(name, readout);

      const input = document.createElement("input");
      input.type = "range";
      input.id = id;
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = String(spec.step);
      input.value = String(values[spec.key]);

      const show = () => {
        readout.textContent = spec.format ? spec.format(Number(input.value)) : formatNumber(Number(input.value), spec.step);
        paintRange(input);
      };
      show();
      input.addEventListener("input", () => {
        values[spec.key] = Number(input.value);
        show();
        if (!spec.resetOnChange) onChange(spec);
      });
      // Resetting on every slider tick would be jarring for things like body
      // count, so reset-triggering params apply when the drag ends.
      input.addEventListener("change", () => {
        if (spec.resetOnChange) onChange(spec);
      });
      // A tick under the slider shows the value modulation is pushing it to.
      const track = document.createElement("div");
      track.className = "mod-track";
      const marker = document.createElement("div");
      marker.className = "mod-marker";
      track.append(marker);
      sliders.push({ spec, marker, readout, shown: false, drawn: "" });
      refreshers.push(() => {
        input.value = String(values[spec.key]);
        show();
      });
      row.append(label, input, track);
    } else if (spec.kind === "choice") {
      const label = document.createElement("label");
      label.htmlFor = id;
      label.textContent = spec.label;
      const input = document.createElement("select");
      input.id = id;
      for (const o of spec.options) {
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.label;
        input.append(opt);
      }
      input.value = String(values[spec.key]);
      input.addEventListener("change", () => {
        values[spec.key] = input.value;
        onChange(spec);
        // Hand the keyboard back so Space / R keep driving the simulation.
        input.blur();
      });
      refreshers.push(() => (input.value = String(values[spec.key])));
      row.append(label, input);
    } else {
      row.classList.add("param-toggle");
      const label = document.createElement("label");
      label.htmlFor = id;
      label.textContent = spec.label;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = id;
      input.checked = Boolean(values[spec.key]);
      input.addEventListener("change", () => {
        values[spec.key] = input.checked;
        onChange(spec);
      });
      refreshers.push(() => (input.checked = Boolean(values[spec.key])));
      row.append(input, label);
    }

    if (locks) {
      row.classList.add("lockable");
      const lock = document.createElement("button");
      lock.type = "button";
      lock.className = "lock";
      lock.innerHTML = LOCK_ICON;
      const show = () => {
        const on = locks.keys.has(spec.key);
        lock.classList.toggle("on", on);
        lock.setAttribute("aria-pressed", String(on));
        lock.title = on ? "Locked: Randomize leaves this alone. Click to unlock." : "Lock, so Randomize leaves this alone";
      };
      show();
      lock.addEventListener("click", () => {
        if (!locks.keys.delete(spec.key)) locks.keys.add(spec.key);
        show();
        locks.changed();
        lock.blur();
      });
      row.prepend(lock);
    }

    const badge = document.createElement("div");
    badge.className = "mod-badge";
    badge.hidden = true;
    badges[spec.key] = badge;
    row.append(badge);
    if (spec.description) {
      const help = document.createElement("div");
      help.className = "param-help";
      help.textContent = spec.description;
      row.append(help);
    }
    parentFor(spec.group).append(row);
  }

  return {
    refresh: () => refreshers.forEach((r) => r()),
    showRoutes(labels) {
      for (const key in badges) {
        badges[key].textContent = labels[key] ? `♪ ${labels[key]}` : "";
        badges[key].hidden = !labels[key];
      }
    },
    showModulation(effective) {
      for (const s of sliders) {
        const v = effective[s.spec.key] as number;
        const base = values[s.spec.key] as number;
        const on = Math.abs(v - base) > 1e-9;
        if (on) {
          // A bar from the slider's own value to where modulation has pushed it.
          // It only moves when it moves a visible amount: each move makes the
          // webview repaint the sidebar, which is slow while music plays.
          const range = s.spec.max - s.spec.min;
          const a = (Math.min(v, base) - s.spec.min) / range, b = (Math.max(v, base) - s.spec.min) / range;
          const drawn = `translateX(${(a * 100).toFixed(1)}%) scaleX(${Math.max(0.015, b - a).toFixed(3)})`;
          if (drawn !== s.drawn) {
            s.drawn = drawn;
            s.marker.style.transform = drawn;
          }
        }
        if (on !== s.shown) {
          s.marker.parentElement!.classList.toggle("active", on);
          s.readout.classList.toggle("modulated", on);
          s.shown = on;
        }
      }
    },
  };
}

function formatNumber(v: number, step: number): string {
  const decimals = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
  return v.toFixed(decimals);
}
