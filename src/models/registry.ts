import type { ModelDefinition } from "./types";
import { cloth } from "./cloth";
import { boids } from "./boids";
import { reaction } from "./reaction";
import { chladni } from "./chladni";

/**
 * Every model the app offers. To add a model, create a file in this folder
 * that exports a `ModelDefinition` and add it to this list. The model menu
 * groups by category in the order categories first appear here.
 */
export const models: ModelDefinition[] = [
  boids,
  cloth, reaction, chladni,
];

export function findModel(id: string): ModelDefinition | undefined {
  return models.find((m) => m.id === id);
}
