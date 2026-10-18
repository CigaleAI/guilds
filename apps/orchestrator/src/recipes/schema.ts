import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { WAKE_TRIGGERS_MAX } from "../agents/validation.js";
import { NAME_RE } from "../lib/names.js";
import { parseColumns, type CollectionColumn } from "../artifacts/columns.js";
import { ArtifactError } from "../artifacts/errors.js";
import { normalizeNoteKey } from "../artifacts/paths.js";
import { COLLECTION_NAME_RE, PURPOSE_MAX, type AccessMode } from "../artifacts/types.js";
import type { WakeWindow } from "../schedules/window.js";
import { RecipeError } from "./errors.js";
import { loadManifest, ManifestError, recipeManifestProblem, type Manifest } from "../connectors/manifest.js";

/** A connection's carried manifest: a valid, endpoint-only connector under the connection's slug. */
function connectionManifest(raw: unknown, server: string, path: string): Manifest {
  let manifest: Manifest;
  try {
    manifest = loadManifest(raw, server);
  } catch (error) {
    if (error instanceof ManifestError) {
      throw new RecipeError(`${path}: ${error.message}`);
    }
    throw error;
  }
  const problem = recipeManifestProblem(manifest);
  if (problem !== null) {
    throw new RecipeError(`${path}: ${problem}`);
  }
  return manifest;
}

export const RECIPE_FORMAT = "guilds.recipe";
export const RECIPE_VERSION = 2;
export const RECIPE_BODY_MAX_BYTES = 4 * 1024 * 1024;
export const RECIPE_ROLES_MAX = 20;
export const RECIPE_TASK_MAX_BYTES = 256 * 1024;
export const RECIPE_NOTE_MAX_BYTES = 256 * 1024;
export const RECIPE_NOTES_MAX = 64;
export const RECIPE_HINT_MAX = 400;
export const RECIPE_SETUP_MAX = 8 * 1024;
export const RECIPE_LIST_MAX = 50;
export const RECIPE_NAME_MAX = 80;
export const ROLE_RE = NAME_RE;
export const ROUTINE_KEY_RE = /^[a-z][a-z0-9-]{0,62}$/;

function Closed<T extends Record<string, TSchema>>(properties: T) {
  return Type.Object(properties, { additionalProperties: false });
}

export const FieldAuthorSchema = Closed({
  by: Type.Union([Type.Literal("operator"), Type.Literal("builder")]),
  reviewed: Type.Boolean(),
});

export type FieldAuthor = Static<typeof FieldAuthorSchema>;

export function operatorAuthor(): FieldAuthor {
  return { by: "operator", reviewed: true };
}

export function builderAuthor(): FieldAuthor {
  return { by: "builder", reviewed: false };
}

export function markReviewed(author: FieldAuthor): FieldAuthor {
  return { by: author.by, reviewed: true };
}

export function resetReview(author: FieldAuthor): FieldAuthor {
  return { by: author.by, reviewed: false };
}

function parseAuthor(value: unknown, fallback: FieldAuthor): FieldAuthor {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RecipeError("author must be an object");
  }
  const record = value as Record<string, unknown>;
  const by = record.by;
  if (by !== "operator" && by !== "builder") {
    throw new RecipeError("author.by must be operator or builder");
  }
  if (record.reviewed === undefined) {
    return { by, reviewed: false };
  }
  if (typeof record.reviewed !== "boolean") {
    throw new RecipeError("author.reviewed must be a boolean");
  }
  return { by, reviewed: record.reviewed };
}

const StringMapBool = Type.Record(Type.String(), Type.Boolean());

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

const RECIPE_TOP_KEYS = [
  "format",
  "version",
  "meta",
  "guild",
  "roles",
  "collections",
  "notes",
  "connections",
  "secrets",
  "external",
  "repositories",
  "design",
];

export type RecipeRole = {
  role: string;
  name_suggestion: string;
  focus: string;
  wake_triggers: string;
  avatar_shape: string;
  avatar_color: string;
  config: Record<string, unknown>;
  task: { body: string; embeds: string[]; author: FieldAuthor };
  scripts: RecipeScript[];
  schedules: RecipeSchedule[];
  grants: { read_guild: boolean; write_guild: boolean; read_org: boolean; write_org: boolean };
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
 * A typed table at the organisation. Apply creates it with these columns or
 * reuses a live table of the same name, grants the new guild `guild`, and grants
 * each `writers` role's agent `write`.
 */
export type RecipeCollection = {
  name: string;
  purpose: string;
  columns: CollectionColumn[];
  /** `guild`: the applied guild owns it. `org`: the organisation holds it and `guild` is the grant. */
  scope: "guild" | "org";
  guild: AccessMode;
  writers: string[];
};

export type RecipeNote = {
  id: string;
  level: "org" | "guild" | "agent";
  role?: string;
  /** A `.md` file name with no `/`: notes are flat at their level. */
  key: string;
  body: string;
  kind: "seed";
  author: FieldAuthor;
};

export type RecipeConnectionResource = {
  kind: "database" | "page" | "other";
  id: string;
  title: string;
  url?: string;
  use?: string;
};

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

function assertObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RecipeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function keyHint(path: string, key: string): string | null {
  if (key === "name" && path.startsWith("roles[")) {
    return "use `role` for the handle and `name_suggestion` for the create-time slug";
  }
  if (key === "name" && path.startsWith("notes[")) {
    return "notes use `id`, `level`, `key`, and `body`";
  }
  if (key === "path" && path.startsWith("notes[")) {
    return "notes have no folders; `key` is the whole `.md` file name, with no `/`";
  }
  if (key === "text") {
    return "use `body`";
  }
  if (key === "routines") {
    return "use `schedules` with { key, cron or window, description, instruction }";
  }
  if (key === "memory" || key === "memory_seed") {
    return "not a recipe field; Memory instructions go in task.body and seed files go in notes";
  }
  if (key === "model") {
    return "put model on `config.model`";
  }
  if (key === "capabilities") {
    return "use `native_tools` and `connections`";
  }
  if (key === "title" && path.startsWith("notes[")) {
    return "notes use `id`, `level`, `key`, and `body`";
  }
  if (key === "key" && path.startsWith("collections[")) {
    return "collections use `name`, not `key`";
  }
  if ((key === "level" || key === "role") && path.startsWith("collections[")) {
    return "a collection is a table of the applied guild (`scope: \"guild\"`) or of the organisation, where `guild` is the guild's access mode and `writers` lists the roles that write";
  }
  if (key === "schema" && path.startsWith("collections[")) {
    return "use `columns`: [{ name, type, description, required?, unique?, values? }]";
  }
  if (key === "enabled_tools") {
    return "use `tools` as { tool_name: boolean }";
  }
  if (key === "tools" && /^connections\[\d+\]$/.test(path)) {
    return "put tool overlays at connections[].roles[role].tools";
  }
  if (key === "author" && /^roles\[\d+\]$/.test(path)) {
    return "author lives on task, browser, schedules, and scripts — not on the role object";
  }
  return null;
}

function assertKeys(record: Record<string, unknown>, allowed: string[], path: string): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allow.has(key)) {
      const hint = keyHint(path, key);
      const allowedList = allowed.join(", ");
      throw new RecipeError(
        hint
          ? `unknown key ${path}.${key}; ${hint}. allowed: ${allowedList}`
          : `unknown key ${path}.${key}; allowed: ${allowedList}`,
      );
    }
  }
}

