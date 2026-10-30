import type { RegistryEntry } from "./admin";
import type { Harness, MachineRef } from "./agents";
import type { WakeWindow } from "./schedules";
import type { Column } from "./tables";
import type { AccessMode } from "./access";

/**
 * Shapes of the orchestrator's JSON API for recipes and their applies, as the app reads them.
 * Timestamps are ISO-8601 in UTC.
 */

/** A recipe in `GET /api/recipes/registry`. */
export type RegistryRecipe = RegistryEntry & { name: string };

/** `GET /api/recipes/registry`: the registry's recipes; `offline` when `REGISTRY_URL` is set empty. */
export type RegistryRecipes = { offline: boolean; url: string | null; recipes: RegistryRecipe[] };

/** A registry recipe by name: its newest version unless `version` names one. */
export type RegistryRecipeRef = { name: string; version?: string };

/** Who last wrote a recipe field and whether an operator has confirmed it (db/schema/recipe-document.ts). */
export type FieldAuthor = { by: "operator" | "builder"; reviewed: boolean };

/** A recipe's title, description, creation time, and where it came from (db/schema/recipe-document.ts). */
export type RecipeMeta = {
  name: string;
  description: string;
  created_at: string;
  source: { kind: "guild" | "builder" | "file"; guild_id?: string; session_id?: string };
};

/** The guild a recipe creates: its suggested slug, about text, objective, and group message cap (db/schema/recipe-document.ts). */
export type RecipeGuild = {
  name_suggestion: string;
  about: string;
  objective: string;
  group_agent_message_limit: number;
};

/** A script a role ships with, and who wrote it (db/schema/recipe-document.ts). */
export type RecipeScript = {
  name: string;
  description: string;
  parameters: Record<string, unknown> | null;
  source: string;
  secrets: string[];
  author: FieldAuthor;
};

/** A routine of a role; exactly one of `cron` (UTC) or `window` is set (db/schema/recipe-document.ts). */
export type RecipeSchedule = {
  key: string;
  cron?: string;
  window?: WakeWindow;
  description: string;
  instruction: string;
  author: FieldAuthor;
};

/** One agent of the recipe, keyed by its `role` handle (db/schema/recipe-document.ts). */
export type RecipeRole = {
  role: string;
  name_suggestion: string;
  focus: string;
  avatar_shape: string;
  avatar_color: string;
  config: Record<string, unknown>;
  task: { body: string; embeds: string[]; author: FieldAuthor };
  scripts: RecipeScript[];
  schedules: RecipeSchedule[];
  native_tools: Record<string, boolean>;
  browser: { required: boolean; instructions: string; author: FieldAuthor };
};

/** A git repository a recipe needs, by name and purpose; apply asks the operator to add it (db/schema/recipe-document.ts). */
export type RecipeRepository = { name: string; purpose: string };

/**
 * A typed table: owned by the applied guild (`scope: "guild"`) or held by the organisation, where
 * `guild` is the applied guild's row on its access list and `writers` lists the roles whose agents
 * get a write row (db/schema/recipe-document.ts).
 */
export type RecipeCollection = {
  name: string;
  purpose: string;
  columns: Column[];
  scope: "guild" | "org";
  guild: AccessMode;
  writers: string[];
};

/**
 * A seed note apply writes at the organisation, guild, or one role's agent. `guild` is the applied
 * guild's mode on its access list (absent on an agent note the guild does not reach) and `writers`
 * lists the roles whose agents get a write row (db/schema/recipe-document.ts).
 */
export type RecipeNote = {
  id: string;
  level: "org" | "guild" | "agent";
  role?: string;
  /** A `.md` file name with no `/`: notes are flat at their level. */
  key: string;
  body: string;
  kind: "seed";
  author: FieldAuthor;
  guild?: AccessMode;
  writers: string[];
};

/** A resource inside a connector that the recipe's agents use (db/schema/recipe-document.ts). */
export type RecipeConnectionResource = {
  kind: "database" | "page" | "other";
  id: string;
  title: string;
  url?: string;
  use?: string;
};

/** A per-role overlay on a connector: whether the role uses it and which tools are on or off (db/schema/recipe-document.ts). */
export type RecipeConnectionRole = { enabled: boolean; tools: Record<string, boolean> };

