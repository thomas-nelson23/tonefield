// The home dashboard's type: Sora for text, JetBrains Mono for numbers, Michroma for the wordmark and titles.
import "@fontsource-variable/sora";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource/michroma/latin.css";
import { models, findModel, retiredIds } from "./models/registry";
import { defaultParams, SILENT_MUSIC, type ModelDefinition, type MusicFrame, type ParamSpec, type ParamValues, type PointerInput, type SimulationModel, type Viewport } from "./models/types";
import { renderParamControls, type ParamControls, type ParamLocks } from "./ui/controls";
import { setupPanels, setupRangeFill, setupSidebarToggle } from "./ui/panels";
import { ColourGrade, type Grade } from "./ui/grade";
import { Gfx } from "./gl/gfx";
import { setupUpdater } from "./ui/updater";
import { Studio } from "./music/studio";
import { Explorer, type ModelSnapshot } from "./ui/explore";
import { SWITCH_CHANCE, chance, rollChoice, rollNumber, type RollLevel } from "./roll";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>("canvas");
const stage = $<HTMLElement>("stage");
const g = canvas.getContext("2d")!;
const select = $<HTMLSelectElement>("model-select");
const description = $<HTMLElement>("model-description");
const hint = $<HTMLElement>("model-hint");
const paramsEl = $<HTMLElement>("params");
const playPause = $<HTMLButtonElement>("play-pause");
const stepBtn = $<HTMLButtonElement>("step");
const resetBtn = $<HTMLButtonElement>("reset");
const statsEl = $<HTMLElement>("stats");
const paramsResetBtn = $<HTMLButtonElement>("params-reset");
const helpBtn = $<HTMLButtonElement>("params-help");
const docTitle = $<HTMLElement>("doc-title");
const docState = $<HTMLElement>("doc-state");
const scaleSelect = $<HTMLSelectElement>("render-scale");
const drawSelect = $<HTMLSelectElement>("draw-mode");
const glCanvas = $<HTMLCanvasElement>("canvas-gl");

/**
 * Most simulation steps in one frame. A frame that took longer than this many
 * nominal steps runs the simulation slower rather than later: a heavy model
 * that misses one frame would otherwise run extra steps the next, make that
 * frame later still, and spiral down to a few fps.
 */
const MAX_STEPS_PER_FRAME = 4;
/** Milliseconds of simulation per frame before the loop stops catching up, for the same reason. */
const STEP_BUDGET_MS = 12;
/** The nominal step: frames at 60 Hz step once; faster screens take smaller steps, slower ones more of them. */
const NOMINAL_DT = 1 / 60;
/** Longest single step the models are asked to take; time past it is dropped. */
const MAX_DT = 1 / 30;

/**
 * Render scale: the canvas can be drawn at fewer pixels than the screen has
 * and stretched up. That cuts the models' own drawing time on a big monitor;
 * whether it helps the frame rate depends on the webview: with GPU
 * compositing it does, while a software-composited webview spends as long
 * stretching the picture as it saved. "auto" steps down while the frame
 * rate is under 55, keeps the step only if it helped, and goes back up once
 * 58 has held for a while.
 */
const SCALE_NOTCHES = [1, 0.85, 0.7, 0.6, 0.5];
type ScaleMode = "auto" | "1" | "0.75" | "0.5";
const SCALE_LABELS: Record<ScaleMode, string> = { auto: "Auto", "1": "Full", "0.75": "75%", "0.5": "50%" };

let def: ModelDefinition;
let model: SimulationModel;
/** Slider values, as the user set them. */
let params: ParamValues;
/** What the model sees: slider values pushed by macros and modulation. */
let effective: ParamValues = {};
let paramControls: ParamControls | null = null;
/** Parameters of the current model that Randomize leaves alone, remembered per model. */
let locks = new Set<string>();
/** The one-line descriptions are shown under the controls (otherwise they are tooltips). */
let helpShown = false;
let paramSaveTimer = 0;
/** What the music is doing this frame, as the model sees it. */
let music: MusicFrame = SILENT_MUSIC;
let view: Viewport = { width: 1, height: 1 };
let running = true;
let lastTime = performance.now();
let fps = 0;
let statsShown = 0;
/** Smoothed milliseconds per frame spent stepping and drawing, for the status bar. */
let simMs = 0;
let drawMs = 0;
/** The canvas shows something older than the model's state, so the next frame must draw. */
let dirty = true;
let scaleMode: ScaleMode = "auto";
/** The canvas's pixels per CSS pixel, as a share of the screen's. */
let renderScale = 1;
/** Auto scale: frames and their total time since the last decision, and how long a raise has to wait. */
const auto = { frames: 0, ms: 0, since: 0, steady: 0, raiseWait: 3, raisedAt: -Infinity, lowerWait: 0, before: 0 };

