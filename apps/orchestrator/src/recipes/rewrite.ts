import { TAG_RE } from "../groupchat/index.js";
import { isDisplayPath } from "../artifacts/paths.js";
import type { RecipeNote } from "../db/schema/index.js";

const RECIPE_EMBED_RE = /!\[\[recipe:([^\]]+)\]\]/g;
const DISPLAY_EMBED_RE = /!\[\[([^\]]+)\]\]/g;
const PATH_START = String.raw`(?<![\w./-])`;
const PATH_END = String.raw`\.md(?![\w-])`;
const KEY_CHARS = String.raw`[^\s/\\\`'"()<>\[\]|]`;
/** A note's destination path written as plain text: `agent/<role>/<key>`, `guild/<key>`, or `org/<key>`. */
const RECIPE_NOTE_PATH = String.raw`${PATH_START}(?:agent\/[a-z][a-z0-9-]{0,62}|guild|org)\/${KEY_CHARS}+?${PATH_END}`;
/** A live note display path written as plain text: `org/<org_id>/…/<key>`. */
const DISPLAY_NOTE_PATH = String.raw`${PATH_START}org\/(?:${KEY_CHARS}+\/)+?${KEY_CHARS}+?${PATH_END}`;
const RECIPE_PATH_RE = new RegExp(`!\\[\\[([^\\]]+)\\]\\]|(${RECIPE_NOTE_PATH})`, "g");
const DISPLAY_PATH_RE = new RegExp(`!\\[\\[([^\\]]+)\\]\\]|(${DISPLAY_NOTE_PATH})`, "g");

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

/** Note destination paths a text names outside `![[…]]` embeds. */
export function collectRecipeNotePaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(RECIPE_PATH_RE)) {
    if (match[2]) paths.push(match[2]);
  }
  return paths;
}

/** Live note display paths, in embeds and in plain text, become their recipe refs. */
export function rewriteHrefsToRecipeRefs(text: string, hrefToRef: Map<string, string>): string {
  return text.replace(DISPLAY_PATH_RE, (match, embed: string | undefined, path: string | undefined) => {
    if (embed !== undefined) {
      const ref = hrefToRef.get(embed.trim());
      return ref ? `![[${ref}]]` : match;
    }
    return hrefToRef.get(path ?? "") ?? match;
  });
}

export function rewriteRecipeIdsToHrefs(text: string, noteIdToHref: Map<string, string>): string {
  return text.replace(RECIPE_EMBED_RE, (match, id: string) => {
    const href = noteIdToHref.get(id);
    return href ? `![[${href}]]` : match;
  });
}

/**
 * Recipe note paths become live display paths: inside `![[…]]` embeds (including
 * `recipe:<note-id>`) and as plain text such as a path handed to `note_get`.
 */
export function rewriteRecipePathsToDisplayPaths(
  text: string,
  resolved: Map<string, string>,
): { text: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const next = text.replace(RECIPE_PATH_RE, (match, embed: string | undefined, path: string | undefined) => {
    if (embed === undefined) {
      const display = resolved.get(path ?? "");
      if (display) {
        return display;
      }
      unresolved.push(match);
      return match;
    }
    const key = embed.trim();
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
