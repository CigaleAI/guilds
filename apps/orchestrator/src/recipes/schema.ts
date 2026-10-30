import { NAME_RE } from "../lib/names.js";
import type { FieldAuthor } from "../db/schema/index.js";

// The `guilds.recipe` document's caps and author helpers. Its schema and types sit beside the
// `recipes` table (db/schema/recipe-document.ts), and code imports them from db/schema; the box
// reads a document into them in parse.ts.

export const RECIPE_VERSION = 2;
export const RECIPE_BODY_MAX_BYTES = 4 * 1024 * 1024;
export const RECIPE_ROLES_MAX = 20;
export const RECIPE_TASK_MAX_BYTES = 256 * 1024;
export const RECIPE_NOTE_MAX_BYTES = 256 * 1024;
export const RECIPE_NOTES_MAX = 64;
export const RECIPE_HINT_MAX = 400;
export const RECIPE_SETUP_MAX = 8 * 1024;
export const RECIPE_LIST_MAX = 50;
export const ROLE_RE = NAME_RE;
export const ROUTINE_KEY_RE = /^[a-z][a-z0-9-]{0,62}$/;

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
