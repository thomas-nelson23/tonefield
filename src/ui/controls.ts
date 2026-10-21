import type { ParamSpec, ParamValues } from "../models/types";
import { LiveOverlay } from "./overlay";

export interface ParamControls {
  /** Re-read values (e.g. after a MIDI controller moved one) into the controls. */
  refresh(): void;
  /** Mark where modulation has pushed each slider. */
  showModulation(effective: Record<string, number | boolean | string>): void;
  /** Name the routes pushing each parameter, e.g. "Kick +40%", under its control. */
  showRoutes(labels: Record<string, string>): void;
  /** Show or hide the one-line descriptions under the controls. */
  setHelp(on: boolean): void;
}

/** Fill a slider's track up to its thumb (the CSS reads `--fill`). */
export function paintRange(input: HTMLInputElement): void {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const fill = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
  const v = `${fill.toFixed(2)}%`;
  // An unchanged inline style would still make the webview restyle and repaint the slider.
  if (fills.get(input) === v) return;
  fills.set(input, v);
  input.style.setProperty("--fill", v);
}
const fills = new WeakMap<HTMLInputElement, string>();
/** The live overlay last made on each block of rows, so re-rendering a panel retires it. */
const blockOverlays = new WeakMap<HTMLElement, LiveOverlay>();

/** Set an element's text only when it differs: setting the same text again still repaints it. */
export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
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

/** Extras a panel can ask for. */
export interface ControlOptions {
  locks?: ParamLocks;
  /** Each slider gets a ♪ button that asks for a modulation route to it. */
  addRoute?(key: string): void;
  /** Clicking the ♪ badge under a slider shows the routes pushing it. */
  showRouteOf?(key: string): void;
  /** Start with the descriptions shown under the controls. */
  help?: boolean;
}

type NumberSpec = Extract<ParamSpec, { kind: "number" }>;

const LOCK_ICON =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="5.5" width="8" height="5.5" rx="1"/><path class="shackle" d="M4 5.5V4a2 2 0 0 1 4 0v1.5"/></svg>';
const ROUTE_ICON = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 9.5V2.5l5-1v7"/><circle cx="3" cy="9.5" r="1.6"/><circle cx="8" cy="8.5" r="1.6"/></svg>';

/** The slider position (0..1) of a value on a curved slider, and back. */
function toPos(spec: NumberSpec, v: number): number {
  const frac = Math.min(1, Math.max(0, (v - spec.min) / (spec.max - spec.min)));
  return spec.curve && spec.curve !== 1 ? Math.pow(frac, 1 / spec.curve) : frac;
}
function fromPos(spec: NumberSpec, pos: number): number {
  const frac = spec.curve && spec.curve !== 1 ? Math.pow(pos, spec.curve) : pos;
  const raw = spec.min + frac * (spec.max - spec.min);
  const snapped = spec.min + Math.round((raw - spec.min) / spec.step) * spec.step;
  return Number(Math.min(spec.max, Math.max(spec.min, snapped)).toFixed(6));
}

/**
 * Builds sliders, checkboxes, dropdowns, segmented buttons and widgets from a
 * model's parameter specs. `onChange` receives the spec that changed so the
 * host can decide whether to reset. Each row carries `data-target`
 * (`targetPrefix` + key) so MIDI learn can find it. Specs marked `hidden` get
 * no control; `advanced` ones go under a folded "More" heading; `showWhen`
 * ones appear only while their condition holds. With `locks`, each row gets
 * a padlock that keeps the parameter out of Randomize.
 */
