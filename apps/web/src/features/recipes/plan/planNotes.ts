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

/** The guild's mode a note's level gives when the recipe names none. */
const NOTE_GUILD_DEFAULT: Record<string, string> = { org: "read", guild: "write" };

/** The guild's mode on a note: the recipe's, or what the note's level gives. */
function noteGuildMode(item: NoteDraft): string | undefined {
  return item.guild || NOTE_GUILD_DEFAULT[item.level || "guild"];
}

/** Who reaches a note: the guild's mode, or its role alone, with the roles that write on top. */
export function noteAccessLabel(item: NoteDraft): string {
  const guild = noteGuildMode(item);
  const writers = writersSuffix(asArray(item.writers).map((role) => String(role)));
  if (guild) return `guild ${guild}${writers}`;
  return `@${item.role || "agent"}${writers || " only"}`;
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

/** A note's card: title, owner, who reaches it, snippet, where apply writes it, and its body. */
export function noteCard(item: NoteDraft): {
  title: string;
  owner: string;
  access: string;
  snippet: string;
  destination: string;
  body: string;
} {
  const title = noteTitle(item);
  const body = String(item.body || "");
  const dest = item.key || title;
  return {
    title,
    owner: item.role ? `${item.level || "agent"} · ${item.role}` : item.level || "guild",
    access: noteAccessLabel(item),
    snippet: noteSnippet(body),
    destination:
      item.level === "agent" && item.role
        ? `agent/${item.role}/${dest}`
        : `${item.level || "guild"}/${dest}`,
    body,
  };
}
