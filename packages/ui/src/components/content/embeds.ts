import { replaceInText, spanNode, type MdNode } from "./textNodes";

/**
 * `![[display-path]]` embeds: an operator's link to a note or a table whose text is added to the
 * prompt at run time. `[[display-path]]` references: a link the agent reads itself when it needs
 * the note. A collection's display path is `org/<org_id>/collections/<name>`; anything else is a note.
 */
export const EMBED_PATTERN = /!\[\[([^\]\n]+)\]\]/g;
export const REFERENCE_PATTERN = /(?<!!)\[\[([^\]\n]+)\]\]/g;

export type EmbedKind = "note" | "table";

/** How a link reaches the prompt: its text inlined at run start, or its path left for the agent to read. */
export type EmbedMode = "embed" | "reference";

export function embedKind(path: string): EmbedKind {
  const parts = path.trim().split("/").filter(Boolean);
  return parts.length === 4 && parts[0] === "org" && parts[2] === "collections" ? "table" : "note";
}

/** The file or table name a chip shows: the last path segment. */
export function embedLabel(path: string): string {
  const parts = path.trim().split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function embedMarkup(path: string): string {
  return `![[${path}]]`;
}

export function referenceMarkup(path: string): string {
  return `[[${path}]]`;
}

const markupByMode: Record<EmbedMode, (path: string) => string> = {
  embed: embedMarkup,
  reference: referenceMarkup,
};

/** The link text for a path in the given mode. */
export function linkMarkup(path: string, mode: EmbedMode): string {
  return markupByMode[mode](path);
}

/**
 * Remark plugin: turns `![[display-path]]` and `[[display-path]]` in text into `<span>` elements
 * (`data-embed`, `data-reference`), so a renderer can draw a chip instead of a broken image or
 * bracketed text. Code spans and blocks stay literal.
 */
export function remarkEmbeds() {
  return (tree: MdNode) => {
    replaceInText(tree, EMBED_PATTERN, (match) => {
      const path = (match[1] ?? "").trim();
      return path ? spanNode("embed", { dataEmbed: path }, path) : null;
    });
    replaceInText(tree, REFERENCE_PATTERN, (match) => {
      const path = (match[1] ?? "").trim();
      return path ? spanNode("reference", { dataReference: path }, path) : null;
    });
  };
}