export function renderParamControls(
  container: HTMLElement,
  specs: ParamSpec[],
  values: ParamValues,
  onChange: (spec: ParamSpec) => void,
  targetPrefix = "",
  locks?: ParamLocks,
  options: ControlOptions = {},
): ParamControls {
  container.replaceChildren();
  container.classList.toggle("show-help", !!options.help);
  const refreshers: (() => void)[] = [];
  const badges: Record<string, HTMLElement> = {};
  /** Each slider's modulation bar: `a`..`b` of the track, drawn on its block's overlay while `on`. */
  const sliders: { spec: NumberSpec; track: HTMLElement; readout: HTMLElement; block: HTMLElement; on: boolean; a: number; b: number }[] = [];
  /** One live overlay per block of rows (the container, and each group's body), made when a slider lands in it. */
  const overlays = new Map<HTMLElement, LiveOverlay>();
  const markerColour = targetPrefix === "macro:" ? "--macro" : "--cyan";
  const overlayFor = (block: HTMLElement): LiveOverlay => {
    let o = overlays.get(block);
    if (!o) {
      // The container is rendered again for every model; the last render's overlay goes with its rows.
      blockOverlays.get(block)?.dispose();
      o = new LiveOverlay(block, (ov) => { ov.fill = ov.colour(markerColour, "#2ad4ff"); });
      overlays.set(block, o);
      blockOverlays.set(block, o);
    }
    return o;
  };
  const pads: { spec: Extract<ParamSpec, { kind: "widget" }>; draw(effective?: ParamValues): void }[] = [];
  /** Rows that appear only in some states, and labels that change with them. */
  const contextual: (() => void)[] = [];
  /** Widgets drawn for a parameter, told when a slider moves it. */
  const dependents: Record<string, (() => void)[]> = {};
  const byKey = new Map(specs.map((s) => [s.key, s] as const));
  // Parameters a widget stands for get no control of their own unless they are also fine ("advanced") controls.
  const widgetKeys = new Set(specs.flatMap((s) => (s.kind === "widget" ? s.keys : [])));
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
      details.open = !collapsed.has(name) && group !== "More";
      if (group === "More" && collapsed.has("open:" + name)) details.open = true;
      const summary = document.createElement("summary");
      summary.textContent = group;
      body = document.createElement("div");
      details.append(summary, body);
      details.addEventListener("toggle", () => {
        // "More" starts folded, so what is remembered is it being opened.
        const flag = group === "More" ? "open:" + name : name;
        if (details.open === (group === "More")) collapsed.add(flag);
        else collapsed.delete(flag);
        saveCollapsed(collapsed);
      });
      container.append(details);
      groups.set(group, body);
    }
    return body;
  };

  const updateContext = () => contextual.forEach((c) => c());
  const notify = (key: string) => dependents[key]?.forEach((d) => d());
  const changed = (spec: ParamSpec) => {
    onChange(spec);
    updateContext();
  };

  /** The small buttons before a label (padlock, ♪), in one cell so the label column stays aligned. */
  const icons = (row: HTMLElement): HTMLElement => {
    let box = row.querySelector<HTMLElement>(":scope > .param-icons");
    if (!box) {
      box = document.createElement("div");
      box.className = "param-icons";
      row.prepend(box);
    }
    return box;
  };

  const makeLock = (row: HTMLElement, keys: string[]) => {
    if (!locks) return;
    const lockSet = locks;
    row.classList.add("lockable");
    const lock = document.createElement("button");
    lock.type = "button";
    lock.className = "lock";
    lock.innerHTML = LOCK_ICON;
    const show = () => {
      const on = keys.every((k) => lockSet.keys.has(k));
      lock.classList.toggle("on", on);
      lock.setAttribute("aria-pressed", String(on));
      lock.title = on ? "Locked: Randomize leaves this alone. Click to unlock." : "Lock, so Randomize leaves this alone";
    };
    show();
    lock.addEventListener("click", () => {
      const on = keys.every((k) => lockSet.keys.has(k));
      for (const k of keys) {
        if (on) lockSet.keys.delete(k);
        else lockSet.keys.add(k);
      }
      show();
      lockSet.changed();
      lock.blur();
    });
    icons(row).append(lock);
  };

  const makeRouteButton = (row: HTMLElement, key: string) => {
    const add = options.addRoute;
    if (!add) return;
    row.classList.add("routable");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "route-add";
    b.innerHTML = ROUTE_ICON;
    b.title = "Add a modulation route to this slider";
    b.addEventListener("click", () => { add(key); b.blur(); });
    icons(row).append(b);
  };

  const finishRow = (row: HTMLElement, spec: ParamSpec, keys: string[]) => {
    makeLock(row, keys);
    if (spec.kind === "number" && options.addRoute) makeRouteButton(row, spec.key);
    if (spec.kind !== "widget") {
      const badge = document.createElement("div");
      badge.className = "mod-badge";
      badge.hidden = true;
      badges[spec.key] = badge;
      if (options.showRouteOf) {
        const show = options.showRouteOf;
        badge.classList.add("clickable");
        badge.title = "Show these routes in the Modulation tab";
        badge.addEventListener("click", () => show(spec.key));
      }
      row.append(badge);
    }
    if (spec.description) {
      row.title = spec.description;
      const help = document.createElement("div");
      help.className = "param-help";
      help.textContent = spec.description;
      row.append(help);
    }
    if (spec.showWhen) {
      const when = spec.showWhen;
      contextual.push(() => { row.hidden = !when(values); });
    }
    parentFor(spec.advanced ? "More" : spec.group).append(row);
  };

  /** Small tags after a label: "rebuilds" for parameters that restart the model, "fps" for costly ones. */
  const tags = (spec: ParamSpec, label: HTMLElement) => {
    if (spec.resetOnChange) {
      const t = document.createElement("span");
      t.className = "param-tag";
      t.textContent = "↻";
      t.title = spec.perf ? "Changing this rebuilds the model; higher values cost frame rate" : "Changing this rebuilds the model";
      label.append(t);
    }
    if (spec.perf && !spec.resetOnChange) {
      const t = document.createElement("span");
      t.className = "param-tag perf";
      t.textContent = "fps";
      t.title = "Higher values cost frame rate";
      label.append(t);
    }
  };

  for (const spec of specs) {
    if (spec.hidden) continue;
    if (spec.kind !== "widget" && widgetKeys.has(spec.key) && !spec.advanced) continue;
    const row = document.createElement("div");
    row.className = "param";
    if (spec.kind !== "widget") row.dataset.target = targetPrefix + spec.key;
    const id = `param-${targetPrefix.replace(":", "-")}${spec.key}`;

    if (spec.kind === "number") {
      const label = document.createElement("label");
      label.htmlFor = id;
      const name = document.createElement("span");
      name.textContent = spec.label;
      tags(spec, name);
      const readout = document.createElement("span");
      readout.className = "readout";
      label.append(name, readout);
      if (spec.labelFor) {
        const labelFor = spec.labelFor;
        contextual.push(() => { name.firstChild!.textContent = labelFor(values); });
      }

      const input = document.createElement("input");
      input.type = "range";
      input.id = id;
      const curved = !!spec.curve && spec.curve !== 1;
      if (curved) {
        input.min = "0";
        input.max = "1";
        input.step = "0.001";
      } else {
        input.min = String(spec.min);
        input.max = String(spec.max);
        input.step = String(spec.step);
      }
      const show = () => {
        const v = values[spec.key] as number;
        const pos = String(curved ? toPos(spec, v) : v);
        if (input.value !== pos) input.value = pos;
        setText(readout, spec.format ? spec.format(v, values) : formatNumber(v, spec.step));
        paintRange(input);
        row.classList.toggle("changed", Math.abs(v - spec.default) > 1e-9);
      };
      show();
      input.addEventListener("input", () => {
        let v = curved ? fromPos(spec, Number(input.value)) : Number(input.value);
        if (spec.snapZero && Math.abs(v) < (spec.max - spec.min) * 0.025) v = 0;
        values[spec.key] = v;
        show();
        notify(spec.key);
        if (!spec.resetOnChange) changed(spec);
      });
      // Resetting on every slider tick would be jarring for things like body
      // count, so reset-triggering params apply when the drag ends.
      input.addEventListener("change", () => {
        if (spec.resetOnChange) changed(spec);
      });
      input.title = "Double-click to put it back to its default";
      input.addEventListener("dblclick", () => {
        values[spec.key] = spec.default;
        show();
        notify(spec.key);
        changed(spec);
      });
      // A bar under the slider shows the value modulation is pushing it to. The
      // row only holds its place: the bar is drawn on the block's overlay canvas.
      const track = document.createElement("div");
      track.className = "mod-track";
      const block = parentFor(spec.advanced ? "More" : spec.group);
      const slider = { spec, track, readout, block, on: false, a: 0, b: 0 };
      sliders.push(slider);
      overlayFor(block).add(track, (g, x, y, w, h) => g.fillRect(x + slider.a * w, y, Math.max(2, (slider.b - slider.a) * w), h), () => slider.on);
      refreshers.push(show);
      // A pad that moves this parameter tells the slider to follow.
      (dependents[spec.key] ??= []).push(show);
      row.append(label, input, track);
      finishRow(row, spec, [spec.key]);
    } else if (spec.kind === "choice" && spec.segmented) {
      row.classList.add("param-segmented");
      const label = document.createElement("label");
      label.textContent = spec.label;
      const seg = document.createElement("div");
      seg.className = "seg";
      seg.id = id;
      const buttons: HTMLButtonElement[] = [];
      const show = () => {
        for (const b of buttons) b.classList.toggle("active", b.value === String(values[spec.key]));
        row.classList.toggle("changed", values[spec.key] !== spec.default);
      };
      for (const o of spec.options) {
        const b = document.createElement("button");
        b.type = "button";
        b.value = o.value;
        b.textContent = o.label;
        b.addEventListener("click", () => {
          if (values[spec.key] === o.value) return;
          values[spec.key] = o.value;
          show();
          changed(spec);
          b.blur();
        });
        buttons.push(b);
        seg.append(b);
      }
      show();
      refreshers.push(show);
      row.append(label, seg);
      finishRow(row, spec, [spec.key]);
    } else if (spec.kind === "choice") {
      const label = document.createElement("label");
      label.htmlFor = id;
      label.textContent = spec.label;
      tags(spec, label);
      const input = document.createElement("select");
      input.id = id;
      for (const o of spec.options) {
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.label;
        input.append(opt);
      }
      const show = () => {
        input.value = String(values[spec.key]);
        row.classList.toggle("changed", values[spec.key] !== spec.default);
      };
      show();
      input.addEventListener("change", () => {
        values[spec.key] = input.value;
        show();
        changed(spec);
        // Hand the keyboard back so Space / R keep driving the simulation.
        input.blur();
      });
      refreshers.push(show);
      row.append(label, input);
      finishRow(row, spec, [spec.key]);
    } else if (spec.kind === "boolean") {
      row.classList.add("param-toggle");
      const label = document.createElement("label");
      label.htmlFor = id;
      label.textContent = spec.label;
      tags(spec, label);
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = id;
      const show = () => {
        input.checked = Boolean(values[spec.key]);
        row.classList.toggle("changed", Boolean(values[spec.key]) !== spec.default);
      };
      show();
      input.addEventListener("change", () => {
        values[spec.key] = input.checked;
        show();
        changed(spec);
      });
      refreshers.push(show);
      row.append(input, label);
      finishRow(row, spec, [spec.key]);
    } else {
      const xs = byKey.get(spec.keys[0]), ys = byKey.get(spec.keys[1]);
      if (!xs || !ys || xs.kind !== "number" || ys.kind !== "number") continue;
      row.classList.add("param-widget");
      const label = document.createElement("label");
      const name = document.createElement("span");
      name.textContent = spec.label;
      label.append(name);
      const readout = document.createElement("div");
      readout.className = "widget-caption";
      const pad = padControl(xs, ys, values, (s) => { notify(s.key); changed(s); }, readout);
      pads.push({ spec, draw: pad.draw });
      refreshers.push(() => pad.draw());
      (dependents[xs.key] ??= []).push(() => pad.draw());
      (dependents[ys.key] ??= []).push(() => pad.draw());
      row.append(label, pad.canvas, readout);
      finishRow(row, spec, spec.keys);
    }
  }
  updateContext();

  return {
    refresh: () => {
      refreshers.forEach((r) => r());
      updateContext();
    },
    setHelp: (on) => container.classList.toggle("show-help", on),
    showRoutes(labels) {
      for (const key in badges) {
        badges[key].textContent = labels[key] ? `♪ ${labels[key]}` : "";
        badges[key].hidden = !labels[key];
      }
    },
    showModulation(effective) {
      // Each block's overlay redraws only when a bar in it moved a visible step.
      const keys = new Map<HTMLElement, string>();
      for (const s of sliders) {
        const v = effective[s.spec.key] as number;
        const base = values[s.spec.key] as number;
        const on = Math.abs(v - base) > 1e-9;
        if (on) {
          s.a = toPos(s.spec, Math.min(v, base));
          s.b = toPos(s.spec, Math.max(v, base));
        }
        if (on !== s.on) {
          s.on = on;
          s.readout.classList.toggle("modulated", on);
        }
        keys.set(s.block, `${keys.get(s.block) ?? ""}${on ? `${Math.round(s.a * 200)}:${Math.round(s.b * 200)}` : "-"}|`);
      }
      for (const [block, key] of keys) {
        const o = overlays.get(block);
        if (!o) continue;
        o.draw(key);
      }
      for (const p of pads) p.draw(effective);
    },
  };
}

