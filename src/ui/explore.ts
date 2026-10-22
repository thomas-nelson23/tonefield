import type { ParamValues } from "../models/types";
import type { Studio, StudioSnapshot } from "../music/studio";
import { DICE_ICON, LEVELS, LOCK_ICON, chance, type RollLevel } from "../roll";

/**
 * The Explore panel: one set of dice for the whole app. A roll changes every
 * category that isn't locked (the model, its sliders, the macros, the global
 * controls, the modulation matrix, the music), as far as the level allows,
 * and every roll can be undone and redone, so exploring is a matter of
 * rolling, locking what you like, and rolling again. Each category also has
 * a die of its own, and the dice can roll by themselves every so many bars.
 *
 * All of its DOM work happens on a click or a roll, never per frame (see the
 * repaint notes in music/studio.ts).
 */

export type Category = "model" | "params" | "macros" | "globals" | "modulation" | "music";

const CATEGORIES: { id: Category; label: string; hint: string }[] = [
  { id: "model", label: "Model", hint: "Switch to another model. Shake does it now and then, Roll about half the time, Wild always." },
  { id: "params", label: "Parameters", hint: "The model's sliders, inside their useful bands. Ones you've padlocked stay put. Rebuild sizes (counts, resolution) only move at Wild." },
  { id: "macros", label: "Macros", hint: "The model's macros: a few pushed, the rest at zero." },
  { id: "globals", label: "Global controls", hint: "Colour, gravity, energy and trails; sometimes one of the built-in presets." },
  { id: "modulation", label: "Modulation", hint: "The modulation matrix: route amounts and built-in strengths drift, and at Roll the routes themselves change." },
  { id: "music", label: "Music", hint: "The sequencer: a new idea, then the style, key, tempo and sounds as the level allows. Mutes, holds and the mixer stay yours." },
];

/** Bars between rolls when the dice roll by themselves. */
const AUTO_CHOICES = [0, 2, 4, 8, 16, 32];
const HISTORY = 40;

/** How likely a roll is to switch model at each level (a category's own die always does). */
const MODEL_CHANCE = [0, 0.25, 0.5, 1];

interface ExploreSettings {
  level: RollLevel;
  locked: Category[];
  auto: number;
}

/** What the host (main.ts) keeps of a model: which one, and its slider values. */
export interface ModelSnapshot {
  id: string;
  params: ParamValues;
}

interface Snapshot {
  model: ModelSnapshot;
  studio: StudioSnapshot;
}

/** What the panel needs from the host. */
export interface ExploreHost {
  studio: Studio;
  modelId(): string;
  modelName(id: string): string;
  modelIds(): string[];
  /** Load another model (its own saved sliders come with it). */
  setModel(id: string): void;
  /** Roll the model's unlocked sliders; `live` skips the ones that rebuild the model. Returns how many changed. */
  rollParams(level: RollLevel, live: boolean): number;
  snapshotModel(): ModelSnapshot;
  restoreModel(s: ModelSnapshot): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class Explorer {
  private settings: ExploreSettings = { level: 2, locked: [], auto: 0 };
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];
  private lastBar = -1;
  private levelButtons: HTMLButtonElement[] = [];
  private lockButtons = new Map<Category, HTMLButtonElement>();

  constructor(private host: ExploreHost) {
    this.load();
    this.build();
  }

  private load(): void {
    try {
      const saved = JSON.parse(localStorage.getItem("ui:explore") ?? "null") as Partial<ExploreSettings> | null;
      if (!saved) return;
      if (typeof saved.level === "number" && saved.level >= 0 && saved.level < LEVELS.length) this.settings.level = Math.round(saved.level) as RollLevel;
      if (Array.isArray(saved.locked)) this.settings.locked = saved.locked.filter((c) => CATEGORIES.some((k) => k.id === c));
      if (typeof saved.auto === "number" && AUTO_CHOICES.includes(saved.auto)) this.settings.auto = saved.auto;
    } catch {
      // The defaults it is.
    }
  }

  private save(): void {
    try {
      localStorage.setItem("ui:explore", JSON.stringify(this.settings));
    } catch {
      // Only a convenience.
    }
  }

  get level(): RollLevel {
    return this.settings.level;
  }

  locked(c: Category): boolean {
    return this.settings.locked.includes(c);
  }

  // ---- Rolling -------------------------------------------------------------

  /** Roll every unlocked category. `live` is a roll the dice made by themselves: nothing rebuilds the model. */
  roll(live = false): void {
    const cats = CATEGORIES.map((c) => c.id).filter((c) => !this.locked(c));
    if (cats.length === 0) {
      this.showLast("Everything is locked: unlock a category to roll it.");
      return;
    }
    this.rollCategories(cats, live, false);
  }

  /** Roll one category whether or not it's locked, from its own die. */
  rollOne(c: Category): void {
    this.rollCategories([c], false, true);
  }

  private rollCategories(cats: Category[], live: boolean, forced: boolean): void {
    const level = this.settings.level;
    const studio = this.host.studio;
    this.remember();
    const done: string[] = [];
    const note = (label: string, detail: string | null) => done.push(detail ? `${label} (${detail})` : label);
    if (cats.includes("model") && (forced || chance(MODEL_CHANCE[level]))) {
      const ids = this.host.modelIds();
      const from = this.host.modelId();
      const to = ids.filter((id) => id !== from)[Math.floor(Math.random() * (ids.length - 1))] ?? from;
      if (to !== from) {
        this.host.setModel(to);
        note("Model", `${this.host.modelName(from)} → ${this.host.modelName(to)}`);
      }
    }
    if (cats.includes("params")) {
      const n = this.host.rollParams(level, live);
      note("Parameters", n === 0 ? "none free" : `${n}`);
    }
    if (cats.includes("macros")) {
      const d = studio.rollMacros(level);
      if (d !== null) note("Macros", d);
    }
    if (cats.includes("globals")) note("Globals", studio.rollGlobals(level));
    if (cats.includes("modulation")) note("Modulation", studio.rollModulation(level));
    if (cats.includes("music")) note("Music", studio.rollMusic(level));
    this.showLast(done.length ? `${LEVELS[level].name}: ${done.join(" · ")}` : `${LEVELS[level].name}: nothing changed this time.`);
  }