function asString(value: unknown, path: string, fallback = ""): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new RecipeError(`${path} must be a string`);
  }
  return value;
}

function asOneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  const text = asString(value, path);
  if (!(allowed as readonly string[]).includes(text)) {
    throw new RecipeError(`${path} must be one of: ${allowed.join(", ")}`);
  }
  return text as T;
}

function parseNoteKey(value: unknown, path: string): string {
  const raw = asString(value, path);
  try {
    return normalizeNoteKey(raw);
  } catch {
    throw new RecipeError(`${path} must be a .md file name with no /`);
  }
}

function parseConnectionResources(value: unknown, path: string): RecipeConnectionResource[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new RecipeError(`${path} must be an array`);
  }
  if (value.length > RECIPE_LIST_MAX) {
    throw new RecipeError(`${path} exceeds ${RECIPE_LIST_MAX} items`);
  }
  return value.map((item, index) => {
    const row = assertObject(item, `${path}[${index}]`);
    assertKeys(row, ["kind", "id", "title", "url", "use"], `${path}[${index}]`);
    const kind = asString(row.kind, `${path}[${index}].kind`);
    if (kind !== "database" && kind !== "page" && kind !== "other") {
      throw new RecipeError(`${path}[${index}].kind must be database, page, or other`);
    }
    const resource: RecipeConnectionResource = {
      kind,
      id: asString(row.id, `${path}[${index}].id`),
      title: asString(row.title, `${path}[${index}].title`),
    };
    if (row.url) {
      resource.url = asString(row.url, `${path}[${index}].url`);
    }
    if (row.use) {
      resource.use = asString(row.use, `${path}[${index}].use`);
    }
    if (!resource.id.trim() || !resource.title.trim()) {
      throw new RecipeError(`${path}[${index}] requires id and title`);
    }
    return resource;
  });
}

function parseNameSuggestion(value: unknown, path: string, fallback: string): string {
  const name = asString(value, path, fallback);
  if (!ROLE_RE.test(name)) {
    throw new RecipeError(`${path} must match ^[a-z][a-z0-9-]{0,62}$`);
  }
  if (name === "user") {
    throw new RecipeError(`${path} is reserved`);
  }
  return name;
}

function asBool(value: unknown, path: string, fallback = false): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new RecipeError(`${path} must be a boolean`);
  }
  return value;
}

function asInt(value: unknown, path: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new RecipeError(`${path} must be an integer`);
  }
  return value;
}

function byteLen(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function parseBoolMap(value: unknown, path: string): Record<string, boolean> {
  if (value === undefined) {
    return {};
  }
  const record = assertObject(value, path);
  const out: Record<string, boolean> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "boolean") {
      throw new RecipeError(`${path}.${key} must be a boolean`);
    }
    out[key] = item;
  }
  return out;
}