/** The pad's height in CSS pixels; its width follows the panel. */
const PAD_HEIGHT = 96;
const PAD_INSET = 7;

/**
 * An XY pad that moves two number parameters at once: left to right is the
 * first, bottom to top the second. A hollow ring shows where modulation has
 * pushed them. Double-click puts both back to their defaults.
 */
function padControl(
  xs: NumberSpec, ys: NumberSpec, values: ParamValues, changed: (spec: NumberSpec) => void, readout: HTMLElement,
): { canvas: HTMLCanvasElement; draw(effective?: ParamValues): void } {
  const canvas = document.createElement("canvas");
  canvas.className = "pad";
  canvas.title = `Drag: left to right sets ${xs.label}, bottom to top sets ${ys.label}. Double-click for the defaults.`;
  let ctx: CanvasRenderingContext2D | null = null;
  let w = 0, h = PAD_HEIGHT;
  let drawn = "";
  const frac = (s: NumberSpec, v: number) => Math.min(1, Math.max(0, (v - s.min) / (s.max - s.min)));
  const px = (x: number) => PAD_INSET + x * (w - 2 * PAD_INSET), py = (y: number) => h - PAD_INSET - y * (h - 2 * PAD_INSET);
  const label = (s: NumberSpec, v: number) => (s.format ? s.format(v, values) : formatNumber(v, s.step));
  const size = () => {
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 220;
    if (width === w && ctx) return;
    w = width;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx = canvas.getContext("2d");
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawn = "";
  };
  const draw = (effective?: ParamValues) => {
    size();
    const g = ctx;
    if (!g) return;
    const bx = frac(xs, values[xs.key] as number), by = frac(ys, values[ys.key] as number);
    const ex = effective ? frac(xs, effective[xs.key] as number) : bx, ey = effective ? frac(ys, effective[ys.key] as number) : by;
    const pushed = Math.abs(ex - bx) > 0.004 || Math.abs(ey - by) > 0.004;
    const key = `${bx.toFixed(3)}|${by.toFixed(3)}|${pushed ? `${ex.toFixed(3)}|${ey.toFixed(3)}` : ""}`;
    if (key === drawn) return;
    drawn = key;
    g.clearRect(0, 0, w, h);
    const style = getComputedStyle(canvas);
    const cyan = style.getPropertyValue("--cyan").trim() || "#2ad4ff";
    const line = style.getPropertyValue("--line").trim() || "rgba(255,255,255,0.1)";
    const muted = style.getPropertyValue("--muted").trim() || "#9cc7cf";
    // A grid, with the defaults' crossing marked.
    g.strokeStyle = line;
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i <= 4; i++) {
      g.moveTo(px(i / 4), PAD_INSET); g.lineTo(px(i / 4), h - PAD_INSET);
      g.moveTo(PAD_INSET, py(i / 4)); g.lineTo(w - PAD_INSET, py(i / 4));
    }
    g.stroke();
    const dx = px(frac(xs, xs.default)), dy = py(frac(ys, ys.default));
    g.strokeStyle = muted;
    g.beginPath();
    g.moveTo(dx - 4, dy); g.lineTo(dx + 4, dy);
    g.moveTo(dx, dy - 4); g.lineTo(dx, dy + 4);
    g.stroke();
    const x = px(bx), y = py(by);
    g.strokeStyle = cyan;
    g.globalAlpha = 0.35;
    g.beginPath();
    g.moveTo(x, PAD_INSET); g.lineTo(x, h - PAD_INSET);
    g.moveTo(PAD_INSET, y); g.lineTo(w - PAD_INSET, y);
    g.stroke();
    g.globalAlpha = 1;
    if (pushed) {
      g.beginPath();
      g.arc(px(ex), py(ey), 5, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = cyan;
    g.beginPath();
    g.arc(x, y, 5, 0, Math.PI * 2);
    g.fill();
    readout.textContent = `${label(xs, values[xs.key] as number)} · ${label(ys, values[ys.key] as number)}`;
  };
  const move = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left - PAD_INSET) / (r.width - 2 * PAD_INSET)));
    const y = Math.max(0, Math.min(1, 1 - (e.clientY - r.top - PAD_INSET) / (r.height - 2 * PAD_INSET)));
    values[xs.key] = fromPos({ ...xs, curve: 1 }, x);
    values[ys.key] = fromPos({ ...ys, curve: 1 }, y);
    draw();
    changed(xs);
    changed(ys);
  };
  let dragging = false;
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    move(e);
  });
  canvas.addEventListener("pointermove", (e) => { if (dragging) move(e); });
  const end = () => { dragging = false; };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("dblclick", () => {
    values[xs.key] = xs.default;
    values[ys.key] = ys.default;
    draw();
    changed(xs);
    changed(ys);
  });
  // The panel may not be laid out yet; draw once it is.
  requestAnimationFrame(() => draw());
  return { canvas, draw };
}

function formatNumber(v: number, step: number): string {
  const decimals = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
  return v.toFixed(decimals);
}
