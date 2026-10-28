import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { CollectionColumn } from "../collections.js";
import type { AccessMode } from "./artifacts.js";
import type { WakeWindow } from "./agents.js";
import type { ConnectionResource } from "./coaches.js";
import type { Manifest } from "./connectors.js";

// The `guilds.recipe` document `recipes.body` holds: its schema, and the types of the document
// the box reads it into, with who wrote each reviewable field.

export const RECIPE_FORMAT = "guilds.recipe";
export const RECIPE_NAME_MAX = 80;

function Closed<T extends Record<string, TSchema>>(properties: T) {
  return Type.Object(properties, { additionalProperties: false });
}

export const FieldAuthorSchema = Closed({
  by: Type.Union([Type.Literal("operator"), Type.Literal("builder")]),
  reviewed: Type.Boolean(),
});

export type FieldAuthor = Static<typeof FieldAuthorSchema>;

export const RecipeSchema = Closed({
  format: Type.Literal(RECIPE_FORMAT),
  version: Type.Integer({ minimum: 1 }),
  meta: Closed({
    name: Type.String({ minLength: 1, maxLength: RECIPE_NAME_MAX }),
    description: Type.String(),
    created_at: Type.String(),
    source: Closed({
      kind: Type.Union([Type.Literal("guild"), Type.Literal("builder"), Type.Literal("file")]),
      guild_id: Type.Optional(Type.String()),
      session_id: Type.Optional(Type.String()),
    }),
  }),
  guild: Closed({
    name_suggestion: Type.String({ minLength: 1, maxLength: 64 }),
    about: Type.String(),
    objective: Type.String(),
    group_agent_message_limit: Type.Integer({ minimum: 1, maximum: 10_000 }),
  }),
  roles: Type.Array(Type.Object({}, { additionalProperties: true })),
  collections: Type.Array(Type.Object({}, { additionalProperties: true })),
  notes: Type.Array(Type.Object({}, { additionalProperties: true })),
  connections: Type.Array(Type.Object({}, { additionalProperties: true })),
  secrets: Type.Array(Type.Object({}, { additionalProperties: true })),
  external: Type.Array(Type.Object({}, { additionalProperties: true })),
  repositories: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }))),
  design: Type.Optional(Type.Object({}, { additionalProperties: true })),
});

export type RecipeDocument = Omit<
  Static<typeof RecipeSchema>,
  "roles" | "collections" | "notes" | "connections" | "secrets" | "external" | "repositories" | "design"
> & {
  roles: RecipeRole[];
  collections: RecipeCollection[];
  notes: RecipeNote[];
  connections: RecipeConnection[];
  secrets: RecipeSecret[];
  external: RecipeExternal[];
  repositories: RecipeRepository[];
  design: RecipeDesign;
};

/**
 * A git repository the guild needs, by name and purpose: no URL and no credential. Apply
 * asks the operator to connect GitHub and to add each one in the guild's Settings.
 */
export type RecipeRepository = { name: string; purpose: string };

export type RecipeRole = {
  role: string;
  name_suggestion: string;
  focus: string;
  wake_triggers: string;
  avatar_shape: string;
  avatar_color: string;
  /** The author's agent config keys; validation reports the ones the box does not take. */
  config: Record<string, unknown>;
  task: { body: string; embeds: string[]; author: FieldAuthor };
  scripts: RecipeScript[];
  schedules: RecipeSchedule[];
  native_tools: Record<string, boolean>;
  browser: { required: boolean; instructions: string; author: FieldAuthor };
};

export type RecipeScript = {
  name: string;
  description: string;
  parameters: Record<string, unknown> | null;
  source: string;
  secrets: string[];
  author: FieldAuthor;
};

/** Exactly one of cron or window is set; validation reports a row with neither or both. */
export type RecipeSchedule = {
  key: string;
  cron?: string;
  window?: WakeWindow;
  description: string;
  instruction: string;
  author: FieldAuthor;
};

/**
 * A typed table of the applied guild or of the organisation. Apply creates it
 * with these columns or reuses a live table of the same name, then raises the
 * new guild's mode on its access list to `guild` and each `writers` role's
 * agent to `write`.
 */
export type RecipeCollection = {
  name: string;
  purpose: string;
  columns: CollectionColumn[];
  /** `guild`: the applied guild owns it. `org`: the organisation holds it and `guild` is the guild's mode on it. */
  scope: "guild" | "org";
  guild: AccessMode;
  writers: string[];
};

/**
 * A seed note. Its access is shaped like a table's: `guild` is the mode every
 * agent of the applied guild gets on it and `writers` the roles whose agents
 * write it, both beyond the rows the note starts with at its level.
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
  /** Absent on an agent note the guild does not reach. */
  guild?: AccessMode;
  writers: string[];
};

export type RecipeConnectionResource = ConnectionResource;

export type RecipeConnection = {
  server: string;
  auth: "oauth" | "token" | "none";
  recommended_scope: "org" | "guild" | "agent";
  recommended_role?: string;
  hint: string;
  setup: string;
  resources?: RecipeConnectionResource[];
  author: FieldAuthor;
  roles: Record<string, { enabled: boolean; tools: Record<string, boolean> }>;
  /** An organisation's own remote server, carried whole so apply can add it where the box lacks it. */
  manifest?: Manifest;
};

export type RecipeSecret = {
  name: string;
  description: string;
  recommended_scope: "org" | "guild" | "agent";
  recommended_role?: string;
  roles: string[];
};

export type RecipeExternal = {
  kind: string;
  title: string;
  setup: string;
  author: FieldAuthor;
};

export type DesignDecision = {
  proposed_by: "operator" | "builder";
  accepted: boolean;
};

export const SYSTEM_RESOLUTIONS = ["catalog", "native", "browser", "script", "composition", "decision", "refused"] as const;
export type SystemResolution = (typeof SYSTEM_RESOLUTIONS)[number];

export type RecipeDesign = {
  systems: Array<
    DesignDecision & {
      name: string;
      resolution: SystemResolution;
      server?: string;
      reason: string;
    }
  >;
  specialization: Array<
    DesignDecision & {
      role: string;
      reason: "narrower_tools" | "narrower_access" | "narrower_context" | "volume" | "other";
      detail: string;
    }
  >;
  routines: Array<
    DesignDecision & {
      key: string;
      role: string;
      cadence: string;
      dedupe_collection?: string;
      dedupe_key?: string;
    }
  >;
  handoffs: Array<
    DesignDecision & {
      from: string;
      to: string;
      kind: "collection" | "tagged";
      collection?: string;
      budget?: number;
    }
  >;
  browser: Array<
    DesignDecision & {
      role: string;
      site: string;
      viable: boolean;
      login_failure_policy: string;
    }
  >;
};
