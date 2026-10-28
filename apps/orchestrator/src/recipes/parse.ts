import { Value } from "@sinclair/typebox/value";
import { RecipeError } from "./errors.js";
import { assertKeys, assertObject } from "./parse-fields.js";
import { parseRole } from "./parse-roles.js";
import {
  parseCollection,
  parseConnection,
  parseDesign,
  parseExternal,
  parseNote,
  parseRepositories,
  parseSecret,
} from "./parse-sections.js";
import {
  RECIPE_FORMAT,
  RecipeSchema,
  type RecipeCollection,
  type RecipeDocument,
  type RecipeRole,
} from "../db/schema/index.js";
import { RECIPE_BODY_MAX_BYTES, RECIPE_LIST_MAX, RECIPE_NOTES_MAX, RECIPE_ROLES_MAX, RECIPE_VERSION } from "./schema.js";

// A recipe document as the box reads it: checked against the schema, each section parsed with
// its defaults, and every cap and uniqueness rule applied. An error names the field at fault.

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

/** The document checked against the schema and the version this build reads. */
function checkedDocument(input: unknown) {
  const encoded = Buffer.from(JSON.stringify(input ?? null), "utf8");
  if (encoded.length > RECIPE_BODY_MAX_BYTES) {
    throw new RecipeError(`recipe exceeds ${RECIPE_BODY_MAX_BYTES} bytes`);
  }
  assertKeys(assertObject(input, "$"), RECIPE_TOP_KEYS, "$");
  if (!Value.Check(RecipeSchema, input)) {
    const first = Value.Errors(RecipeSchema, input).First();
    throw new RecipeError(first ? `${first.path || "$"} ${first.message}` : "recipe is invalid");
  }
  if (input.version !== RECIPE_VERSION) {
    throw new RecipeError(
      `unsupported recipe version ${input.version}; this build reads ${RECIPE_FORMAT} version ${RECIPE_VERSION}`,
    );
  }
  return input;
}

/** The roles, each named once, within the caps on roles, scripts and routines; routine keys are unique across roles. */
function parseRoles(items: unknown[]): RecipeRole[] {
  if (items.length > RECIPE_ROLES_MAX) {
    throw new RecipeError(`at most ${RECIPE_ROLES_MAX} roles`);
  }
  const roles = items.map((item, index) => parseRole(item, index));
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
  return roles;
}

function parseCollections(items: unknown[]): RecipeCollection[] {
  const collections = items.map((item, index) => parseCollection(item, index));
  const names = new Set<string>();
  for (const collection of collections) {
    if (names.has(collection.name)) {
      throw new RecipeError(`duplicate collection ${collection.name}`);
    }
    names.add(collection.name);
  }
  return collections;
}

/** Refuses more collections, connections, secrets, external cards or notes than a recipe may hold. */
function assertListCaps(document: ReturnType<typeof checkedDocument>): void {
  const capped = [document.collections, document.connections, document.secrets, document.external];
  if (capped.some((items) => items.length > RECIPE_LIST_MAX)) {
    throw new RecipeError(`collections, connections, secrets, and external are capped at ${RECIPE_LIST_MAX}`);
  }
  if (document.notes.length > RECIPE_NOTES_MAX) {
    throw new RecipeError(`at most ${RECIPE_NOTES_MAX} notes`);
  }
}

export function parseRecipe(input: unknown): RecipeDocument {
  const document = checkedDocument(input);
  const roles = parseRoles(document.roles);
  assertListCaps(document);
  return {
    format: RECIPE_FORMAT,
    version: RECIPE_VERSION,
    meta: document.meta,
    guild: document.guild,
    roles,
    collections: parseCollections(document.collections),
    notes: document.notes.map(parseNote),
    connections: document.connections.map(parseConnection),
    secrets: document.secrets.map(parseSecret),
    external: document.external.map(parseExternal),
    repositories: parseRepositories(document.repositories),
    design: parseDesign(document.design),
  };
}