function parseRole(value: unknown, index: number): RecipeRole {
  const path = `roles[${index}]`;
  const record = assertObject(value, path);
  assertKeys(
    record,
    [
      "role",
      "name_suggestion",
      "focus",
      "wake_triggers",
      "avatar_shape",
      "avatar_color",
      "config",
      "task",
      "scripts",
      "schedules",
      "grants",
      "native_tools",
      "browser",
    ],
    path,
  );
  const role = asString(record.role, `${path}.role`);
  if (!ROLE_RE.test(role)) {
    throw new RecipeError(`${path}.role must match ^[a-z][a-z0-9-]{0,62}$`);
  }
  if (role === "user") {
    throw new RecipeError(`${path}.role is reserved`);
  }
  const wakeTriggers = asString(record.wake_triggers, `${path}.wake_triggers`).trim();
  if (wakeTriggers.length > WAKE_TRIGGERS_MAX) {
    throw new RecipeError(`${path}.wake_triggers must be at most ${WAKE_TRIGGERS_MAX} characters`);
  }
  const config = record.config === undefined ? {} : assertObject(record.config, `${path}.config`);
  const taskRaw = record.task === undefined ? {} : assertObject(record.task, `${path}.task`);
  assertKeys(taskRaw, ["body", "embeds", "author"], `${path}.task`);
  const body = asString(taskRaw.body, `${path}.task.body`);
  if (byteLen(body) > RECIPE_TASK_MAX_BYTES) {
    throw new RecipeError(`${path}.task.body exceeds ${RECIPE_TASK_MAX_BYTES} bytes`);
  }
  const embeds = Array.isArray(taskRaw.embeds)
    ? taskRaw.embeds.map((item, embedIndex) => asString(item, `${path}.task.embeds[${embedIndex}]`))
    : [];
  const grantsRaw = record.grants === undefined ? {} : assertObject(record.grants, `${path}.grants`);
  assertKeys(grantsRaw, ["read_guild", "write_guild", "read_org", "write_org"], `${path}.grants`);
  const browserRaw = record.browser === undefined ? {} : assertObject(record.browser, `${path}.browser`);
  assertKeys(browserRaw, ["required", "instructions", "author"], `${path}.browser`);
  const instructions = asString(browserRaw.instructions, `${path}.browser.instructions`);
  if (byteLen(instructions) > RECIPE_SETUP_MAX) {
    throw new RecipeError(`${path}.browser.instructions exceeds ${RECIPE_SETUP_MAX} bytes`);
  }
  const required = asBool(browserRaw.required, `${path}.browser.required`, Boolean(config.browser));
  if (required !== Boolean(config.browser) && config.browser !== undefined) {
    throw new RecipeError(`${path}.browser.required must match config.browser`);
  }
  return {
    role,
    name_suggestion: parseNameSuggestion(record.name_suggestion, `${path}.name_suggestion`, role),
    focus: asString(record.focus, `${path}.focus`),
    wake_triggers: wakeTriggers,
    avatar_shape: asString(record.avatar_shape, `${path}.avatar_shape`, "teardrop"),
    avatar_color: asString(record.avatar_color, `${path}.avatar_color`, "#7c5cff"),
    config,
    task: {
      body,
      embeds,
      author: parseAuthor(taskRaw.author, builderAuthor()),
    },
    scripts: Array.isArray(record.scripts)
      ? record.scripts.map((item, scriptIndex) => parseScript(item, `${path}.scripts[${scriptIndex}]`))
      : [],
    schedules: Array.isArray(record.schedules)
      ? record.schedules.map((item, scheduleIndex) => parseSchedule(item, `${path}.schedules[${scheduleIndex}]`))
      : [],
    grants: {
      read_guild: asBool(grantsRaw.read_guild, `${path}.grants.read_guild`, true),
      write_guild: asBool(grantsRaw.write_guild, `${path}.grants.write_guild`, true),
      read_org: asBool(grantsRaw.read_org, `${path}.grants.read_org`, true),
      write_org: asBool(grantsRaw.write_org, `${path}.grants.write_org`, false),
    },
    native_tools: parseBoolMap(record.native_tools, `${path}.native_tools`),
    browser: {
      required,
      instructions,
      author: parseAuthor(browserRaw.author, builderAuthor()),
    },
  };
}

function parseScript(value: unknown, path: string): RecipeScript {
  const record = assertObject(value, path);
  assertKeys(record, ["name", "description", "parameters", "source", "secrets", "author"], path);
  const source = asString(record.source, `${path}.source`);
  if (byteLen(source) > RECIPE_TASK_MAX_BYTES) {
    throw new RecipeError(`${path}.source exceeds ${RECIPE_TASK_MAX_BYTES} bytes`);
  }
  const secrets = Array.isArray(record.secrets)
    ? record.secrets.map((item, index) => asString(item, `${path}.secrets[${index}]`))
    : [];
  let parameters: Record<string, unknown> | null = null;
  if (record.parameters !== undefined && record.parameters !== null) {
    parameters = assertObject(record.parameters, `${path}.parameters`);
  }
  return {
    name: asString(record.name, `${path}.name`),
    description: asString(record.description, `${path}.description`),
    parameters,
    source,
    secrets,
    author: parseAuthor(record.author, builderAuthor()),
  };
}

function parseSchedule(value: unknown, path: string): RecipeSchedule {
  const record = assertObject(value, path);
  assertKeys(record, ["key", "cron", "window", "description", "instruction", "author"], path);
  const key = asString(record.key, `${path}.key`);
  if (!ROUTINE_KEY_RE.test(key)) {
    throw new RecipeError(`${path}.key must match ${ROUTINE_KEY_RE}`);
  }
  const instruction = asString(record.instruction, `${path}.instruction`);
  if (byteLen(instruction) > RECIPE_SETUP_MAX) {
    throw new RecipeError(`${path}.instruction exceeds ${RECIPE_SETUP_MAX} bytes`);
  }
  return {
    key,
    ...(record.cron !== undefined && record.cron !== null ? { cron: asString(record.cron, `${path}.cron`) } : {}),
    ...(record.window !== undefined && record.window !== null
      ? { window: parseWakeWindow(record.window, `${path}.window`) }
      : {}),
    description: asString(record.description, `${path}.description`),
    instruction,
    author: parseAuthor(record.author, builderAuthor()),
  };
}

function parseWakeWindow(value: unknown, path: string): WakeWindow {
  const record = assertObject(value, path);
  assertKeys(record, ["timezone", "start", "end", "max_wakes"], path);
  if (typeof record.max_wakes !== "number") {
    throw new RecipeError(`${path}.max_wakes must be a number`);
  }
  return {
    timezone: asString(record.timezone, `${path}.timezone`),
    start: asString(record.start, `${path}.start`),
    end: asString(record.end, `${path}.end`),
    max_wakes: record.max_wakes,
  };
}

