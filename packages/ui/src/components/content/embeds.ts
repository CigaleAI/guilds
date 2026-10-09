import { replaceInText, spanNode, type MdNode } from "./textNodes";

/**
 * `![[display-path]]` embeds: an operator's reference to a note or a table, expanded at run time.
 * A collection's display path is `org/<org_id>/collections/<name>`; anything else is a note.
 */
export const EMBED_PATTERN = /!\[\[([^\]\n]+)\]\]/g;

export type EmbedKind = "note" | "table";

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

/**
 * Remark plugin: turns `![[display-path]]` in text into `<span data-embed>` elements, so a
 * renderer can draw a chip instead of a broken image. Code spans and blocks stay literal.
 */
export function remarkEmbeds() {
  return (tree: MdNode) => {
    replaceInText(tree, EMBED_PATTERN, (match) => {
      const path = (match[1] ?? "").trim();
      return path ? spanNode("embed", { dataEmbed: path }, path) : null;
    });
  };
}
