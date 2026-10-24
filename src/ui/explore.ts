import type { ParamValues } from "../models/types";
import type { Studio, StudioSnapshot } from "../music/studio";
import { DICE_ICON, LEVELS, LOCK_ICON, chance, type RollLevel } from "../roll";

/**
 * The Explore panel: two sets of dice, one for the visuals and one for the
 * music, each with its own Roll, level and auto setting. A roll changes every
 * category on its side that isn't locked (visuals: the model, its sliders,
 * the macros, the global controls, the modulation matrix; music: the
 * sequencer), as far as the level allows, and every roll on either side can
 * be undone and redone, so exploring is a matter of rolling, locking what you
 * like, and rolling again. Each category also has a die of its own, and the
 * dice can roll by themselves every so many bars.
 *
 * All of its DOM work happens on a click or a roll, never per frame (see the
 * repaint notes in music/studio.ts).
 */

export type Side = "visuals" | "music";
export type Category = "model" | "params" | "macros" | "globals" | "modulation" | "music";

const SIDES: { id: Side; label: string; key: string; hints: string[] }[] = [
  { id: "visuals", label: "Visuals", key: "D", hints: [
    "Every slider moves a little from where it is. Nothing switches.",
    "Sliders move further, and the odd dropdown or switch flips.",
    "Fresh values across the useful part of every range. Dropdowns, presets and the model can change.",
    "Anything goes: whole ranges, every switch, rebuild sizes and the stranger corners.",
  ] },
  { id: "music", label: "Music", key: "M", hints: [
    "The pattern sliders move a little, and one track gets a fresh go. Same idea, same style.",
    "Sliders move further and the song starts a new idea in its style; the odd mode flips.",
    "A new idea, and the style, key, tempo, presets and named sounds can change.",
    "Anything goes: the synths' own controls roll too, and the drum patterns can drift against the bar.",
  ] },
];

const CATEGORIES: { id: Category; side: Side; label: string; hint: string }[] = [
  { id: "model", side: "visuals", label: "Model", hint: "Switch to another model. Shake does it now and then, Roll about half the time, Wild always." },
  { id: "params", side: "visuals", label: "Parameters", hint: "The model's sliders, inside their useful bands. Ones you've padlocked stay put. Rebuild sizes (counts, resolution) only move at Wild." },
  { id: "macros", side: "visuals", label: "Macros", hint: "The model's macros: a few pushed, the rest at zero." },
  { id: "globals", side: "visuals", label: "Global controls", hint: "Colour, gravity, energy and trails; sometimes one of the built-in presets." },
  { id: "modulation", side: "visuals", label: "Modulation", hint: "The modulation matrix: route amounts and built-in strengths drift, and at Roll the routes themselves change." },
  { id: "music", side: "music", label: "Sequencer", hint: "The whole sequencer, as far as the level allows. Mutes, holds, volumes and pans stay yours." },
];

/** Bars between rolls when the dice roll by themselves. */
const AUTO_CHOICES = [0, 2, 4, 8, 16, 32];
const HISTORY = 40;

/** How likely a roll is to switch model at each level (a category's own die always does). */
const MODEL_CHANCE = [0, 0.25, 0.5, 1];

interface SideSettings {
  level: RollLevel;
  auto: number;
}

interface ExploreSettings {
  visuals: SideSettings;
  music: SideSettings;
  locked: Category[];
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

function sanitizeSide(saved: unknown, fallback: SideSettings): SideSettings {
  const out = { ...fallback };
  if (!saved || typeof saved !== "object") return out;
  const s = saved as Partial<SideSettings>;
  if (typeof s.level === "number" && s.level >= 0 && s.level < LEVELS.length) out.level = Math.round(s.level) as RollLevel;
  if (typeof s.auto === "number" && AUTO_CHOICES.includes(s.auto)) out.auto = s.auto;
  return out;
}

export class Explorer {
  private settings: ExploreSettings = { visuals: { level: 2, auto: 0 }, music: { level: 2, auto: 0 }, locked: [] };
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];
  private lastBar: Record<Side, number> = { visuals: -1, music: -1 };

  constructor(private host: ExploreHost) {
    this.load();
    this.build();
  }