function parseCollection(value: unknown, index: number): RecipeCollection {
  const path = `collections[${index}]`;
  const row = assertObject(value, path);
  assertKeys(row, ["name", "purpose", "columns", "scope", "guild", "writers"], path);
  const name = asString(row.name, `${path}.name`).trim();
  if (!COLLECTION_NAME_RE.test(name)) {
    throw new RecipeError(`${path}.name must match ${COLLECTION_NAME_RE.source}`);
  }
  const purpose = asString(row.purpose, `${path}.purpose`).trim();
  if (!purpose) {
    throw new RecipeError(`${path}.purpose is required`);
  }
  if (purpose.length > PURPOSE_MAX) {
    throw new RecipeError(`${path}.purpose exceeds ${PURPOSE_MAX} characters`);
  }
  let columns: CollectionColumn[];
  try {
    columns = parseColumns(row.columns ?? []);
  } catch (error) {
    if (error instanceof ArtifactError) {
      throw new RecipeError(`${path}.columns: ${error.message}`);
    }
    throw error;
  }
  const scope = row.scope === undefined ? "org" : row.scope;
  if (scope !== "guild" && scope !== "org") {
    throw new RecipeError(`${path}.scope must be guild or org`);
  }
  const guild = row.guild === undefined ? (scope === "guild" ? "write" : "read") : row.guild;
  if (guild !== "read" && guild !== "write") {
    throw new RecipeError(`${path}.guild must be read or write`);
  }
  if (scope === "guild" && guild !== "write") {
    throw new RecipeError(`${path}.guild must be write when scope is guild: every agent in the guild writes its own table`);
  }
  if (row.writers !== undefined && !Array.isArray(row.writers)) {
    throw new RecipeError(`${path}.writers must be an array of role names`);
  }
  const writers: string[] = [];
  for (const [writerIndex, writer] of (row.writers ?? []).entries()) {
    const role = asString(writer, `${path}.writers[${writerIndex}]`).trim();
    if (role && !writers.includes(role)) {
      writers.push(role);
    }
  }
  if (scope === "guild" && writers.length) {
    throw new RecipeError(`${path}.writers is empty when scope is guild: every agent in the guild already writes its own table`);
  }
  return { name, purpose, columns, scope, guild, writers };
}

function parseDecision(record: Record<string, unknown>, path: string): DesignDecision {
  const proposed = record.proposed_by;
  if (proposed !== "operator" && proposed !== "builder") {
    throw new RecipeError(`${path}.proposed_by must be operator or builder`);
  }
  return { proposed_by: proposed, accepted: asBool(record.accepted, `${path}.accepted`, false) };
}

function parseDesign(value: unknown): RecipeDesign {
  if (value === undefined) {
    return { systems: [], specialization: [], routines: [], handoffs: [], browser: [] };
  }
  const record = assertObject(value, "design");
  assertKeys(record, ["systems", "specialization", "routines", "handoffs", "browser"], "design");
  const systems = Array.isArray(record.systems) ? record.systems : [];
  const specialization = Array.isArray(record.specialization) ? record.specialization : [];
  const routines = Array.isArray(record.routines) ? record.routines : [];
  const handoffs = Array.isArray(record.handoffs) ? record.handoffs : [];
  const browser = Array.isArray(record.browser) ? record.browser : [];
  return {
    systems: systems.map((item, index) => {
      const row = assertObject(item, `design.systems[${index}]`);
      assertKeys(row, ["name", "resolution", "server", "reason", "proposed_by", "accepted"], `design.systems[${index}]`);
      return {
        ...parseDecision(row, `design.systems[${index}]`),
        name: asString(row.name, `design.systems[${index}].name`),
        resolution: asOneOf(row.resolution, SYSTEM_RESOLUTIONS, `design.systems[${index}].resolution`),
        ...(row.server ? { server: asString(row.server, `design.systems[${index}].server`) } : {}),
        reason: asString(row.reason, `design.systems[${index}].reason`),
      };
    }),
    specialization: specialization.map((item, index) => {
      const row = assertObject(item, `design.specialization[${index}]`);
      assertKeys(row, ["role", "reason", "detail", "proposed_by", "accepted"], `design.specialization[${index}]`);
      return {
        ...parseDecision(row, `design.specialization[${index}]`),
        role: asString(row.role, `design.specialization[${index}].role`),
        reason: asString(row.reason, `design.specialization[${index}].reason`) as RecipeDesign["specialization"][number]["reason"],
        detail: asString(row.detail, `design.specialization[${index}].detail`),
      };
    }),
    routines: routines.map((item, index) => {
      const row = assertObject(item, `design.routines[${index}]`);
      assertKeys(
        row,
        ["key", "role", "cadence", "dedupe_collection", "dedupe_key", "proposed_by", "accepted"],
        `design.routines[${index}]`,
      );
      return {
        ...parseDecision(row, `design.routines[${index}]`),
        key: asString(row.key, `design.routines[${index}].key`),
        role: asString(row.role, `design.routines[${index}].role`),
        cadence: asString(row.cadence, `design.routines[${index}].cadence`),
        ...(row.dedupe_collection
          ? { dedupe_collection: asString(row.dedupe_collection, `design.routines[${index}].dedupe_collection`) }
          : {}),
        ...(row.dedupe_key ? { dedupe_key: asString(row.dedupe_key, `design.routines[${index}].dedupe_key`) } : {}),
      };
    }),
    handoffs: handoffs.map((item, index) => {
      const row = assertObject(item, `design.handoffs[${index}]`);
      assertKeys(row, ["from", "to", "kind", "collection", "budget", "proposed_by", "accepted"], `design.handoffs[${index}]`);
      return {
        ...parseDecision(row, `design.handoffs[${index}]`),
        from: asString(row.from, `design.handoffs[${index}].from`),
        to: asString(row.to, `design.handoffs[${index}].to`),
        kind: asString(row.kind, `design.handoffs[${index}].kind`) as "collection" | "tagged",
        ...(row.collection ? { collection: asString(row.collection, `design.handoffs[${index}].collection`) } : {}),
        ...(row.budget !== undefined ? { budget: asInt(row.budget, `design.handoffs[${index}].budget`, 0) } : {}),
      };
    }),
    browser: browser.map((item, index) => {
      const row = assertObject(item, `design.browser[${index}]`);
      assertKeys(
        row,
        ["role", "site", "viable", "login_failure_policy", "proposed_by", "accepted"],
        `design.browser[${index}]`,
      );
      return {
        ...parseDecision(row, `design.browser[${index}]`),
        role: asString(row.role, `design.browser[${index}].role`),
        site: asString(row.site, `design.browser[${index}].site`),
        viable: asBool(row.viable, `design.browser[${index}].viable`, true),
        login_failure_policy: asString(row.login_failure_policy, `design.browser[${index}].login_failure_policy`),
      };
    }),
  };
}