  private snapshot(): Snapshot {
    return { model: this.host.snapshotModel(), studio: this.host.studio.snapshot() };
  }

  private restore(s: Snapshot): void {
    this.host.restoreModel(s.model);
    this.host.studio.restore(s.studio);
  }

  /** Keep how things are now, so the roll can be undone. A new roll ends any redo. */
  private remember(): void {
    this.past.push(this.snapshot());
    if (this.past.length > HISTORY) this.past.shift();
    this.future = [];
    this.showHistory();
  }

  undo(): void {
    const s = this.past.pop();
    if (!s) return;
    this.future.push(this.snapshot());
    this.restore(s);
    this.showHistory();
    this.showLast(`Back one roll. ${this.past.length ? `${this.past.length} more to go back to.` : ""}`.trim());
  }

  redo(): void {
    const s = this.future.pop();
    if (!s) return;
    this.past.push(this.snapshot());
    this.restore(s);
    this.showHistory();
    this.showLast("Forward one roll.");
  }

  /** Called every frame with the musical time in bars: rolls again when the auto setting says so. */
  frame(bars: number): void {
    const every = this.settings.auto;
    if (every === 0) return;
    const bar = Math.floor(bars / every);
    if (bar === this.lastBar) return;
    // The first bar after switching Auto on only starts the count.
    const first = this.lastBar < 0;
    this.lastBar = bar;
    if (!first) this.roll(true);
  }

  // ---- The panel -------------------------------------------------------------

  private build(): void {
    const s = this.settings;
    const rollButtons = [$<HTMLButtonElement>("roll"), $<HTMLButtonElement>("explore-roll")];
    for (const b of rollButtons) {
      b.innerHTML = `${DICE_ICON}<span>Roll</span>`;
      b.addEventListener("click", () => { this.roll(); b.blur(); });
    }
    $("undo").addEventListener("click", () => { this.undo(); $("undo").blur(); });
    $("redo").addEventListener("click", () => { this.redo(); $("redo").blur(); });

    // How far a roll goes.
    const levels = $("explore-level");
    const hint = $("explore-level-hint");
    const showLevel = () => {
      this.levelButtons.forEach((b, i) => b.classList.toggle("active", i === s.level));
      hint.textContent = LEVELS[s.level].hint;
    };
    LEVELS.forEach((l, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = l.name;
      b.title = l.hint;
      b.addEventListener("click", () => {
        s.level = i as RollLevel;
        showLevel();
        this.save();
        b.blur();
      });
      this.levelButtons.push(b);
      levels.append(b);
    });
    showLevel();

    // The categories, each with a padlock and a die of its own.
    const list = $("explore-categories");
    for (const c of CATEGORIES) {
      const row = document.createElement("div");
      row.className = "explore-cat";
      row.title = c.hint;
      const lock = document.createElement("button");
      lock.type = "button";
      lock.className = "lock";
      lock.innerHTML = LOCK_ICON;
      const showLock = () => {
        const on = this.locked(c.id);
        lock.classList.toggle("on", on);
        row.classList.toggle("locked", on);
        lock.setAttribute("aria-pressed", String(on));
        lock.title = on ? `Locked: Roll leaves ${c.label.toLowerCase()} alone. Click to unlock.` : `Lock, so Roll leaves ${c.label.toLowerCase()} alone`;
      };
      lock.addEventListener("click", () => {
        if (this.locked(c.id)) s.locked = s.locked.filter((k) => k !== c.id);
        else s.locked.push(c.id);
        showLock();
        this.showNote();
        this.save();
        lock.blur();
      });
      this.lockButtons.set(c.id, lock);
      showLock();
      const name = document.createElement("span");
      name.className = "cat-name";
      name.textContent = c.label;
      const die = document.createElement("button");
      die.type = "button";
      die.className = "small dice";
      die.innerHTML = DICE_ICON;
      die.title = `Roll just ${c.label.toLowerCase()}, locked or not`;
      die.setAttribute("aria-label", die.title);
      die.addEventListener("click", () => { this.rollOne(c.id); die.blur(); });
      row.append(lock, name, die);
      list.append(row);
    }

    // Rolling by itself.
    const auto = $<HTMLSelectElement>("explore-auto");
    for (const n of AUTO_CHOICES) {
      const o = document.createElement("option");
      o.value = String(n);
      o.textContent = n === 0 ? "Off" : `every ${n} bars`;
      auto.append(o);
    }
    auto.value = String(s.auto);
    auto.addEventListener("change", () => {
      s.auto = Number(auto.value);
      this.lastBar = -1;
      this.save();
      auto.blur();
    });

    this.showNote();
    this.showHistory();
    this.showLast("");
  }

  private showNote(): void {
    const n = this.settings.locked.length;
    $("explore-note").textContent = n === 0 ? "roll, keep what you like, lock it" : n === CATEGORIES.length ? "everything locked" : `${n} locked`;
  }

  private showHistory(): void {
    $<HTMLButtonElement>("undo").disabled = this.past.length === 0;
    $<HTMLButtonElement>("redo").disabled = this.future.length === 0;
  }

  /** What the last roll did, under the panel. */
  private showLast(text: string): void {
    const el = $("explore-last");
    el.textContent = text;
    el.hidden = text === "";
  }
}