  private load(): void {
    try {
      const saved = JSON.parse(localStorage.getItem("ui:explore") ?? "null") as (Partial<ExploreSettings> & Partial<SideSettings>) | null;
      if (!saved) return;
      // The first version had one level and one auto setting for everything.
      const old = sanitizeSide(saved, this.settings.visuals);
      this.settings.visuals = sanitizeSide(saved.visuals, old);
      this.settings.music = sanitizeSide(saved.music, old);
      if (Array.isArray(saved.locked)) this.settings.locked = saved.locked.filter((c) => CATEGORIES.some((k) => k.id === c));
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

  locked(c: Category): boolean {
    return this.settings.locked.includes(c);
  }

  // ---- Rolling -------------------------------------------------------------

  /** Roll every unlocked category of one side. `live` is a roll the dice made by themselves: nothing rebuilds the model. */
  roll(side: Side, live = false): void {
    const cats = CATEGORIES.filter((c) => c.side === side && !this.locked(c.id)).map((c) => c.id);
    if (cats.length === 0) {
      this.showLast(side === "visuals" ? "Every visual category is locked: unlock one to roll it." : "The sequencer is locked: unlock it to roll it.");
      return;
    }
    this.rollCategories(cats, this.settings[side].level, live, false);
  }

  /** Roll one category whether or not it's locked, from its own die. */
  rollOne(c: Category): void {
    const side = CATEGORIES.find((k) => k.id === c)!.side;
    this.rollCategories([c], this.settings[side].level, false, true);
  }

  private rollCategories(cats: Category[], level: RollLevel, live: boolean, forced: boolean): void {
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

  /** Called every frame with the musical time in bars: each side rolls again when its auto setting says so. */
  frame(bars: number): void {
    for (const side of ["visuals", "music"] as const) {
      const every = this.settings[side].auto;
      if (every === 0) continue;
      const bar = Math.floor(bars / every);
      if (bar === this.lastBar[side]) continue;
      // The first bar after switching Auto on only starts the count.
      const first = this.lastBar[side] < 0;
      this.lastBar[side] = bar;
      if (!first) this.roll(side, true);
    }
  }

  // ---- The panel -------------------------------------------------------------

  private build(): void {
    const s = this.settings;
    $("undo").addEventListener("click", () => { this.undo(); $("undo").blur(); });
    $("redo").addEventListener("click", () => { this.redo(); $("redo").blur(); });

    for (const side of SIDES) {
      const own = s[side.id];
      for (const b of [$<HTMLButtonElement>(`roll-${side.id}`), $<HTMLButtonElement>(`explore-roll-${side.id}`)]) {
        b.innerHTML = `${DICE_ICON}<span>${b.id.startsWith("explore") ? "Roll" : side.label}</span>`;
        b.title = `Roll the ${side.label.toLowerCase()} dice: everything on that side that isn't locked changes, as far as its level allows (${side.key})`;
        b.addEventListener("click", () => { this.roll(side.id); b.blur(); });
      }

      // How far a roll goes.
      const levels = $(`level-${side.id}`);
      const hint = $(`hint-${side.id}`);
      const buttons: HTMLButtonElement[] = [];
      const showLevel = () => {
        buttons.forEach((b, i) => b.classList.toggle("active", i === own.level));
        hint.textContent = side.hints[own.level];
      };
      LEVELS.forEach((l, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = l.name;
        b.title = side.hints[i];
        b.addEventListener("click", () => {
          own.level = i as RollLevel;
          showLevel();
          this.save();
          b.blur();
        });
        buttons.push(b);
        levels.append(b);
      });
      showLevel();

      // The categories, each with a padlock and a die of its own.
      const list = $(`cats-${side.id}`);
      for (const c of CATEGORIES.filter((k) => k.side === side.id)) {
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
      const auto = $<HTMLSelectElement>(`auto-${side.id}`);
      for (const n of AUTO_CHOICES) {
        const o = document.createElement("option");
        o.value = String(n);
        o.textContent = n === 0 ? "Off" : `every ${n} bars`;
        auto.append(o);
      }
      auto.value = String(own.auto);
      auto.addEventListener("change", () => {
        own.auto = Number(auto.value);
        this.lastBar[side.id] = -1;
        this.save();
        auto.blur();
      });
    }

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