export function parseRecipe(input: unknown): RecipeDocument {
  const encoded = Buffer.from(JSON.stringify(input ?? null), "utf8");
  if (encoded.length > RECIPE_BODY_MAX_BYTES) {
    throw new RecipeError(`recipe exceeds ${RECIPE_BODY_MAX_BYTES} bytes`);
  }
  const record = assertObject(input, "$");
  assertKeys(record, RECIPE_TOP_KEYS, "$");
  if (!Value.Check(RecipeSchema, input)) {
    const first = [...Value.Errors(RecipeSchema, input)][0];
    throw new RecipeError(first ? `${first.path || "$"} ${first.message}` : "recipe is invalid");
  }
  if (record.version !== RECIPE_VERSION) {
    throw new RecipeError(
      `unsupported recipe version ${record.version}; this build reads ${RECIPE_FORMAT} version ${RECIPE_VERSION}`,
    );
  }
  const rolesRaw = record.roles as unknown[];
  if (rolesRaw.length > RECIPE_ROLES_MAX) {
    throw new RecipeError(`at most ${RECIPE_ROLES_MAX} roles`);
  }
  const roles = rolesRaw.map((item, index) => parseRole(item, index));
  const seen = new Set<string>();
  const scheduleKeys = new Set<string>();
  for (const role of roles) {
    if (seen.has(role.role)) {
      throw new RecipeError(`duplicate role ${role.role}`);
    }
    seen.add(role.role);
    if (role.scripts.length > RECIPE_LIST_MAX || role.schedules.length > RECIPE_LIST_MAX) {
      throw new RecipeError(`role ${role.role} exceeds script or schedule cap`);
    }
    for (const schedule of role.schedules) {
      if (scheduleKeys.has(schedule.key)) {
        throw new RecipeError(`duplicate routine key ${schedule.key}`);
      }
      scheduleKeys.add(schedule.key);
    }
  }
  const collectionsRaw = (record.collections as unknown[]) ?? [];
  const notesRaw = (record.notes as unknown[]) ?? [];
  const connectionsRaw = (record.connections as unknown[]) ?? [];
  const secretsRaw = (record.secrets as unknown[]) ?? [];
  const externalRaw = (record.external as unknown[]) ?? [];
  if (
    collectionsRaw.length > RECIPE_LIST_MAX ||
    connectionsRaw.length > RECIPE_LIST_MAX ||
    secretsRaw.length > RECIPE_LIST_MAX ||
    externalRaw.length > RECIPE_LIST_MAX
  ) {
    throw new RecipeError(`collections, connections, secrets, and external are capped at ${RECIPE_LIST_MAX}`);
  }
  if (notesRaw.length > RECIPE_NOTES_MAX) {
    throw new RecipeError(`at most ${RECIPE_NOTES_MAX} notes`);
  }
  const collections = collectionsRaw.map((item, index) => parseCollection(item, index));
  const collectionNames = new Set<string>();
  for (const collection of collections) {
    if (collectionNames.has(collection.name)) {
      throw new RecipeError(`duplicate collection ${collection.name}`);
    }
    collectionNames.add(collection.name);
  }
  const notes: RecipeNote[] = notesRaw.map((item, index) => {
    const row = assertObject(item, `notes[${index}]`);
    assertKeys(row, ["id", "level", "role", "key", "body", "kind", "author"], `notes[${index}]`);
    const body = asString(row.body, `notes[${index}].body`);
    if (byteLen(body) > RECIPE_NOTE_MAX_BYTES) {
      throw new RecipeError(`notes[${index}].body exceeds ${RECIPE_NOTE_MAX_BYTES} bytes`);
    }
    const level = asString(row.level, `notes[${index}].level`);
    if (level !== "org" && level !== "guild" && level !== "agent") {
      throw new RecipeError(`notes[${index}].level must be org, guild, or agent`);
    }
    const note: RecipeNote = {
      id: asString(row.id, `notes[${index}].id`, `note-${index + 1}`),
      level,
      key: parseNoteKey(row.key, `notes[${index}].key`),
      body,
      kind: "seed",
      author: parseAuthor(row.author, operatorAuthor()),
    };
    if (row.role) {
      note.role = asString(row.role, `notes[${index}].role`);
    }
    return note;
  });
  const connections = connectionsRaw.map((item, index) => {
    const row = assertObject(item, `connections[${index}]`);
    assertKeys(
      row,
      ["server", "auth", "recommended_scope", "recommended_role", "hint", "setup", "resources", "author", "roles", "manifest"],
      `connections[${index}]`,
    );
    const server = asString(row.server, `connections[${index}].server`);
    const manifest = row.manifest === undefined ? undefined : connectionManifest(row.manifest, server, `connections[${index}].manifest`);
    const hint = asString(row.hint, `connections[${index}].hint`);
    if (hint.length > RECIPE_HINT_MAX) {
      throw new RecipeError(`connections[${index}].hint exceeds ${RECIPE_HINT_MAX} characters`);
    }
    const setup = asString(row.setup, `connections[${index}].setup`);
    if (byteLen(setup) > RECIPE_SETUP_MAX) {
      throw new RecipeError(`connections[${index}].setup exceeds ${RECIPE_SETUP_MAX} bytes`);
    }
    const auth = asString(row.auth, `connections[${index}].auth`);
    if (auth !== "oauth" && auth !== "token" && auth !== "none") {
      throw new RecipeError(`connections[${index}].auth must be oauth, token, or none`);
    }
    const scope = asString(row.recommended_scope, `connections[${index}].recommended_scope`, "guild");
    if (scope !== "org" && scope !== "guild" && scope !== "agent") {
      throw new RecipeError(`connections[${index}].recommended_scope must be org, guild, or agent`);
    }
    if (Array.isArray(row.roles)) {
      throw new RecipeError(
        `connections[${index}].roles must be an object keyed by role name, each { enabled, tools }, not an array of role names`,
      );
    }
    const roleMap = row.roles === undefined ? {} : assertObject(row.roles, `connections[${index}].roles`);
    const rolesOut: RecipeConnection["roles"] = {};
    for (const [role, spec] of Object.entries(roleMap)) {
      const specRow = assertObject(spec, `connections[${index}].roles.${role}`);
      assertKeys(specRow, ["enabled", "tools"], `connections[${index}].roles.${role}`);
      rolesOut[role] = {
        enabled: asBool(specRow.enabled, `connections[${index}].roles.${role}.enabled`),
        tools: parseBoolMap(specRow.tools, `connections[${index}].roles.${role}.tools`),
      };
    }
    const resources = parseConnectionResources(row.resources, `connections[${index}].resources`);
    return {
      server,
      auth,
      recommended_scope: scope,
      ...(row.recommended_role
        ? { recommended_role: asString(row.recommended_role, `connections[${index}].recommended_role`) }
        : {}),
      hint,
      setup,
      ...(resources ? { resources } : {}),
      author: parseAuthor(row.author, builderAuthor()),
      roles: rolesOut,
      ...(manifest ? { manifest } : {}),
    } as RecipeConnection;
  });
  const secrets = secretsRaw.map((item, index) => {
    const row = assertObject(item, `secrets[${index}]`);
    assertKeys(
      row,
      ["name", "description", "recommended_scope", "recommended_role", "roles"],
      `secrets[${index}]`,
    );
    const scope = asString(row.recommended_scope, `secrets[${index}].recommended_scope`, "guild");
    if (scope !== "org" && scope !== "guild" && scope !== "agent") {
      throw new RecipeError(`secrets[${index}].recommended_scope must be org, guild, or agent`);
    }
    return {
      name: asString(row.name, `secrets[${index}].name`),
      description: asString(row.description, `secrets[${index}].description`),
      recommended_scope: scope,
      ...(row.recommended_role
        ? { recommended_role: asString(row.recommended_role, `secrets[${index}].recommended_role`) }
        : {}),
      roles: Array.isArray(row.roles)
        ? row.roles.map((role, roleIndex) => asString(role, `secrets[${index}].roles[${roleIndex}]`))
        : [],
    } as RecipeSecret;
  });
  const external = externalRaw.map((item, index) => {
    const row = assertObject(item, `external[${index}]`);
    assertKeys(row, ["kind", "title", "setup", "author"], `external[${index}]`);
    const setup = asString(row.setup, `external[${index}].setup`);
    if (byteLen(setup) > RECIPE_SETUP_MAX) {
      throw new RecipeError(`external[${index}].setup exceeds ${RECIPE_SETUP_MAX} bytes`);
    }
    return {
      kind: asString(row.kind, `external[${index}].kind`),
      title: asString(row.title, `external[${index}].title`),
      setup,
      author: parseAuthor(row.author, builderAuthor()),
    };
  });
  const repositoriesRaw = (record.repositories as unknown[] | undefined) ?? [];
  if (repositoriesRaw.length > RECIPE_LIST_MAX) {
    throw new RecipeError(`at most ${RECIPE_LIST_MAX} repositories`);
  }
  const repositoryNames = new Set<string>();
  const repositories = repositoriesRaw.map((item, index) => {
    const row = assertObject(item, `repositories[${index}]`);
    assertKeys(row, ["name", "purpose"], `repositories[${index}]`);
    const name = asString(row.name, `repositories[${index}].name`);
    if (!COLLECTION_NAME_RE.test(name)) {
      throw new RecipeError(`repositories[${index}].name must match ${COLLECTION_NAME_RE.source}`);
    }
    if (repositoryNames.has(name)) {
      throw new RecipeError(`duplicate repository ${name}`);
    }
    repositoryNames.add(name);
    const purpose = asString(row.purpose, `repositories[${index}].purpose`);
    if (purpose.length > RECIPE_HINT_MAX) {
      throw new RecipeError(`repositories[${index}].purpose exceeds ${RECIPE_HINT_MAX} characters`);
    }
    return { name, purpose };
  });
  const meta = record.meta as RecipeDocument["meta"];
  const guild = record.guild as RecipeDocument["guild"];
  return {
    format: RECIPE_FORMAT,
    version: RECIPE_VERSION,
    meta,
    guild,
    roles,
    collections,
    notes,
    connections,
    secrets,
    external,
    repositories,
    design: parseDesign(record.design),
  };
}