/** A connector the guild needs; an empty `roles` map means every role uses it (db/schema/recipe-document.ts). */
export type RecipeConnection = {
  server: string;
  auth: "oauth" | "token" | "none";
  recommended_scope: "org" | "guild" | "agent";
  recommended_role?: string;
  hint: string;
  setup: string;
  resources?: RecipeConnectionResource[];
  author: FieldAuthor;
  roles: Record<string, RecipeConnectionRole>;
};

/** A secret the guild needs (db/schema/recipe-document.ts). */
export type RecipeSecret = {
  name: string;
  description: string;
  recommended_scope: "org" | "guild" | "agent";
  recommended_role?: string;
  roles: string[];
};

/** A setup step outside the platform the operator performs (db/schema/recipe-document.ts). */
export type RecipeExternal = {
  kind: string;
  title: string;
  setup: string;
  author: FieldAuthor;
};

/** Who proposed a design entry and whether it is accepted (db/schema/recipe-document.ts). */
export type DesignDecision = { proposed_by: "operator" | "builder"; accepted: boolean };

/** How the design reaches an outside system (db/schema/recipe-document.ts). */
export type DesignSystem = DesignDecision & {
  name: string;
  resolution: "catalog" | "native" | "browser" | "script" | "composition" | "decision" | "refused";
  server?: string;
  reason: string;
};

/** Why a role is split out from the others (db/schema/recipe-document.ts). */
export type DesignSpecialization = DesignDecision & {
  role: string;
  reason: "narrower_tools" | "narrower_access" | "narrower_context" | "volume" | "other";
  detail: string;
};

/** A routine the design calls for, with its cadence as written (db/schema/recipe-document.ts). */
export type DesignRoutine = DesignDecision & {
  key: string;
  role: string;
  cadence: string;
  dedupe_collection?: string;
  dedupe_key?: string;
};

/** Work passing from one role to another, through a collection queue or a tagged message (db/schema/recipe-document.ts). */
export type DesignHandoff = DesignDecision & {
  from: string;
  to: string;
  kind: "collection" | "tagged";
  collection?: string;
  budget?: number;
};

/** A role that works a site through its browser (db/schema/recipe-document.ts). */
export type DesignBrowser = DesignDecision & {
  role: string;
  site: string;
  viable: boolean;
  login_failure_policy: string;
};

/** The builder's design notes behind the recipe (db/schema/recipe-document.ts). */
export type RecipeDesign = {
  systems: DesignSystem[];
  specialization: DesignSpecialization[];
  routines: DesignRoutine[];
  handoffs: DesignHandoff[];
  browser: DesignBrowser[];
};

/** A parsed recipe document, every list present (db/schema/recipe-document.ts, filled by parseRecipe). */
export type RecipeDocument = {
  format: "guilds.recipe";
  version: number;
  meta: RecipeMeta;
  guild: RecipeGuild;
  roles: RecipeRole[];
  collections: RecipeCollection[];
  notes: RecipeNote[];
  connections: RecipeConnection[];
  secrets: RecipeSecret[];
  external: RecipeExternal[];
  repositories: RecipeRepository[];
  design: RecipeDesign;
};

/** `ready` once the recipe is approved; any body write returns it to `draft` (recipes/store.ts, http/recipe-routes.ts). */
export type RecipeStatus = "draft" | "ready";

/** A stored recipe as `GET /api/recipes/:id` returns it (recipes/store.ts). */
export type RecipeRow = {
  id: string;
  org_id: string;
  created_by_user_id: string | null;
  name: string;
  description: string;
  visibility: string;
  status: RecipeStatus;
  body: RecipeDocument;
  body_version: number;
  source_kind: "guild" | "builder" | "file";
  source_guild_id: string | null;
  source_builder_session_id: string | null;
  created_at: string;
  updated_at: string;
};

/** A recipe's new name and description, refused (409) over a body newer than `expected_body_version`. */
export type RecipeInput = { name: string; description: string; expected_body_version: number };

/** A recipe field confirmed as written, or replaced with the operator's `value`. */
export type RecipeFieldReview = { path: string; action: "confirm" | "edit"; value?: string };

/** How serious a validation finding is (recipes/validate.ts). */
export type FindingSeverity = "error" | "warning" | "info";

