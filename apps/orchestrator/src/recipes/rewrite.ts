import { TAG_RE } from "../groupchat/index.js";
import { isDisplayPath } from "../artifacts/paths.js";
import type { RecipeNote } from "./schema.js";

const RECIPE_EMBED_RE = /!\[\[recipe:([^\]]+)\]\]/g;
const DISPLAY_EMBED_RE = /!\[\[([^\]]+)\]\]/g;

export function rewriteTagsToRoles(text: string, nameToRole: Map<string, string>): string {
  return text.replace(TAG_RE, (match, name: string) => {
    if (name === "user") {
      return match;
    }
    const role = nameToRole.get(name);
    return role ? `@{${role}}` : match;
  });
}

export function rewriteRolesToNames(text: string, roleToName: Map<string, string>): string {
  return text.replace(/@\{([a-z][a-z0-9-]{0,62})\}/g, (match, role: string) => {
    const name = roleToName.get(role);
    return name ? `@${name}` : match;
  });
}

export function recipeNotePath(note: Pick<RecipeNote, "level" | "role" | "key">): string {
  if (note.level === "agent") {
    return `agent/${note.role || "_"}/${note.key}`;
  }
  return `${note.level}/${note.key}`;
}

export function rewriteHrefsToRecipeIds(text: string, hrefToNoteId: Map<string, string>): string {
  return text.replace(DISPLAY_EMBED_RE, (match, href: string) => {
    const id = hrefToNoteId.get(href.trim());
    return id ? `![[recipe:${id}]]` : match;
  });
}

export function rewriteHrefsToRecipeRefs(text: string, hrefToRef: Map<string, string>): string {
  return text.replace(DISPLAY_EMBED_RE, (match, href: string) => {
    const ref = hrefToRef.get(href.trim());
    return ref ? `![[${ref}]]` : match;
  });
}

export function rewriteRecipeIdsToHrefs(text: string, noteIdToHref: Map<string, string>): string {
  return text.replace(RECIPE_EMBED_RE, (match, id: string) => {
    const href = noteIdToHref.get(id);
    return href ? `![[${href}]]` : match;
  });
}

export function rewriteRecipeEmbedsToDisplayPaths(
  text: string,
  resolved: Map<string, string>,
): { text: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const next = text.replace(DISPLAY_EMBED_RE, (match, href: string) => {
    const key = href.trim();
    const display = resolved.get(key) ?? (key.startsWith("recipe:") ? resolved.get(key.slice("recipe:".length)) : undefined);
    if (display) {
      return `![[${display}]]`;
    }
    if (isDisplayPath(key)) {
      return match;
    }
    unresolved.push(key);
    return match;
  });
  return { text: next, unresolved };
}

export function rewriteGuildTextToRecipe(
  text: string,
  nameToRole: Map<string, string>,
  hrefToNoteId: Map<string, string>,
): string {
  return rewriteHrefsToRecipeIds(rewriteTagsToRoles(text, nameToRole), hrefToNoteId);
}

export function rewriteGuildTextToRecipeRefs(
  text: string,
  nameToRole: Map<string, string>,
  hrefToRef: Map<string, string>,
): string {
  return rewriteHrefsToRecipeRefs(rewriteTagsToRoles(text, nameToRole), hrefToRef);
}