export function unreviewedFields(recipe: RecipeDocument): string[] {
  const fields: string[] = [];
  const push = (path: string, author: FieldAuthor) => {
    if (!author.reviewed) {
      fields.push(path);
    }
  };
  for (const role of recipe.roles) {
    push(`roles.${role.role}.task`, role.task.author);
    if (role.browser.required || role.config.browser) {
      push(`roles.${role.role}.browser`, role.browser.author);
    }
    for (const script of role.scripts) {
      push(`roles.${role.role}.scripts.${script.name}`, script.author);
    }
    for (const schedule of role.schedules) {
      push(`roles.${role.role}.schedules.${schedule.key}`, schedule.author);
    }
  }
  for (const note of recipe.notes) {
    push(`notes.${note.id}`, note.author);
  }
  for (const connection of recipe.connections) {
    push(`connections.${connection.server}.setup`, connection.author);
  }
  for (const [index, card] of recipe.external.entries()) {
    push(`external[${index}]`, card.author);
  }
  return fields;
}

function sameContent(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function preserveOrBuilder(
  previous: FieldAuthor | undefined,
  previousContent: unknown,
  nextContent: unknown,
): FieldAuthor {
  if (previous?.reviewed && sameContent(previousContent, nextContent)) {
    return previous;
  }
  return builderAuthor();
}

export function stampBuilderWrite(next: RecipeDocument, previous: RecipeDocument | null): RecipeDocument {
  const prevRoles = new Map((previous?.roles ?? []).map((role) => [role.role, role]));
  const prevNotes = new Map((previous?.notes ?? []).map((note) => [note.id, note]));
  const prevConnections = new Map((previous?.connections ?? []).map((item) => [item.server, item]));
  const prevExternal = previous?.external ?? [];
  for (const role of next.roles) {
    const prev = prevRoles.get(role.role);
    role.task.author = preserveOrBuilder(prev?.task.author, prev?.task.body, role.task.body);
    role.browser.author = preserveOrBuilder(
      prev?.browser.author,
      prev?.browser.instructions,
      role.browser.instructions,
    );
    const prevScripts = new Map((prev?.scripts ?? []).map((item) => [item.name, item]));
    for (const script of role.scripts) {
      const prior = prevScripts.get(script.name);
      script.author = preserveOrBuilder(prior?.author, prior?.source, script.source);
    }
    const prevSchedules = new Map((prev?.schedules ?? []).map((item) => [item.key, item]));
    for (const schedule of role.schedules) {
      const prior = prevSchedules.get(schedule.key);
      schedule.author = preserveOrBuilder(
        prior?.author,
        { cron: prior?.cron, instruction: prior?.instruction },
        { cron: schedule.cron, instruction: schedule.instruction },
      );
    }
  }
  for (const note of next.notes) {
    const prior = prevNotes.get(note.id);
    note.author = preserveOrBuilder(prior?.author, prior?.body, note.body);
  }
  for (const connection of next.connections) {
    const prior = prevConnections.get(connection.server);
    connection.author = preserveOrBuilder(
      prior?.author,
      { setup: prior?.setup, resources: prior?.resources },
      { setup: connection.setup, resources: connection.resources },
    );
  }
  for (const [index, card] of next.external.entries()) {
    const prior = prevExternal[index];
    card.author = preserveOrBuilder(prior?.author, prior?.setup, card.setup);
  }
  return next;
}

export function applyReview(
  recipe: RecipeDocument,
  path: string,
  action: "confirm" | "edit",
  value?: string,
): void {
  const next = (author: FieldAuthor): FieldAuthor =>
    action === "edit" ? operatorAuthor() : markReviewed(author);
  const roles = path.match(/^roles\.([a-z][a-z0-9-]{0,62})\.(task|browser)$/);
  if (roles) {
    const role = recipe.roles.find((item) => item.role === roles[1]);
    if (!role) throw new RecipeError("field not found", 404);
    if (roles[2] === "task") {
      role.task.author = next(role.task.author);
      if (action === "edit" && value !== undefined) role.task.body = value;
    } else {
      role.browser.author = next(role.browser.author);
      if (action === "edit" && value !== undefined) role.browser.instructions = value;
    }
    return;
  }
  const script = path.match(/^roles\.([a-z][a-z0-9-]{0,62})\.scripts\.([a-z][a-z0-9_-]{0,62})$/);
  if (script) {
    const role = recipe.roles.find((item) => item.role === script[1]);
    const item = role?.scripts.find((row) => row.name === script[2]);
    if (!item) throw new RecipeError("field not found", 404);
    item.author = next(item.author);
    if (action === "edit" && value !== undefined) item.source = value;
    return;
  }
  const schedule = path.match(/^roles\.([a-z][a-z0-9-]{0,62})\.schedules\.([a-z][a-z0-9-]{0,62})$/);
  if (schedule) {
    const role = recipe.roles.find((item) => item.role === schedule[1]);
    const item = role?.schedules.find((row) => row.key === schedule[2]);
    if (!item) throw new RecipeError("field not found", 404);
    item.author = next(item.author);
    if (action === "edit" && value !== undefined) item.instruction = value;
    return;
  }
  const setup = path.match(/^connections\.([a-z0-9][a-z0-9-]{0,62})\.setup$/);
  if (setup) {
    const connection = recipe.connections.find((item) => item.server === setup[1]);
    if (!connection) throw new RecipeError("field not found", 404);
    connection.author = next(connection.author);
    if (action === "edit" && value !== undefined) connection.setup = value;
    return;
  }
  const note = path.match(/^notes\.([A-Za-z0-9._:-]+)$/);
  if (note) {
    const item = recipe.notes.find((row) => row.id === note[1]);
    if (!item) throw new RecipeError("field not found", 404);
    item.author = next(item.author);
    if (action === "edit" && value !== undefined) item.body = value;
    return;
  }
  const external = path.match(/^external\[(\d+)\]$/);
  if (external) {
    const item = recipe.external[Number(external[1])];
    if (!item) throw new RecipeError("field not found", 404);
    item.author = next(item.author);
    if (action === "edit" && value !== undefined) item.setup = value;
    return;
  }
  throw new RecipeError("field not found", 404);
}

export type AccessCut = {
  kind: "tool" | "connector";
  server: string;
  role?: string;
  tool?: string;
};

export type AccessEdit =
  | { action: "set_tool"; server: string; role: string; tool: string; enabled: boolean }
  | { action: "remove_connection"; server: string };

function recordOperatorRemovedConnector(recipe: RecipeDocument, server: string): void {
  const existing = recipe.design.systems.find((item) => item.server === server || item.name === server);
  if (existing) {
    existing.resolution = "refused";
    existing.proposed_by = "operator";
    existing.accepted = true;
    existing.server = existing.server || server;
    if (!existing.reason.startsWith("Operator removed")) {
      existing.reason = existing.reason.trim()
        ? `Operator removed this connector. ${existing.reason}`
        : "Operator removed this connector.";
    }
    return;
  }
  recipe.design.systems.push({
    name: server,
    server,
    resolution: "refused",
    reason: "Operator removed this connector.",
    proposed_by: "operator",
    accepted: true,
  });
}

export function operatorAccessCuts(recipe: RecipeDocument): AccessCut[] {
  const cuts: AccessCut[] = [];
  for (const connection of recipe.connections) {
    for (const [role, spec] of Object.entries(connection.roles)) {
      for (const [tool, enabled] of Object.entries(spec.tools)) {
        if (enabled === false) {
          cuts.push({ kind: "tool", server: connection.server, role, tool });
        }
      }
    }
  }
  const live = new Set(recipe.connections.map((item) => item.server));
  for (const system of recipe.design.systems) {
    if (system.resolution !== "refused" || system.proposed_by !== "operator") {
      continue;
    }
    const server = system.server || system.name;
    if (!server || live.has(server)) {
      continue;
    }
    cuts.push({ kind: "connector", server });
  }
  return cuts;
}

export function applyAccessEdit(recipe: RecipeDocument, edit: AccessEdit): AccessCut[] {
  if (edit.action === "set_tool") {
    const connection = recipe.connections.find((item) => item.server === edit.server);
    if (!connection) {
      throw new RecipeError("connection not found", 404);
    }
    if (!recipe.roles.some((role) => role.role === edit.role)) {
      throw new RecipeError("role not found", 404);
    }
    if (!edit.tool.trim()) {
      throw new RecipeError("tool is required");
    }
    const spec = connection.roles[edit.role] ?? { enabled: true, tools: {} };
    if (edit.enabled) {
      delete spec.tools[edit.tool];
    } else {
      spec.tools[edit.tool] = false;
    }
    connection.roles[edit.role] = spec;
    return operatorAccessCuts(recipe);
  }
  const index = recipe.connections.findIndex((item) => item.server === edit.server);
  if (index < 0) {
    throw new RecipeError("connection not found", 404);
  }
  recipe.connections.splice(index, 1);
  recordOperatorRemovedConnector(recipe, edit.server);
  return operatorAccessCuts(recipe);
}

export function applyAccessEdits(recipe: RecipeDocument, edits: AccessEdit[]): AccessCut[] {
  for (const edit of edits) {
    applyAccessEdit(recipe, edit);
  }
  return operatorAccessCuts(recipe);
}

export function parseAccessEdits(value: unknown): AccessEdit[] {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const raw = Array.isArray(value) ? value : record.edits;
  if (!Array.isArray(raw)) {
    throw new RecipeError("edits must be an array");
  }
  return raw.map((item, index) => {
    const row = assertObject(item, `edits[${index}]`);
    const action = asString(row.action, `edits[${index}].action`);
    const server = asString(row.server, `edits[${index}].server`).trim();
    if (!server) {
      throw new RecipeError(`edits[${index}].server is required`);
    }
    if (action === "remove_connection") {
      return { action, server };
    }
    if (action !== "set_tool") {
      throw new RecipeError(`edits[${index}].action must be set_tool or remove_connection`);
    }
    return {
      action,
      server,
      role: asString(row.role, `edits[${index}].role`).trim(),
      tool: asString(row.tool, `edits[${index}].tool`).trim(),
      enabled: asBool(row.enabled, `edits[${index}].enabled`),
    };
  });
}

export function formatAccessCutsMessage(cuts: AccessCut[]): string {
  if (!cuts.length) {
    return "";
  }
  const lines = cuts.map((cut) =>
    cut.kind === "tool"
      ? `- tool ${cut.tool} from ${cut.server} for ${cut.role}`
      : `- connector ${cut.server}`,
  );
  return [
    "I validated connector access. I removed:",
    ...lines,
    "Update standing prompts if they rely on these, or ask me questions.",
  ].join("\n");
}

export function hasForbiddenSecrets(value: unknown): boolean {
  const text = JSON.stringify(value).toLowerCase();
  return (
    text.includes("ciphertext") ||
    text.includes("oauth_client") ||
    text.includes("refresh_token") ||
    text.includes("access_token") ||
    text.includes("private_key")
  );
}

export { StringMapBool };