const studio = new Studio();
const grade = new ColourGrade(canvas);

/**
 * GPU drawing: models with a `renderGL` draw with WebGL on their own canvas
 * when the Drawing setting is GPU, which it is unless the user picked CPU.
 * Made the first time it's needed; null where WebGL 2 is missing, and dropped
 * for good if the GPU loses the context, so the app carries on on the CPU.
 */
type DrawMode = "gpu" | "cpu";
let drawMode: DrawMode = "gpu";
let gfx: Gfx | null = null;
let gfxTried = false;
/** The model is drawing with `gfx` now. */
let onGpu = false;
/** The grade last shown on the GPU canvas, so an unchanged frame isn't shown again. */
let gpuGrade = "";
const NEUTRAL_GRADE: Grade = { hue: 0, saturation: 1, brightness: 1, contrast: 1, invert: false };

glCanvas.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();
  console.warn("WebGL context lost; drawing on the CPU from now on.");
  gfx = null;
  useDrawing();
});

/** Pick the canvas the current model draws on, and show only that one. */
function useDrawing(): void {
  if (drawMode === "gpu" && !gfxTried) {
    gfxTried = true;
    gfx = Gfx.create(glCanvas);
    if (gfx) sizeGfx();
  }
  const gpu = drawMode === "gpu" && !!gfx && !!model?.renderGL;
  if (gpu !== onGpu) {
    onGpu = gpu;
    // The 2D canvas's colour overlay goes too, and comes back on its next frame.
    if (gpu) grade.draw(NEUTRAL_GRADE, true);
    canvas.hidden = gpu;
    glCanvas.hidden = !gpu;
  }
  if (gpu) clearGfx();
  gpuGrade = "";
  dirty = true;
}

function clearGfx(): void {
  if (!gfx) return;
  gfx.begin();
  gfx.clear();
  gfx.flush();
}

function sizeGfx(): void {
  if (!gfx) return;
  const dpr = (window.devicePixelRatio || 1) * renderScale;
  glCanvas.width = canvas.width;
  glCanvas.height = canvas.height;
  glCanvas.style.width = canvas.style.width;
  glCanvas.style.height = canvas.style.height;
  gfx.resize(canvas.width, canvas.height, dpr);
}

function setDrawMode(mode: DrawMode): void {
  drawMode = mode;
  drawSelect.value = mode;
  useDrawing();
  try {
    localStorage.setItem("ui:drawMode", mode);
  } catch {
    // Only a convenience.
  }
}

// ---- Model selection -------------------------------------------------------

function populateModelSelect(): void {
  const byCategory = new Map<string, ModelDefinition[]>();
  for (const m of models) {
    const list = byCategory.get(m.category) ?? [];
    list.push(m);
    byCategory.set(m.category, list);
  }
  for (const [category, list] of byCategory) {
    const group = document.createElement("optgroup");
    group.label = category;
    for (const m of list) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      group.append(opt);
    }
    select.append(group);
  }
}

function loadModel(id: string): void {
  def = findModel(id) ?? models[0];
  select.value = def.id;
  params = loadParams(def);
  effective = { ...params };
  model = def.create();
  model.reset(view, effective);
  dirty = true;
  // Models that paint their own background would otherwise fade in over the previous one.
  g.fillStyle = "#0d1117";
  g.fillRect(0, 0, view.width, view.height);
  useDrawing();
  description.textContent = def.description;
  docTitle.textContent = def.name;
  hint.textContent = def.hint ?? "No canvas interaction for this model.";
  const onChange = (spec: ParamSpec) => {
    if (spec.resetOnChange) {
      effective[spec.key] = params[spec.key];
      model.reset(view, effective);
      dirty = true;
    }
    saveParams();
  };
  locks = loadLocks(def);
  const lockHooks: ParamLocks = { keys: locks, changed: () => saveLocks(def) };
  const controls = (paramControls = renderParamControls(paramsEl, def.params, params, onChange, "", lockHooks, { ...studio.sliderHooks(""), help: helpShown }));
  studio.setModel(def, params, controls, onChange);
  try {
    localStorage.setItem("lastModel", def.id);
  } catch {
    // Storage can be unavailable; remembering the model is only a convenience.
  }
}

