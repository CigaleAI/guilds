import { asArray, type NoteDraft } from "./recipeDraft";
import { writersSuffix } from "./planCollections";

export function notesFromRecipe(
  docNotes: readonly NoteDraft[],
  overlayNotes: readonly NoteDraft[],
): readonly NoteDraft[] {
  if (!overlayNotes.length) return docNotes;
  const byId = new Map<string, NoteDraft>();
  const byKey = new Map<string, NoteDraft>();
  for (const item of docNotes) {
    if (item?.id) byId.set(item.id, item);
    if (item?.key) byKey.set(item.key, item);
  }
  return overlayNotes.map((item) => {
    const base: NoteDraft =
      (item?.id && byId.get(item.id)) || (item?.key && byKey.get(item.key)) || {};
    return { ...base, ...item, body: item.body || base.body || "" };
  });
}

/**
 * Who reaches a note: the guild's mode with the roles that write on top, the writing roles alone,
 * or the guild writing it when the recipe states neither.
 */
export function noteAccessLabel(item: NoteDraft): string {
  const writers = asArray(item.writers).map((role) => String(role));
  if (item.guild) return `guild ${item.guild}${writersSuffix(writers)}`;
  if (writers.length) return `${writers.map((role) => `@${role}`).join(", ")} write`;
  return "guild write";
}

/** A note's title: its key or id, or "note". */
export function noteTitle(item: NoteDraft | null | undefined): string {
  return String(item?.key || item?.id || "note").trim() || "note";
}

/** A note's first non-blank line without heading marks, cut to 88 characters; "Empty note" when blank. */
export function noteSnippet(body: string | null | undefined): string {
  const text = String(body || "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!text) return "Empty note";
  const first = text.split("\n").find((line) => line.trim()) || text;
  const cleaned = first.replace(/^#+\s*/, "").trim();
  return cleaned.length > 88 ? `${cleaned.slice(0, 85)}…` : cleaned;
}

/** A note's card: title, who reaches it, snippet, the key apply writes it at, and its body. */
export type NoteCard = {
  title: string;
  access: string;
  snippet: string;
  destination: string;
  body: string;
};

/** The card a note shows. */
export function noteCard(item: NoteDraft): NoteCard {
  const title = noteTitle(item);
  const body = String(item.body || "");
  return {
    title,
    access: noteAccessLabel(item),
    snippet: noteSnippet(body),
    destination: item.key || title,
    body,
  };
}
