import { roleBrowses } from "./prepare.js";
import type { FindingSeverity, RecipeFinding } from "../db/schema/index.js";
import type { RecipeDocument, RecipeRole } from "./schema.js";

// What validating a recipe reports, and the context it validates against.

export type ValidationContext = {
  publishedServers: Set<string>;
  /** How many more agents the organisation may hold; null when uncapped. */
  remainingAgents: number | null;
  remainingBrowserAgents: number | null;
  remainingCodingAgents: number | null;
  groupLimit: number;
  /** The model providers the organisation has connected. */
  connectedProviders?: Set<string>;
  /** Connectors the registry offers that the box lacks, by slug: the newest version. */
  registryConnectors?: Map<string, { version: string; verified: boolean }>;
};

/** A check of the whole recipe against the organisation it is applied in. */
export type RecipeRule = (recipe: RecipeDocument, ctx: ValidationContext) => RecipeFinding[];

export function finding(
  code: string,
  severity: FindingSeverity,
  path: string,
  message: string,
): RecipeFinding {
  return { code, severity, path, message };
}

/** The roles that run a browser. */
export function browserRoles(recipe: RecipeDocument): RecipeRole[] {
  return recipe.roles.filter(roleBrowses);
}