/** One validation finding, anchored to a dotted recipe path such as `roles.writer.task` (recipes/validate.ts). */
export type RecipeFinding = {
  code: string;
  severity: FindingSeverity;
  path: string;
  message: string;
};

/** A tool or connector the operator removed from the recipe (db/schema/recipe-document.ts). */
export type AccessCut = {
  kind: "tool" | "connector";
  server: string;
  role?: string;
  tool?: string;
};

/** One access change the operator sends: a tool switched for a role, or a connector removed (db/schema/recipe-document.ts). */
export type AccessEdit =
  | { action: "set_tool"; server: string; role: string; tool: string; enabled: boolean }
  | { action: "remove_connection"; server: string };

/** `POST /api/recipes/:id/access`: the rewritten recipe with every operator cut (http/recipe-routes.ts). */
export type AccessEditResult = RecipeRow & { access_cuts: AccessCut[] };

/** `POST /api/recipes/:id/validate`: all findings, the blocking ones, unconfirmed field paths, and operator cuts (http/recipe-routes.ts). */
export type RecipeValidation = {
  findings: RecipeFinding[];
  errors: RecipeFinding[];
  unreviewed: string[];
  access_cuts: AccessCut[];
  body_version: number;
  status: RecipeStatus;
};

/** What apply does with one recipe collection: create it, reuse the live table, or stop on a conflict (db/schema/apply-preview.ts). */
export type CollectionPlan = RecipeCollection & {
  action: "create" | "reuse" | "conflict";
  collection_id: string | null;
  differences: string[];
};

/** A live organisation connection apply can reuse for a connector (db/schema/coaches.ts). */
export type ReusableConnection = { id: string; owner_scope: string; status: string };

/** What apply does with one connector: reuse a live login or create one (db/schema/coaches.ts). */
export type PlannedConnection = {
  server: string;
  auth: RecipeConnection["auth"];
  recommended_scope: "guild" | "agent";
  reusable: ReusableConnection[];
  action: "reuse" | "create";
  connection_id: string | null;
  setup: string;
  resources: RecipeConnectionResource[];
};

/** What apply does with one secret: create it, reuse a same-named one, rename it, or skip it (db/schema/coaches.ts). */
export type PlannedSecret = {
  name: string;
  description: string;
  collision: boolean;
  action: "create" | "reuse" | "rename" | "skip";
  dest_name: string;
  recommended_scope: "guild" | "agent";
};

/** One agent apply creates (db/schema/apply-preview.ts). */
export type CreatedAgent = {
  role: string;
  name: string;
  focus: string;
  model: string;
  browser: boolean;
  coding: boolean;
  task: string;
  native_tools: string[];
};

/** One routine apply creates; exactly one of `cron` or `window` is set (db/schema/apply-preview.ts). */
export type CreatedRoutine = {
  role: string;
  key: string;
  cron: string | null;
  window: WakeWindow | null;
  description: string;
  instruction: string;
};

/** Everything apply creates, as the preview lists it (db/schema/apply-preview.ts). */
export type ApplyCreates = {
  guild: { name: string; about: string; objective: string };
  agents: CreatedAgent[];
  collections: CollectionPlan[];
  notes: Array<{ key: string; level: RecipeNote["level"]; role: string | null }>;
  scripts: Array<{ role: string; name: string; description: string }>;
  routines: CreatedRoutine[];
  connections: PlannedConnection[];
  secrets: PlannedSecret[];
  repositories: RecipeRepository[];
};

/**
 * A connector to install before apply: one the registry offers, or the recipe's own remote server
 * that the organisation adds as its server.
 */
export type ApplyInstall =
  | { server: string; from: "registry"; version: string; verified: boolean }
  | {
      server: string;
      from: "recipe";
      display_name: string;
      description: string;
      url: string;
      auth: "none" | "token" | "oauth";
    };

/**
 * A connector the recipe needs that the box has but no platform admin has set up; `integration`
 * is the platform key that sets it up, null when none on this box does.
 */
export type ApplySetup = { server: string; integration: string | null; label: string };

/** A machine the apply preview offers: its size, its planned load, and whether it meets every role's minimum. */
export type ApplyMachine = MachineRef & {
  cpu: number;
  memory_mib: number;
  planned_cpu: number;
  planned_mib: number;
  agents: number;
  fits: boolean;
};

