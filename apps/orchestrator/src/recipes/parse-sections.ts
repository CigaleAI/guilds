import { parseColumns } from "../artifacts/columns.js";
import { ArtifactError } from "../artifacts/errors.js";
import { normalizeNoteKey } from "../artifacts/paths.js";
import { COLLECTION_NAME_RE, PURPOSE_MAX, isAccessMode } from "../artifacts/types.js";
import { loadManifest, ManifestError, recipeManifestProblem } from "../connectors/manifest.js";
import {
  SYSTEM_RESOLUTIONS,
  type CollectionColumn,
  type AccessMode,
  type ConnectionResource,
  type Manifest,
  type DesignDecision,
  type RecipeCollection,
  type RecipeConnection,
  type RecipeDesign,
  type RecipeExternal,
  type RecipeNote,
  type RecipeRepository,
  type RecipeSecret,
} from "../db/schema/index.js";
import { RecipeError } from "./errors.js";
import {
  asBool,
  asInt,
  asOneOf,
  asString,
  assertKeys,
  assertObject,
  boundedText,
  listOf,
  parseAuthor,
  parseBoolMap,
  parseWriters,
  textList,
} from "./parse-fields.js";
import { builderAuthor, operatorAuthor, RECIPE_HINT_MAX, RECIPE_LIST_MAX, RECIPE_NOTE_MAX_BYTES, RECIPE_SETUP_MAX } from "./schema.js";

// The sections of a recipe beside its roles: collections, notes, connections, secrets, external
// setup cards, repositories, and the design record.

function parseColumnsAt(value: unknown, path: string): CollectionColumn[] {
  try {
    return parseColumns(value ?? []);
  } catch (error) {
    if (error instanceof ArtifactError) {
      throw new RecipeError(`${path}: ${error.message}`);
    }
    throw error;
  }
}

function parsePurpose(value: unknown, path: string): string {
  const purpose = asString(value, path).trim();
  if (!purpose) {
    throw new RecipeError(`${path} is required`);
  }
  if (purpose.length > PURPOSE_MAX) {
    throw new RecipeError(`${path} exceeds ${PURPOSE_MAX} characters`);
  }
  return purpose;
}

/**
 * A collection's scope and the guild's mode on it. A guild's own table is written by every agent
 * of the guild: it takes `guild: "write"` and no writers.
 */
function parseCollectionScope(value: unknown, path: string): RecipeCollection["scope"] {
  const scope = value === undefined ? "org" : value;
  if (scope !== "guild" && scope !== "org") {
    throw new RecipeError(`${path} must be guild or org`);
  }
  return scope;
}

/** The guild's mode on a collection: write on its own table, read on the organisation's, unless the recipe says. */
function parseCollectionGuild(value: unknown, scope: RecipeCollection["scope"], path: string): AccessMode {
  const guild = value === undefined ? (scope === "guild" ? "write" : "read") : value;
  if (guild !== "read" && guild !== "write") {
    throw new RecipeError(`${path} must be read or write`);
  }
  return guild;
}

function parseCollectionAccess(row: Record<string, unknown>, path: string): Pick<RecipeCollection, "scope" | "guild" | "writers"> {
  const scope = parseCollectionScope(row.scope, `${path}.scope`);
  const guild = parseCollectionGuild(row.guild, scope, `${path}.guild`);
  if (scope === "guild" && guild !== "write") {
    throw new RecipeError(`${path}.guild must be write when scope is guild: every agent in the guild writes its own table`);
  }
  const writers = parseWriters(row.writers, `${path}.writers`);
  if (scope === "guild" && writers.length) {
    throw new RecipeError(`${path}.writers is empty when scope is guild: every agent in the guild already writes its own table`);
  }
  return { scope, guild, writers };
}

export function parseCollection(value: unknown, index: number): RecipeCollection {
  const path = `collections[${index}]`;
  const row = assertObject(value, path);
  assertKeys(row, ["name", "purpose", "columns", "scope", "guild", "writers"], path);
  const name = asString(row.name, `${path}.name`).trim();
  if (!COLLECTION_NAME_RE.test(name)) {
    throw new RecipeError(`${path}.name must match ${COLLECTION_NAME_RE.source}`);
  }
  const purpose = parsePurpose(row.purpose, `${path}.purpose`);
  const columns = parseColumnsAt(row.columns, `${path}.columns`);
  return { name, purpose, columns, ...parseCollectionAccess(row, path) };
}

