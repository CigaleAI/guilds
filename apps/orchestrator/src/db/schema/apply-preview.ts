import type { Harness, WakeWindow } from "./agents.js";
import type { PlannedConnection, PlannedSecret } from "./coaches.js";
import type { machines } from "./organisations.js";
import type { RecipeCollection, RecipeDocument } from "./recipe-document.js";

// The preview of an apply, as `recipe_applies.preview` keeps it: what it creates from the recipe,
// what it reuses of the organisation, and what blocks it.

export type FindingSeverity = "error" | "warning" | "info";

/** What validating a recipe reports about one of its fields. */
export type RecipeFinding = {
  code: string;
  severity: FindingSeverity;
  path: string;
  message: string;
};

/** The agent name a role gets. */
export type NameDecision = { role: string; name: string };

/** A role's model on the preview: what the recipe recommends, and what apply will create it with. */
export type RoleModel = { role: string; recommended: string | null; model: string | null };

/** A coding role's harness on the preview: what the recipe names, and what apply will create it with. */
export type RoleHarness = { role: string; recommended: Harness | null; harness: Harness | null };

/**
 * What apply will do with one recipe collection: create it, reuse the live
 * table of that name, or stop because that table's columns differ.
 */
export type CollectionPlan = RecipeCollection & {
  action: "create" | "reuse" | "conflict";
  collection_id: string | null;
  differences: string[];
};

/**
 * A machine the preview offers: its size, its agents' planned load, and whether it meets the
 * minimum of every role of the recipe.
 */
export type MachineChoice = {
  id: string;
  name: string;
  box: (typeof machines.$inferSelect)["box"];
  cpu: number;
  memory_mib: number;
  planned_cpu: number;
  planned_mib: number;
  agents: number;
  fits: boolean;
};

/** A connector the box lacks that apply installs: carried whole by the recipe, or offered by the registry. */
export type PlannedInstall =
  | { server: string; from: "recipe"; display_name: string; description: string; url: string; auth: string }
  | { server: string; from: "registry"; version: string; verified: boolean };

/** A connector the box has that a platform admin has not set up yet. */
export type PlatformSetup = { server: string; integration: string | null; label: string };

/** What the guild will hold once applied, as the preview lists it. */
export type ApplyInventory = {
  guild: { name: string; about: string; objective: string };
  agents: Array<{
    role: string;
    name: string;
    focus: string;
    model: string;
    browser: boolean;
    coding: boolean;
    task: string;
    native_tools: string[];
  }>;
  collections: CollectionPlan[];
  notes: Array<{ key: string; level: string; role: string | null; guild: string | null; writers: string[] }>;
  scripts: Array<{ role: string; name: string; description: string }>;
  routines: Array<{
    role: string;
    key: string;
    cron: string | null;
    window: WakeWindow | null;
    description: string;
    instruction: string;
  }>;
  connections: PlannedConnection[];
  secrets: PlannedSecret[];
  repositories: RecipeDocument["repositories"];
};

export type ApplyPreview = {
  recipe_id: string;
  recipe_name: string;
  guild_name: string;
  guild_id: string | null;
  names: NameDecision[];
  models: RoleModel[];
  harnesses: RoleHarness[];
  machines: MachineChoice[];
  machine_id: string | null;
  minimum_cpu: number;
  minimum_mib: number;
  adds_cpu: number;
  adds_mib: number;
  collisions: string[];
  connections: PlannedConnection[];
  installs: PlannedInstall[];
  setups: PlatformSetup[];
  secrets: PlannedSecret[];
  collections: CollectionPlan[];
  findings: RecipeFinding[];
  errors: RecipeFinding[];
  unreviewed: string[];
  remaining: { agents: number | null; browser_agents: number | null; coding_agents: number | null };
  creates: ApplyInventory;
};