/**
 * The model's slider values as last set, or its defaults. Anything saved
 * that the model no longer has, or that is out of range, is dropped.
 */
function loadParams(d: ModelDefinition): ParamValues {
  const values = defaultParams(d);
  try {
    const saved = JSON.parse(localStorage.getItem(`params:${d.id}`) ?? "null") as ParamValues | null;
    if (!saved || typeof saved !== "object") return values;
    for (const spec of d.params) {
      const v = saved[spec.key];
      if (spec.kind === "number" && typeof v === "number" && Number.isFinite(v)) values[spec.key] = Math.min(spec.max, Math.max(spec.min, v));
      else if (spec.kind === "boolean" && typeof v === "boolean") values[spec.key] = v;
      else if (spec.kind === "choice" && spec.options.some((o) => o.value === v)) values[spec.key] = v as string;
    }
  } catch {
    // Defaults it is.
  }
  return values;
}

/** Save the slider values soon: a drag calls this many times a second. */
function saveParams(): void {
  if (paramSaveTimer) return;
  paramSaveTimer = window.setTimeout(() => {
    paramSaveTimer = 0;
    try {
      const defaults = defaultParams(def);
      const changed = Object.keys(params).some((k) => params[k] !== defaults[k]);
      if (changed) localStorage.setItem(`params:${def.id}`, JSON.stringify(params));
      else localStorage.removeItem(`params:${def.id}`);
    } catch {
      // Only a convenience.
    }
  }, 300);
}

/** Put every parameter of the model back to its default. */
function resetParams(): void {
  const defaults = defaultParams(def);
  let rebuild = false;
  for (const spec of def.params) {
    if (spec.kind === "widget" || params[spec.key] === defaults[spec.key]) continue;
    params[spec.key] = defaults[spec.key];
    if (spec.resetOnChange) rebuild = true;
  }
  paramControls?.refresh();
  if (rebuild) {
    effective = { ...params };
    model.reset(view, effective);
    dirty = true;
  }
  saveParams();
}

function loadLocks(d: ModelDefinition): Set<string> {
  try {
    const keys = JSON.parse(localStorage.getItem(`ui:locks:${d.id}`) ?? "[]") as string[];
    return new Set(keys.filter((k) => d.params.some((p) => p.key === k)));
  } catch {
    return new Set();
  }
}

function saveLocks(d: ModelDefinition): void {
  try {
    if (locks.size) localStorage.setItem(`ui:locks:${d.id}`, JSON.stringify([...locks]));
    else localStorage.removeItem(`ui:locks:${d.id}`);
  } catch {
    // Only a convenience.
  }
}

/**
 * Roll every unlocked slider of the model as far as the level allows (see
 * roll.ts): Nudge and Shake move from where they are, Roll lands inside each
 * slider's `random` band, Wild anywhere. Dropdowns and switches flip with the
 * level's chance. The rebuild controls (counts, resolution and so on) only
 * roll at Wild, and then between their minimum and half again their default
 * so a roll never stalls the frame rate; `live` (the dice rolling by
 * themselves) leaves them alone at every level. Returns how many changed.
 */
function rollParams(level: RollLevel, live: boolean): number {
  let rebuild = false;
  let changed = 0;
  for (const spec of def.params) {
    // The global controls and the matrix set the hidden ones.
    if (spec.kind === "widget" || spec.hidden || locks.has(spec.key)) continue;
    if (spec.resetOnChange && (level < 3 || live)) continue;
    const before = params[spec.key];
    if (spec.kind === "number") {
      const band: [number, number] | undefined = spec.resetOnChange
        ? [spec.min, Math.min(spec.max, Math.max(spec.min + spec.step, spec.default * 1.5))]
        : spec.random;
      params[spec.key] = spec.resetOnChange ? rollNumber(spec, before as number, 2, band) : rollNumber(spec, before as number, level, band);
    } else if (spec.kind === "choice") {
      params[spec.key] = rollChoice(spec, before as string, level);
    } else if (chance(SWITCH_CHANCE[level])) {
      params[spec.key] = !before;
    }
    if (params[spec.key] === before) continue;
    changed++;
    if (spec.resetOnChange) {
      effective[spec.key] = params[spec.key];
      rebuild = true;
    }
  }
  paramControls?.refresh();
  if (rebuild) {
    model.reset(view, effective);
    dirty = true;
  }
  saveParams();
  return changed;
}