function parseNoteKey(value: unknown, path: string): string {
  const raw = asString(value, path);
  try {
    return normalizeNoteKey(raw);
  } catch {
    throw new RecipeError(`${path} must be a .md file name with no /`);
  }
}

/** The mode a note's level gives the guild when the recipe names none. */
const NOTE_GUILD_DEFAULT: Record<RecipeNote["level"], AccessMode | undefined> = {
  org: "read",
  guild: "write",
  agent: undefined,
};

function parseNoteGuild(value: unknown, level: RecipeNote["level"], path: string): AccessMode | undefined {
  const guild = value === undefined ? NOTE_GUILD_DEFAULT[level] : value;
  if (guild === undefined || isAccessMode(guild)) {
    return guild;
  }
  throw new RecipeError(`${path} must be read or write`);
}

/** A note's `guild` and `writers`, defaulting `guild` to what the note's level gives. A guild note takes guild write and no writers. */
function parseNoteAccess(row: Record<string, unknown>, level: RecipeNote["level"], path: string): Pick<RecipeNote, "guild" | "writers"> {
  const guild = parseNoteGuild(row.guild, level, `${path}.guild`);
  const writers = parseWriters(row.writers, `${path}.writers`);
  if (level === "guild" && (guild !== "write" || writers.length)) {
    throw new RecipeError(`${path} takes guild write and no writers: every agent in the guild already writes a guild note`);
  }
  return guild === undefined ? { writers } : { guild, writers };
}

function parseNoteLevel(value: unknown, path: string): RecipeNote["level"] {
  const level = asString(value, path);
  if (level !== "org" && level !== "guild" && level !== "agent") {
    throw new RecipeError(`${path} must be org, guild, or agent`);
  }
  return level;
}

export function parseNote(item: unknown, index: number): RecipeNote {
  const path = `notes[${index}]`;
  const row = assertObject(item, path);
  assertKeys(row, ["id", "level", "role", "key", "body", "kind", "author", "guild", "writers"], path);
  const body = boundedText(row.body, `${path}.body`, RECIPE_NOTE_MAX_BYTES);
  const level = parseNoteLevel(row.level, `${path}.level`);
  return {
    id: asString(row.id, `${path}.id`, `note-${index + 1}`),
    level,
    key: parseNoteKey(row.key, `${path}.key`),
    body,
    kind: "seed",
    author: parseAuthor(row.author, operatorAuthor()),
    ...parseNoteAccess(row, level, path),
    ...(row.role ? { role: asString(row.role, `${path}.role`) } : {}),
  };
}

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

function parseResource(item: unknown, path: string): ConnectionResource {
  const row = assertObject(item, path);
  assertKeys(row, ["kind", "id", "title", "url", "use"], path);
  const kind = asString(row.kind, `${path}.kind`);
  if (kind !== "database" && kind !== "page" && kind !== "other") {
    throw new RecipeError(`${path}.kind must be database, page, or other`);
  }
  const resource: ConnectionResource = {
    kind,
    id: asString(row.id, `${path}.id`),
    title: asString(row.title, `${path}.title`),
    ...(row.url ? { url: asString(row.url, `${path}.url`) } : {}),
    ...(row.use ? { use: asString(row.use, `${path}.use`) } : {}),
  };
  if (!resource.id.trim() || !resource.title.trim()) {
    throw new RecipeError(`${path} requires id and title`);
  }
  return resource;
}

function parseConnectionResources(value: unknown, path: string): ConnectionResource[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new RecipeError(`${path} must be an array`);
  }
  if (value.length > RECIPE_LIST_MAX) {
    throw new RecipeError(`${path} exceeds ${RECIPE_LIST_MAX} items`);
  }
  return value.map((item, index) => parseResource(item, `${path}[${index}]`));
}

/** Each role's switch and tool overlays on a connection, keyed by role name. */
function parseConnectionRoles(value: unknown, path: string): RecipeConnection["roles"] {
  if (Array.isArray(value)) {
    throw new RecipeError(`${path} must be an object keyed by role name, each { enabled, tools }, not an array of role names`);
  }
  const roles: RecipeConnection["roles"] = {};
  for (const [role, spec] of Object.entries(value === undefined ? {} : assertObject(value, path))) {
    const specRow = assertObject(spec, `${path}.${role}`);
    assertKeys(specRow, ["enabled", "tools"], `${path}.${role}`);
    roles[role] = {
      enabled: asBool(specRow.enabled, `${path}.${role}.enabled`),
      tools: parseBoolMap(specRow.tools, `${path}.${role}.tools`),
    };
  }
  return roles;
}

