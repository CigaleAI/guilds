import { isRecord } from "../../../api/wire";
import type { WakeWindow } from "../../../api/types/schedules";
import type {
  ApplyCreates,
  CollectionPlan,
  CreatedAgent,
  CreatedRoutine,
  DesignBrowser,
  DesignHandoff,
  DesignSystem,
  FieldAuthor,
  PlannedConnection,
  PlannedSecret,
  RecipeConnection,
  RecipeDesign,
  RecipeDocument,
  RecipeExternal,
  RecipeRepository,
  RecipeNote,
  RecipeRole,
  RecipeSchedule,
  RecipeScript,
  RecipeSecret,
} from "../../../api/types/recipes";

/**
 * A value as the plan reads it: every field optional at any depth, so partial drafts and hand-made
 * recipes fit. A routine window stays whole, since its four fields always travel together.
 */
export type Draft<T> = unknown extends T
  ? T
  : T extends string | number | boolean | null | undefined
    ? T
    : T extends WakeWindow
      ? T
      : T extends readonly (infer U)[]
        ? readonly Draft<U>[]
        : { [K in keyof T]?: Draft<T[K]> | null | undefined };

/** A field author as the plan reads it. */
export type AuthorDraft = Draft<FieldAuthor>;

/** A role script as the plan reads it. */
export type ScriptDraft = Draft<RecipeScript>;

/** A role routine as the plan reads it. */
export type ScheduleDraft = Draft<RecipeSchedule>;

/** A role as the plan reads it; the task may also be given as plain text. */
export type RoleDraft = Omit<Draft<RecipeRole>, "task"> & {
  task?: Draft<RecipeRole["task"]> | string | null | undefined;
};

/** A design system as the plan reads it, with an optional `kind` and explicit target `roles`. */
export type SystemDraft = Draft<DesignSystem> & {
  kind?: string | null | undefined;
  roles?: readonly string[] | null | undefined;
};

/** The design notes as the plan reads them. */
export type DesignDraft = Omit<Draft<RecipeDesign>, "systems"> & {
  systems?: readonly SystemDraft[] | null | undefined;
};

/** A recipe document as the plan reads it. */
export type RecipeDraft = Omit<Draft<RecipeDocument>, "roles" | "design"> & {
  roles?: readonly RoleDraft[] | null | undefined;
  design?: DesignDraft | null | undefined;
};

/** A stored recipe row (its `body` is the document, as in `RecipeRow`), a recipe document, or nothing. */
export type RecipeSource = { body: unknown } | RecipeDraft | null | undefined;

/** A connector from the recipe, the apply plan, or both merged. */
export type ConnectionDraft = Draft<RecipeConnection> &
  Draft<Pick<PlannedConnection, "action" | "connection_id" | "reusable">>;

/** A secret from the recipe or the apply plan. */
export type SecretDraft = Draft<RecipeSecret> &
  Draft<Pick<PlannedSecret, "action" | "dest_name" | "collision">>;

/** A collection from the recipe, or the apply plan's decision for it. */
export type CollectionDraft = Draft<CollectionPlan>;

/** A seed note from the recipe, the apply plan, or both merged. */
export type NoteDraft = Draft<RecipeNote>;

/** An external setup card as the plan reads it. */
export type ExternalDraft = Draft<RecipeExternal>;

/** A repository the recipe needs, as the plan reads it. */
export type RepositoryDraft = Draft<RecipeRepository>;

/** A design handoff as the plan reads it. */
export type HandoffDraft = Draft<DesignHandoff>;

/** A design browser site as the plan reads it. */
export type BrowserSiteDraft = Draft<DesignBrowser>;

/** An agent from the apply plan. */
export type CreatedAgentDraft = Draft<CreatedAgent>;

/** A routine from the apply plan, with the author when one is attached. */
export type OverlayRoutine = Draft<CreatedRoutine> & { author?: AuthorDraft | null | undefined };

/** The apply plan's inventory as the plan reads it. */
export type CreatesDraft = Omit<Draft<ApplyCreates>, "routines" | "connections" | "secrets"> & {
  routines?: readonly OverlayRoutine[] | null | undefined;
  connections?: readonly ConnectionDraft[] | null | undefined;
  secrets?: readonly SecretDraft[] | null | undefined;
};

export function asArray<T>(value: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(value) ? value : [];
}

export function asObject<T extends object>(value: T | null | undefined): Partial<T> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function enabledKeys(map: Draft<Record<string, boolean>> | null | undefined): string[] {
  return Object.entries(asObject(map))
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
}

/** True when a recipe's status means it is approved. */
export function isRecipeApproved(status: unknown): boolean {
  return String(status || "") === "ready";
}

/** The word a recipe's status reads as: "approved" or "draft". */
export function recipeStatusLabel(status: unknown): "approved" | "draft" {
  return isRecipeApproved(status) ? "approved" : "draft";
}

/**
 * True when a value is an object, which the plan reads as a recipe document: every field of a
 * draft is optional and read defensively.
 */
function isRecipeDraft(value: unknown): value is RecipeDraft {
  return isRecord(value);
}

/** The recipe document inside a recipe row, the value itself when it is a document, or an empty recipe. */
export function recipeBody(row: unknown): RecipeDraft {
  if (!isRecipeDraft(row)) return { roles: [], collections: [], connections: [], design: {} };
  if ("body" in row && isRecipeDraft(row.body)) return row.body;
  return row;
}

/** True when a builder wrote the field and no operator has confirmed it. */
export function needsReview(author: AuthorDraft | null | undefined): boolean {
  return Boolean(author && author.by === "builder" && !author.reviewed);
}

/** Who wrote a field, when it is someone other than the builder; null otherwise. */
export function reviewLabel(author: AuthorDraft | null | undefined): string | null {
  if (!author || !author.by || author.by === "builder") return null;
  return author.by;
}