/** The model and its slider values, for the Explore panel's undo. */
function snapshotModel(): ModelSnapshot {
  return { id: def.id, params: { ...params } };
}

/** Put the model and its sliders back; the picture only starts over if a rebuild control differs. */
function restoreModel(s: ModelSnapshot): void {
  if (s.id !== def.id) loadModel(s.id);
  let rebuild = false;
  for (const spec of def.params) {
    if (spec.kind === "widget" || !(spec.key in s.params) || params[spec.key] === s.params[spec.key]) continue;
    // In place: the studio pushes macros and routes onto this same object.
    params[spec.key] = s.params[spec.key];
    if (spec.resetOnChange) rebuild = true;
  }
  paramControls?.refresh();
  if (rebuild) {
    effective = { ...params };
    model.reset(view, effective);
    dirty = true;
  }
  saveParams();
}

// ---- Canvas sizing ---------------------------------------------------------

/** Size the canvas to the stage at the render scale; tells the model only when the stage itself changed. */
function resize(): void {
  const dpr = (window.devicePixelRatio || 1) * renderScale;
  const rect = stage.getBoundingClientRect();
  const changed = rect.width !== view.width || rect.height !== view.height;
  view = { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
  canvas.width = Math.max(1, Math.round(view.width * dpr));
  canvas.height = Math.max(1, Math.round(view.height * dpr));
  canvas.style.width = `${view.width}px`;
  canvas.style.height = `${view.height}px`;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  sizeGfx();
  gpuGrade = "";
  dirty = true;
  if (!model || !changed) return;
  if (model.resize) model.resize(view);
  else model.reset(view, effective);
}

/** Change the render scale, keeping the picture: the canvas is cleared by the resize, so the model redraws from its state. */
function setRenderScale(scale: number): void {
  if (scale === renderScale) return;
  renderScale = scale;
  resize();
}

function setScaleMode(mode: ScaleMode): void {
  scaleMode = mode;
  scaleSelect.value = mode;
  auto.frames = auto.ms = auto.steady = auto.before = 0;
  if (mode !== "auto") setRenderScale(Number(mode));
  try {
    localStorage.setItem("ui:renderScale", mode);
  } catch {
    // Only a convenience.
  }
}

/**
 * Auto mode, once a second: step the scale down while frames take longer than
 * 55 a second allow, and back up after 58 has held for a while. A step down
 * that didn't make frames at least a tenth faster is undone, and the next try
 * waits longer each time: where the webview's own repaint is the cost, fewer
 * canvas pixels don't help and only soften the picture. A raise that is undone
 * soon after also makes the next one wait twice as long, so a scene on the
 * edge settles instead of flickering between two sizes.
 */
function autoScale(frameMs: number): void {
  auto.frames++;
  auto.ms += frameMs;
  auto.since += frameMs;
  if (auto.since < 1000) return;
  const avg = auto.ms / auto.frames;
  auto.frames = auto.ms = auto.since = 0;
  const notch = SCALE_NOTCHES.indexOf(renderScale);
  const now = performance.now() / 1000;
  if (auto.before > 0) {
    // The frame after a step down: keep it only if it paid off.
    const helped = avg < auto.before * 0.9;
    auto.before = 0;
    if (!helped) {
      setRenderScale(SCALE_NOTCHES[notch - 1]);
      auto.lowerWait = Math.min(120, Math.max(10, auto.lowerWait * 2));
      auto.steady = 0;
      return;
    }
  }
  if (avg > 1000 / 55) {
    auto.steady = 0;
    if (auto.lowerWait > 0) auto.lowerWait--;
    else if (notch < SCALE_NOTCHES.length - 1) {
      if (now - auto.raisedAt < 5) auto.raiseWait = Math.min(60, auto.raiseWait * 2);
      auto.before = avg;
      setRenderScale(SCALE_NOTCHES[notch + 1]);
    }
  } else if (avg <= 1000 / 58) {
    auto.steady += 1;
    if (notch > 0 && auto.steady >= auto.raiseWait) {
      auto.steady = 0;
      auto.raisedAt = now;
      setRenderScale(SCALE_NOTCHES[notch - 1]);
    }
  } else {
    auto.steady = 0;
  }
}

// ---- Input -----------------------------------------------------------------

function sendPointer(type: PointerInput["type"], e: PointerEvent): void {
  if (!running && type === "move" && e.buttons === 0) return;
  const rect = stage.getBoundingClientRect();
  model.onPointer?.(
    {
      type,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      button: e.button,
      pressed: e.buttons !== 0,
      shift: e.shiftKey,
    },
    effective,
  );
}

// On the stage rather than the canvas: while the colour controls are in use the
// canvas hides under the overlay that shows it.
stage.addEventListener("pointerdown", (e) => {
  stage.setPointerCapture(e.pointerId);
  sendPointer("down", e);
});
stage.addEventListener("pointermove", (e) => sendPointer("move", e));
stage.addEventListener("pointerup", (e) => sendPointer("up", e));
stage.addEventListener("contextmenu", (e) => e.preventDefault());
// The webview's own right-click menu (Back, Reload, Print on Windows) only gets
// in the way; text fields keep theirs for copy and paste.
document.addEventListener("contextmenu", (e) => {
  if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) e.preventDefault();
});