function parseAuth(value: unknown, path: string): RecipeConnection["auth"] {
  const auth = asString(value, path);
  if (auth !== "oauth" && auth !== "token" && auth !== "none") {
    throw new RecipeError(`${path} must be oauth, token, or none`);
  }
  return auth;
}

/** The scope a connection or secret is recommended at; the guild when the recipe names none. */
function parseRecommendedScope(value: unknown, path: string): RecipeSecret["recommended_scope"] {
  const scope = asString(value, path, "guild");
  if (scope !== "org" && scope !== "guild" && scope !== "agent") {
    throw new RecipeError(`${path} must be org, guild, or agent`);
  }
  return scope;
}

const CONNECTION_KEYS = ["server", "auth", "recommended_scope", "recommended_role", "hint", "setup", "resources", "author", "roles", "manifest"];

export function parseConnection(item: unknown, index: number): RecipeConnection {
  const path = `connections[${index}]`;
  const row = assertObject(item, path);
  assertKeys(row, CONNECTION_KEYS, path);
  const server = asString(row.server, `${path}.server`);
  const manifest = row.manifest === undefined ? undefined : connectionManifest(row.manifest, server, `${path}.manifest`);
  const hint = asString(row.hint, `${path}.hint`);
  if (hint.length > RECIPE_HINT_MAX) {
    throw new RecipeError(`${path}.hint exceeds ${RECIPE_HINT_MAX} characters`);
  }
  const setup = boundedText(row.setup, `${path}.setup`, RECIPE_SETUP_MAX);
  const auth = parseAuth(row.auth, `${path}.auth`);
  const scope = parseRecommendedScope(row.recommended_scope, `${path}.recommended_scope`);
  const roles = parseConnectionRoles(row.roles, `${path}.roles`);
  const resources = parseConnectionResources(row.resources, `${path}.resources`);
  return {
    server,
    auth,
    recommended_scope: scope,
    ...(row.recommended_role ? { recommended_role: asString(row.recommended_role, `${path}.recommended_role`) } : {}),
    hint,
    setup,
    ...(resources ? { resources } : {}),
    author: parseAuthor(row.author, builderAuthor()),
    roles,
    ...(manifest ? { manifest } : {}),
  };
}

export function parseSecret(item: unknown, index: number): RecipeSecret {
  const path = `secrets[${index}]`;
  const row = assertObject(item, path);
  assertKeys(row, ["name", "description", "recommended_scope", "recommended_role", "roles"], path);
  const scope = parseRecommendedScope(row.recommended_scope, `${path}.recommended_scope`);
  return {
    name: asString(row.name, `${path}.name`),
    description: asString(row.description, `${path}.description`),
    recommended_scope: scope,
    ...(row.recommended_role ? { recommended_role: asString(row.recommended_role, `${path}.recommended_role`) } : {}),
    roles: textList(row.roles, `${path}.roles`),
  };
}

export function parseExternal(item: unknown, index: number): RecipeExternal {
  const path = `external[${index}]`;
  const row = assertObject(item, path);
  assertKeys(row, ["kind", "title", "setup", "author"], path);
  const setup = boundedText(row.setup, `${path}.setup`, RECIPE_SETUP_MAX);
  return {
    kind: asString(row.kind, `${path}.kind`),
    title: asString(row.title, `${path}.title`),
    setup,
    author: parseAuthor(row.author, builderAuthor()),
  };
}

/** The repositories the guild needs, each named once. */
export function parseRepositories(value: unknown): RecipeRepository[] {
  const items = listOf(value);
  if (items.length > RECIPE_LIST_MAX) {
    throw new RecipeError(`at most ${RECIPE_LIST_MAX} repositories`);
  }
  const names = new Set<string>();
  return items.map((item, index) => {
    const path = `repositories[${index}]`;
    const row = assertObject(item, path);
    assertKeys(row, ["name", "purpose"], path);
    const name = asString(row.name, `${path}.name`);
    if (!COLLECTION_NAME_RE.test(name)) {
      throw new RecipeError(`${path}.name must match ${COLLECTION_NAME_RE.source}`);
    }
    if (names.has(name)) {
      throw new RecipeError(`duplicate repository ${name}`);
    }
    names.add(name);
    const purpose = asString(row.purpose, `${path}.purpose`);
    if (purpose.length > RECIPE_HINT_MAX) {
      throw new RecipeError(`${path}.purpose exceeds ${RECIPE_HINT_MAX} characters`);
    }
    return { name, purpose };
  });
}