/** `POST /api/recipes/:id/preview`: the apply plan, its findings, and what it creates (db/schema/apply-preview.ts). */
export type ApplyPreview = {
  recipe_id: string;
  recipe_name: string;
  guild_name: string;
  guild_id: string | null;
  names: Array<{ role: string; name: string }>;
  /** Each role's recommended model, and the one apply creates it with unless the operator picks another. */
  models: RoleModel[];
  /** Each coding role's harness: what the recipe names, and the one apply creates it with. */
  harnesses: RoleHarness[];
  /** The organisation's machines the roles may go on. */
  machines: ApplyMachine[];
  /** The machine the roles go on: the one chosen, or the only one; null while several wait for a choice. */
  machine_id: string | null;
  /** The smallest machine every role runs on. */
  minimum_cpu: number;
  minimum_mib: number;
  /** The planned load the recipe's roles add: the sum of their minimums. */
  adds_cpu: number;
  adds_mib: number;
  collisions: string[];
  connections: PlannedConnection[];
  /** Connectors the recipe names that the box lacks; each blocks apply until it is installed. */
  installs: ApplyInstall[];
  /** Connectors the box has that no platform admin has set up; the guild cannot connect them until one does. */
  setups: ApplySetup[];
  secrets: PlannedSecret[];
  collections: CollectionPlan[];
  findings: RecipeFinding[];
  errors: RecipeFinding[];
  unreviewed: string[];
  /** How many more agents the organisation may hold, by kind; null where nothing caps it. */
  remaining: { agents: number | null; browser_agents: number | null; coding_agents: number | null };
  creates: ApplyCreates;
};

/** One step of an apply's checklist: a login, a secret, a browser login, an outside setup, or activation. */
export type ApplyStep = {
  id: string;
  kind: "connection" | "overlays" | "secret" | "repository" | "browser" | "external" | "activate";
  title: string;
  setup?: string;
  site?: string;
  role?: string;
  deferrable?: boolean;
  phase?: string;
  /** Checked by the server, or confirmed by the operator. */
  closure: "verified" | "confirmed";
  status: "open" | "verified" | "confirmed" | "skipped";
  resolution?: "later" | "done" | "skipped" | "activated";
  closed_at?: string;
};

/** A step confirmed done by hand, or with `skip` a login or secret the guild will do without. */
export type ApplyStepConfirmation = { stepId: string; skip?: boolean };

/** Which login apply gives a connector: a live one to reuse, or one to connect afterwards. */
export type ApplyConnectionChoice = {
  server: string;
  action: "reuse" | "create";
  scope: "guild" | "agent";
  connection_id?: string;
};

/** A role's model on the apply preview: what the recipe recommends, and what apply will create it with. */
export type RoleModel = { role: string; recommended: string | null; model: string | null };

/** A coding role's harness on the apply preview: what the recipe names, and what apply will create it with. */
export type RoleHarness = { role: string; recommended: Harness | null; harness: Harness | null };

/** What the operator decides before apply: the guild's name, each agent's name and model, each coding agent's harness, and each login. */
export type ApplyChoices = {
  guild_name: string;
  names: Array<{ role: string; name: string }>;
  models: Array<{ role: string; model: string }>;
  harnesses?: Array<{ role: string; harness: Harness }>;
  connections: ApplyConnectionChoice[];
  /** The machine every role goes on; the organisation's only one when absent. */
  machine_id?: string;
};

/** `GET /api/guilds/:id/apply`: the open checklist, and agents that still need a post-apply browser login. */
export type GuildApplyState = {
  apply: ApplyRow | null;
  browser_logins: string[];
};

/** A recipe applied to a new guild: what it created, and the checklist left before its routines start. */
export type ApplyRow = {
  id: string;
  org_id: string;
  recipe_id: string;
  guild_id: string;
  created_guild: boolean;
  status: "skeleton" | "checklist" | "ready" | "aborted";
  recipe_body_version: number;
  preview: ApplyPreview;
  checklist: ApplyStep[];
  warnings: Array<{ code: string; path: string; message: string }>;
  created_at: string;
  updated_at: string;
};
