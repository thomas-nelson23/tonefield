import { models, findModel } from "./models/registry";
import { defaultParams, SILENT_MUSIC, type ModelDefinition, type MusicFrame, type ParamSpec, type ParamValues, type PointerInput, type SimulationModel, type Viewport } from "./models/types";
import { renderParamControls, type ParamControls } from "./ui/controls";
import { setupPanels } from "./ui/panels";
import { ColourGrade } from "./ui/grade";
import { Studio } from "./music/studio";

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
const randomizeBtn = $<HTMLButtonElement>("randomize");
const docTitle = $<HTMLElement>("doc-title");
const docState = $<HTMLElement>("doc-state");

const MAX_STEPS_PER_FRAME = 8;
/**
 * Milliseconds of simulation per frame before the loop stops catching up.
 * Without it a heavy model that misses one frame runs extra steps the next,
 * which makes that frame later still, and it spirals down to a few fps.
 */
const STEP_BUDGET_MS = 12;

let def: ModelDefinition;
let model: SimulationModel;
/** Slider values, as the user set them. */
let params: ParamValues;
/** What the model sees: slider values pushed by macros and modulation. */
let effective: ParamValues = {};
let paramControls: ParamControls | null = null;
/** What the music is doing this frame, as the model sees it. */
let music: MusicFrame = SILENT_MUSIC;
let view: Viewport = { width: 1, height: 1 };
let running = true;
let accumulator = 0;
let lastTime = performance.now();
let fps = 0;
let statsShown = 0;

const studio = new Studio();
const grade = new ColourGrade(canvas);

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
  params = defaultParams(def);
  effective = { ...params };
  model = def.create();
  model.reset(view, effective);
  accumulator = 0;
  // Models that paint their own background would otherwise fade in over the previous one.
  g.fillStyle = "#0d1117";
  g.fillRect(0, 0, view.width, view.height);
  description.textContent = def.description;
  docTitle.textContent = def.name;
  hint.textContent = def.hint ?? "No canvas interaction for this model.";
  const onChange = (spec: ParamSpec) => {
    if (spec.resetOnChange) {
      effective[spec.key] = params[spec.key];
      model.reset(view, effective);
    }
  };
  const controls = (paramControls = renderParamControls(paramsEl, def.params, params, onChange));
  studio.setModel(def, params, controls, onChange);
  try {
    localStorage.setItem("lastModel", def.id);
  } catch {
    // Storage can be unavailable; remembering the model is only a convenience.
  }
}

/**
 * Give every parameter of the model a random value. Setup sizes (particle and
 * bird counts, grains and so on) stay between their minimum and half again
 * their default, so a roll never stalls the frame rate.
 */
function randomizeParams(): void {
  let rebuild = false;
  for (const spec of def.params) {
    // The global controls set these.
    if (spec.hidden) continue;
    const before = params[spec.key];
    if (spec.kind === "number") {
      const max = spec.resetOnChange ? Math.min(spec.max, Math.max(spec.min + spec.step, (spec.default as number) * 1.5)) : spec.max;
      const steps = Math.floor((max - spec.min) / spec.step + 1e-9);
      params[spec.key] = Number((spec.min + Math.round(Math.random() * steps) * spec.step).toFixed(6));
    } else if (spec.kind === "choice") {
      params[spec.key] = spec.options[Math.floor(Math.random() * spec.options.length)].value;
    } else {
      params[spec.key] = Math.random() < 0.5;
    }
    if (spec.resetOnChange && params[spec.key] !== before) {
      effective[spec.key] = params[spec.key];
      rebuild = true;
    }
  }
  paramControls?.refresh();
  if (rebuild) model.reset(view, effective);
}

// ---- Canvas sizing ---------------------------------------------------------

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = stage.getBoundingClientRect();
  view = { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
  canvas.width = Math.round(view.width * dpr);
  canvas.height = Math.round(view.height * dpr);
  canvas.style.width = `${view.width}px`;
  canvas.style.height = `${view.height}px`;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!model) return;
  if (model.resize) model.resize(view);
  else model.reset(view, effective);
}

// ---- Input -----------------------------------------------------------------

function sendPointer(type: PointerInput["type"], e: PointerEvent): void {
  if (!running && type === "move" && e.buttons === 0) return;
  const rect = canvas.getBoundingClientRect();
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
  docState.textContent = running ? "" : "Paused";
  stepBtn.disabled = running;
}

playPause.addEventListener("click", () => setRunning(!running));
stepBtn.addEventListener("click", () => model.step(def.fixedDt ?? 1 / 60, effective, music));
resetBtn.addEventListener("click", () => model.reset(view, effective));
select.addEventListener("change", () => loadModel(select.value));
randomizeBtn.addEventListener("click", () => {
  randomizeParams();
  randomizeBtn.blur();
});

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === "Space") { e.preventDefault(); setRunning(!running); }
  else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); studio.toggleSequencer(); }
  else if (e.key === "r") model.reset(view, effective);
  else if (e.key === "." && !running) model.step(def.fixedDt ?? 1 / 60, effective, music);
});

// ---- Main loop -------------------------------------------------------------

function frame(now: number): void {
  const elapsed = Math.min((now - lastTime) / 1000, 0.25);
  lastTime = now;
  fps = fps * 0.9 + (elapsed > 0 ? 1 / elapsed : 0) * 0.1;

  const notes = studio.frame(now / 1000, elapsed);
  studio.apply(effective);
  music = studio.music();
  if (running && model.onNote) for (const n of notes) if (studio.reacts(n.role)) model.onNote(n, effective);

  if (running) {
    // Fixed-timestep integration keeps physics stable on 60Hz and 120Hz screens alike.
    const dt = def.fixedDt ?? 1 / 60;
    accumulator += elapsed;
    let steps = 0;
    const start = performance.now();
    while (accumulator >= dt) {
      if (steps === MAX_STEPS_PER_FRAME || (steps > 0 && performance.now() - start > STEP_BUDGET_MS)) {
        accumulator = 0; // drop time rather than spiral
        break;
      }
      model.step(dt, effective, music);
      accumulator -= dt;
      steps++;
    }
  }

  if (!def.paintsBackground) {
    g.fillStyle = "#0d1117";
    g.fillRect(0, 0, view.width, view.height);
  }
  model.render(g, view, effective, music);
  grade.draw(studio.grade());

  // A few times a second is plenty, and saves a sidebar re-layout every frame.
  if (now - statsShown > 250) {
    statsShown = now;
    const extra = model.stats?.();
    statsEl.textContent = `${Math.round(fps)} fps${extra ? ` · ${extra}` : ""}`;
  }
  requestAnimationFrame(frame);
}

// ---- Boot ------------------------------------------------------------------

setupPanels();
populateModelSelect();
resize();
let initial = models[0].id;
try {
  initial = localStorage.getItem("lastModel") ?? initial;
} catch {
  // Fall back to the first model.
}
loadModel(initial);
setRunning(true);
new ResizeObserver(resize).observe(stage);
requestAnimationFrame(frame);
