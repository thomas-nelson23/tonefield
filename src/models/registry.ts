import type { ModelDefinition } from "./types";
import { branches } from "./branches";
import { boids } from "./boids";
import { plexus } from "./plexus";
import { reaction } from "./reaction";
import { chladni } from "./chladni";
import { facets } from "./facets";

/**
 * Every model the app offers. To add a model, create a file in this folder
 * that exports a `ModelDefinition` and add it to this list. The model menu
 * groups by category in the order categories first appear here.
 */
export const models: ModelDefinition[] = [
  boids,
  branches, reaction, chladni, plexus, facets,
];

/** Models that were replaced, and the one that took their place in the list. */
const RETIRED: Record<string, string> = { cloth: "branches" };

export function findModel(id: string): ModelDefinition | undefined {
  return models.find((m) => m.id === (RETIRED[id] ?? id));
}

/** Ids of models that no longer exist, so their saved settings can be cleared away. */
export const retiredIds = Object.keys(RETIRED);
