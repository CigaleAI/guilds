import type { Column } from "../../../api/types/tables";
import { asArray, asObject, type CollectionDraft, type Draft } from "./recipeDraft";

/** One collection column the plan shows. */
export type PlanColumn = {
  name: string;
  type: string;
  description: string;
  required: boolean;
  unique: boolean;
  values: string[];
};

/** One collection the plan shows; `action` is "" when there is no apply decision. */
export type PlanCollection = {
  name: string;
  purpose: string;
  columns: PlanColumn[];
  scope: "guild" | "org";
  guild: "read" | "write";
  writers: string[];
  action: "" | "create" | "reuse" | "conflict";
  collection_id: string | null;
  differences: string[];
};

function collectionColumn(column: Draft<Column> | null | undefined): PlanColumn {
  const item = asObject(column);
  return {
    name: String(item.name || ""),
    type: String(item.type || "text"),
    description: String(item.description || ""),
    required: item.required === true,
    unique: item.unique === true,
    values: asArray(item.values).map((value) => String(value)),
  };
}

export function collectionsFromRecipe(
  docCollections: readonly CollectionDraft[],
  overlayCollections: readonly CollectionDraft[],
): PlanCollection[] {
  const source = overlayCollections.length ? overlayCollections : docCollections;
  return source.map((item) => ({
    name: String(item?.name || ""),
    purpose: String(item?.purpose || ""),
    columns: asArray(item?.columns).map(collectionColumn),
    scope: item?.scope === "guild" ? "guild" : "org",
    guild: item?.guild === "write" ? "write" : "read",
    writers: asArray(item?.writers).map((role) => String(role)),
    action:
      item?.action === "create" || item?.action === "reuse" || item?.action === "conflict"
        ? item.action
        : "",
    collection_id: item?.collection_id || null,
    differences: asArray(item?.differences).map((line) => String(line)),
  }));
}

/** A collection's card. */
export type CollectionView = {
  chip: { label: string; tone: "action" | "ok" | "warn" } | null;
  access: string;
  snippet: string;
  meta: string;
  conflict: { headline: string; differences: string[] } | null;
  reuses: boolean;
  columns: Array<PlanColumn & { typeLabel: string; rules: string[] }>;
};

/** The apply decision chip of a collection; null when there is no decision. */
export function collectionActionChip(item: PlanCollection): CollectionView["chip"] {
  if (item.action === "create") {
    return { label: item.scope === "guild" ? "new guild table" : "new table", tone: "action" };
  }
  if (item.action === "reuse") return { label: "reuses existing table", tone: "ok" };
  if (item.action === "conflict") return { label: "conflict", tone: "warn" };
  return null;
}

/** The roles that write on top of the guild's mode, as a label suffix; "" when there are none. */
export function writersSuffix(writers: readonly string[]): string {
  return writers.length ? ` · writers: ${writers.map((role) => `@${role}`).join(", ")}` : "";
}

/** Who reaches a collection: the guild's own table, or the guild's mode on an organisation table with its writers. */
export function collectionAccessLabel(item: PlanCollection): string {
  if (item.scope === "guild") return "the guild's own";
  return `guild ${item.guild}${writersSuffix(item.writers)}`;
}

/** A column's type, followed by its closed values when it has them. */
export function columnTypeLabel(column: PlanColumn): string {
  return column.values.length ? `${column.type}: ${column.values.join(" | ")}` : column.type;
}

/** A collection's card: decision chip, access, purpose, access sentence, conflict details, and columns. */
export function collectionView(item: PlanCollection): CollectionView {
  const writers = item.writers.length
    ? `Agent rows at write: ${item.writers.map((role) => `@${role}`).join(", ")}`
    : "No agent rows";
  return {
    chip: collectionActionChip(item),
    access: collectionAccessLabel(item),
    snippet: item.purpose || "Typed table",
    meta:
      item.scope === "guild"
        ? "The guild's table · every agent in the guild reads and writes it"
        : `Organisation table · every agent in the guild gets ${item.guild} · ${writers}`,
    conflict:
      item.action === "conflict"
        ? {
            headline:
              item.scope === "guild"
                ? `The organisation already has a table named ${item.name}.`
                : `A table named ${item.name} already exists with different columns.`,
            differences: item.differences,
          }
        : null,
    reuses: item.action === "reuse",
    columns: item.columns.map((column) => ({
      ...column,
      typeLabel: columnTypeLabel(column),
      rules: [column.required ? "required" : "", column.unique ? "unique" : ""].filter(Boolean),
    })),
  };
}