/** A design entry's fields: the decision every entry carries, under its own keys. */
function designEntry(item: unknown, path: string, keys: string[]): { row: Record<string, unknown>; decision: DesignDecision } {
  const row = assertObject(item, path);
  assertKeys(row, [...keys, "proposed_by", "accepted"], path);
  const proposed = row.proposed_by;
  if (proposed !== "operator" && proposed !== "builder") {
    throw new RecipeError(`${path}.proposed_by must be operator or builder`);
  }
  return { row, decision: { proposed_by: proposed, accepted: asBool(row.accepted, `${path}.accepted`, false) } };
}

const SPECIALIZATION_REASONS = ["narrower_tools", "narrower_access", "narrower_context", "volume", "other"] as const;
const HANDOFF_KINDS = ["collection", "tagged"] as const;

function parseSystem(item: unknown, index: number): RecipeDesign["systems"][number] {
  const path = `design.systems[${index}]`;
  const { row, decision } = designEntry(item, path, ["name", "resolution", "server", "reason"]);
  return {
    ...decision,
    name: asString(row.name, `${path}.name`),
    resolution: asOneOf(row.resolution, SYSTEM_RESOLUTIONS, `${path}.resolution`),
    ...(row.server ? { server: asString(row.server, `${path}.server`) } : {}),
    reason: asString(row.reason, `${path}.reason`),
  };
}

function parseSpecialization(item: unknown, index: number): RecipeDesign["specialization"][number] {
  const path = `design.specialization[${index}]`;
  const { row, decision } = designEntry(item, path, ["role", "reason", "detail"]);
  return {
    ...decision,
    role: asString(row.role, `${path}.role`),
    reason: asOneOf(row.reason, SPECIALIZATION_REASONS, `${path}.reason`),
    detail: asString(row.detail, `${path}.detail`),
  };
}

function parseDesignRoutine(item: unknown, index: number): RecipeDesign["routines"][number] {
  const path = `design.routines[${index}]`;
  const { row, decision } = designEntry(item, path, ["key", "role", "cadence", "dedupe_collection", "dedupe_key"]);
  return {
    ...decision,
    key: asString(row.key, `${path}.key`),
    role: asString(row.role, `${path}.role`),
    cadence: asString(row.cadence, `${path}.cadence`),
    ...(row.dedupe_collection ? { dedupe_collection: asString(row.dedupe_collection, `${path}.dedupe_collection`) } : {}),
    ...(row.dedupe_key ? { dedupe_key: asString(row.dedupe_key, `${path}.dedupe_key`) } : {}),
  };
}

function parseHandoff(item: unknown, index: number): RecipeDesign["handoffs"][number] {
  const path = `design.handoffs[${index}]`;
  const { row, decision } = designEntry(item, path, ["from", "to", "kind", "collection", "budget"]);
  return {
    ...decision,
    from: asString(row.from, `${path}.from`),
    to: asString(row.to, `${path}.to`),
    kind: asOneOf(row.kind, HANDOFF_KINDS, `${path}.kind`),
    ...(row.collection ? { collection: asString(row.collection, `${path}.collection`) } : {}),
    ...(row.budget !== undefined ? { budget: asInt(row.budget, `${path}.budget`, 0) } : {}),
  };
}

function parseDesignBrowser(item: unknown, index: number): RecipeDesign["browser"][number] {
  const path = `design.browser[${index}]`;
  const { row, decision } = designEntry(item, path, ["role", "site", "viable", "login_failure_policy"]);
  return {
    ...decision,
    role: asString(row.role, `${path}.role`),
    site: asString(row.site, `${path}.site`),
    viable: asBool(row.viable, `${path}.viable`, true),
    login_failure_policy: asString(row.login_failure_policy, `${path}.login_failure_policy`),
  };
}

export function parseDesign(value: unknown): RecipeDesign {
  if (value === undefined) {
    return { systems: [], specialization: [], routines: [], handoffs: [], browser: [] };
  }
  const record = assertObject(value, "design");
  assertKeys(record, ["systems", "specialization", "routines", "handoffs", "browser"], "design");
  return {
    systems: listOf(record.systems).map(parseSystem),
    specialization: listOf(record.specialization).map(parseSpecialization),
    routines: listOf(record.routines).map(parseDesignRoutine),
    handoffs: listOf(record.handoffs).map(parseHandoff),
    browser: listOf(record.browser).map(parseDesignBrowser),
  };
}