/** Pausing the simulation pauses the music too, and playing resumes whatever was playing. */
function setRunning(value: boolean): void {
  if (value !== running) studio.setPaused(!value);
  running = value;
  playPause.textContent = running ? "Pause" : "Play";
  playPause.classList.toggle("paused", !running);
  docState.textContent = running ? "" : "Paused";
  stepBtn.disabled = running;
}

playPause.addEventListener("click", () => setRunning(!running));
const stepOnce = () => {
  model.step(NOMINAL_DT, effective, music);
  dirty = true;
};
const resetModel = () => {
  model.reset(view, effective);
  dirty = true;
};
stepBtn.addEventListener("click", stepOnce);
resetBtn.addEventListener("click", resetModel);
scaleSelect.addEventListener("change", () => {
  setScaleMode(scaleSelect.value as ScaleMode);
  scaleSelect.blur();
});
drawSelect.addEventListener("change", () => {
  setDrawMode(drawSelect.value as DrawMode);
  drawSelect.blur();
});
select.addEventListener("change", () => loadModel(select.value));
paramsResetBtn.addEventListener("click", () => {
  resetParams();
  paramsResetBtn.blur();
});
helpBtn.addEventListener("click", () => {
  helpShown = !helpShown;
  helpBtn.classList.toggle("on", helpShown);
  helpBtn.setAttribute("aria-pressed", String(helpShown));
  paramControls?.setHelp(helpShown);
  studio.setHelp(helpShown);
  try {
    localStorage.setItem("ui:showHelp", helpShown ? "1" : "0");
  } catch {
    // Only a convenience.
  }
  helpBtn.blur();
});

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === "Space") { e.preventDefault(); setRunning(!running); }
  else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); studio.toggleSequencer(); }
  else if (e.key === "r") resetModel();
  else if (e.key === "d" && !e.ctrlKey && !e.metaKey && !e.altKey) explorer.roll("visuals");
  else if (e.key === "m" && !e.ctrlKey && !e.metaKey && !e.altKey) explorer.roll("music");
  else if (e.key === "z" && !e.ctrlKey && !e.metaKey && !e.altKey) explorer.undo();
  else if (e.key === "Z" && !e.ctrlKey && !e.metaKey && !e.altKey) explorer.redo();
  else if (e.key.toLowerCase() === "s" && !e.ctrlKey && !e.metaKey && !e.altKey) toggleSidebar();
  else if (e.key === "." && !running) stepOnce();
});

// ---- Main loop -------------------------------------------------------------

