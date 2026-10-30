import type { ConfigChange } from "../db/config-changes.js";
import type { ColumnChange } from "./columns.js";

/** The table a change-log entry is about: its id, name, and owning guild. */
export type CollectionRef = { id: string; name: string; orgId: string; guildId: string | null };

function collectionEntry(
  ref: CollectionRef,
): Pick<ConfigChange, "orgId" | "guildId" | "targetKind" | "targetId"> {
  return { orgId: ref.orgId, guildId: ref.guildId, targetKind: "collection", targetId: ref.id };
}

export function collectionDeleted(ref: CollectionRef): ConfigChange {
  return { ...collectionEntry(ref), operation: "delete", summary: `Deleted the table ${ref.name}` };
}

/** Delete all; null when the table had no live record. */
export function collectionCleared(ref: CollectionRef, removed: number): ConfigChange | null {
  if (removed <= 0) {
    return null;
  }
  const records = removed === 1 ? "record" : "records";
  return {
    ...collectionEntry(ref),
    operation: "update",
    summary: `Deleted all ${removed} ${records} of ${ref.name}`,
  };
}

/** A column rename or removal, which rewrites the live records; null when the change does neither. */
export function collectionColumnsChanged(
  ref: CollectionRef,
  change: Pick<ColumnChange, "renamed" | "removed">,
): ConfigChange | null {
  const parts = [
    ...change.renamed.map((item) => `renamed the column ${item.from} to ${item.to}`),
    ...change.removed.map((name) => `removed the column ${name}`),
  ];
  if (!parts.length) {
    return null;
  }
  const text = `${parts.join(", ")} in ${ref.name}`;
  return {
    ...collectionEntry(ref),
    operation: "update",
    summary: text.charAt(0).toUpperCase() + text.slice(1),
  };
}
