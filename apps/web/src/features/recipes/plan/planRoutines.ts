import { describeCron, describeWindow } from "../../agent/routine/describeTiming";
import type { WakeWindow } from "../../../api/types/schedules";
import {
  asArray,
  asObject,
  reviewLabel,
  type AuthorDraft,
  type OverlayRoutine,
  type RecipeDraft,
  type RoleDraft,
} from "./recipeDraft";

/** Where a routine comes from: a role schedule, the apply plan, or a design cadence. */
export type RoutineSource = "schedule" | "apply" | "design";

/** One routine the plan shows. */
export type PlanRoutine = {
  role: string;
  key: string;
  cron: string | null;
  window: WakeWindow | null;
  description: string;
  instruction: string;
  author: AuthorDraft | null;
  source: RoutineSource;
  /** Set on design routines: the collection the routine dedupes against, or "". */
  dedupe_collection?: string;
};

/** A cron expression in words without the UTC suffix, or "Unspecified cadence" when empty. */
export function cadenceLabel(cron: string | null | undefined): string {
  const text = String(cron || "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
  if (!text) return "Unspecified cadence";
  const desc = describeCron(text);
  if (desc && desc !== text) {
    return desc.replace(/\s*\(UTC\)$/i, "");
  }
  if (text === "* * * * *") return "Every minute";
  if (text === "0 * * * *") return "Every hour";
  const everyMin = text.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (everyMin) return everyMin[1] === "1" ? "Every minute" : `Every ${everyMin[1]} minutes`;
  const everyHour = text.match(/^0\s+\*\/(\d+)\s+\*\s+\*\s+\*$/);
  if (everyHour) return everyHour[1] === "1" ? "Every hour" : `Every ${everyHour[1]} hours`;
  return text;
}

/** A routine's timing in words: its random wake window when it has one, its cron otherwise. */
export function scheduleCadence(
  window: WakeWindow | null | undefined,
  cron: string | null | undefined,
): string {
  return window ? describeWindow(window) : cadenceLabel(cron);
}

function isFiveFieldCron(value: unknown): boolean {
  return (
    String(value || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean).length === 5
  );
}

type RoutineInput = {
  key?: string | null | undefined;
  cron?: string | null | undefined;
  window?: WakeWindow | null | undefined;
  description?: string | null | undefined;
  instruction?: string | null | undefined;
  author?: AuthorDraft | null | undefined;
};

export function scheduledRoutine(
  item: RoutineInput,
  role: string,
  source: "schedule" | "apply",
): PlanRoutine {
  return {
    role,
    key: item.key ?? "",
    cron: item.cron ?? null,
    window: item.window || null,
    description: item.description || "",
    instruction: item.instruction || "",
    author: item.author || null,
    source,
  };
}

export function routinesForRole(
  role: RoleDraft,
  doc: RecipeDraft,
  overlayRoutines: readonly OverlayRoutine[],
): PlanRoutine[] {
  const roleId = role.role ?? "";
  const explicit = asArray(role.schedules).map((item) =>
    scheduledRoutine(item, roleId, "schedule"),
  );
  if (explicit.length) return explicit;
  const fromOverlay = overlayRoutines.filter((item) => item.role === role.role);
  if (fromOverlay.length) {
    return fromOverlay.map((item) => scheduledRoutine(item, roleId, "apply"));
  }
  return asArray(asObject(doc.design).routines)
    .filter((item) => item.role === role.role && isFiveFieldCron(item.cadence))
    .map((item) => ({
      role: roleId,
      key: item.key ?? "",
      cron: item.cadence ?? null,
      window: null,
      description: item.key ?? "",
      instruction: "",
      author: null,
      source: "design",
      dedupe_collection: item.dedupe_collection || "",
    }));
}

/** A routine as a row or a card line shows it. */
export type RoutineView = {
  role: string;
  key: string;
  cron: string | null;
  cadence: string;
  description: string;
  status: "from design" | "paused at create";
  reviewer: string | null;
};

/** A routine's row: its cadence in words, its cron, its description (or instruction), and how apply creates it. */
export function routineView(item: PlanRoutine): RoutineView {
  return {
    role: item.role,
    key: item.key,
    cron: item.cron || null,
    cadence: scheduleCadence(item.window, item.cron),
    description: (item.description || item.instruction || "").trim(),
    status: item.source === "design" ? "from design" : "paused at create",
    reviewer: reviewLabel(item.author),
  };
}