function frame(now: number): void {
  const elapsed = Math.min((now - lastTime) / 1000, 0.25);
  lastTime = now;
  fps = fps * 0.9 + (elapsed > 0 ? 1 / elapsed : 0) * 0.1;
  if (scaleMode === "auto") autoScale(elapsed * 1000);

  const notes = studio.frame(now / 1000, elapsed);
  explorer.frame(studio.bars());
  studio.apply(effective);
  music = studio.music();
  if (running && model.onNote) {
    for (const n of notes) {
      const k = studio.reaction(n.role);
      if (k > 0) model.onNote(k === 1 ? n : { ...n, velocity: n.velocity * k }, effective);
    }
  }

  if (running && elapsed > 0) {
    // The simulation advances by the time the frame took, in steps no longer
    // than a 30th of a second (and ideally a 60th) so the physics stay stable:
    // a 244 Hz screen takes one small step a frame and moves just as smoothly,
    // a slow frame takes a few. Time the budget can't cover is dropped.
    const steps = Math.min(MAX_STEPS_PER_FRAME, Math.max(1, Math.ceil(elapsed / NOMINAL_DT - 1e-6)));
    const dt = Math.min(MAX_DT, elapsed / steps);
    const start = performance.now();
    for (let i = 0; i < steps; i++) {
      if (i > 0 && performance.now() - start > STEP_BUDGET_MS) break;
      model.step(dt, effective, music);
    }
    simMs += (performance.now() - start - simMs) * 0.1;
    dirty = true;
  }

  // Nothing moved (paused, or a screen refreshing faster than the model steps):
  // drawing again would only stack the models' additive strokes up on an unfaded picture.
  if (onGpu && gfx) {
    const look = studio.grade();
    const key = `${look.hue}|${look.saturation}|${look.brightness}|${look.contrast}|${look.invert}`;
    if (dirty) {
      dirty = false;
      const drawStart = performance.now();
      gfx.begin();
      if (!def.paintsBackground) gfx.clear();
      model.renderGL!(gfx, view, effective, music);
      gfx.show(look);
      drawMs += (performance.now() - drawStart - drawMs) * 0.1;
    } else if (key !== gpuGrade) {
      gfx.show(look);
    }
    gpuGrade = key;
  } else if (dirty) {
    dirty = false;
    const drawStart = performance.now();
    if (!def.paintsBackground) {
      g.fillStyle = "#0d1117";
      g.fillRect(0, 0, view.width, view.height);
    }
    model.render(g, view, effective, music);
    grade.draw(studio.grade(), true);
    drawMs += (performance.now() - drawStart - drawMs) * 0.1;
  } else {
    grade.draw(studio.grade(), false);
  }

  // A few times a second is plenty, and saves a sidebar re-layout every frame.
  if (now - statsShown > 250) {
    statsShown = now;
    const extra = model.stats?.();
    const scale = renderScale < 1 ? ` · drawn at ${Math.round(renderScale * 100)}%` : "";
    statsEl.textContent = `${Math.round(fps)} fps · ${onGpu ? "GPU" : "CPU"}${scale} · sim ${simMs.toFixed(1)} ms · draw ${drawMs.toFixed(1)} ms${extra ? ` · ${extra}` : ""}`;
    (window as unknown as { __perf: unknown }).__perf = { fps, simMs, drawMs, renderScale, model: def.id, gpu: onGpu, level: music.level };
  }
  requestAnimationFrame(frame);
}

// ---- Boot ------------------------------------------------------------------

setupPanels();
const toggleSidebar = setupSidebarToggle();
populateModelSelect();
for (const [value, label] of Object.entries(SCALE_LABELS)) {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label;
  scaleSelect.append(opt);
}
{
  let mode: ScaleMode = "auto";
  try {
    const saved = localStorage.getItem("ui:renderScale");
    if (saved && saved in SCALE_LABELS) mode = saved as ScaleMode;
  } catch {
    // Auto it is.
  }
  setScaleMode(mode);
}
{
  let mode: DrawMode = "gpu";
  try {
    if (localStorage.getItem("ui:drawMode") === "cpu") mode = "cpu";
  } catch {
    // GPU it is.
  }
  drawMode = mode;
  drawSelect.value = mode;
}
resize();
try {
  helpShown = localStorage.getItem("ui:showHelp") === "1";
} catch {
  // Tooltips it is.
}
helpBtn.classList.toggle("on", helpShown);
helpBtn.setAttribute("aria-pressed", String(helpShown));
studio.setHelp(helpShown);
let initial = models[0].id;
try {
  initial = localStorage.getItem("lastModel") ?? initial;
  // Settings of models that were replaced (Fabric, now Branches) are no use to anything.
  for (const id of retiredIds) for (const key of [`params:${id}`, `ui:locks:${id}`, `music:model:${id}`]) localStorage.removeItem(key);
} catch {
  // Fall back to the first model.
}
loadModel(initial);
const explorer = new Explorer({
  studio,
  modelId: () => def.id,
  modelName: (id) => findModel(id)?.name ?? id,
  modelIds: () => models.map((m) => m.id),
  setModel: loadModel,
  rollParams,
  snapshotModel,
  restoreModel,
});
setRunning(true);
setupRangeFill();
setupUpdater();
new ResizeObserver(resize).observe(stage);
requestAnimationFrame(frame);
