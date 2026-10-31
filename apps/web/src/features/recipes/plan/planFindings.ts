import type { RecipeFinding } from "../../../api/types/recipes";
import { asArray, plural } from "./recipeDraft";

/** Findings grouped by their recipe path, in their original order. */
export function findingsByPath(
  findings: readonly RecipeFinding[] | null | undefined,
): Map<string, RecipeFinding[]> {
  const map = new Map<string, RecipeFinding[]>();
  for (const item of asArray(findings)) {
    const list = map.get(item.path) || [];
    list.push(item);
    map.set(item.path, list);
  }
  return map;
}

/** The blocking-issue banner: how many error findings there are and the first one's message; null when none. */
export function blockingSummary(findings: readonly RecipeFinding[] | null | undefined): {
  count: number;
  label: string;
  hint: string;
  errors: RecipeFinding[];
} | null {
  const errors = asArray(findings)
    .filter(
      (item) =>
        item.code !== "review.required" &&
        item.code !== "review.script" &&
        (item.severity === "error" || item.severity === "warning"),
    )
    .filter((item) => item.severity === "error");
  const first = errors[0];
  if (!first) return null;
  return {
    count: errors.length,
    label: `${plural(errors.length, "issue")} to fix`,
    hint: errors.length === 1 ? first.message : `${first.message} (+${errors.length - 1} more)`,
    errors,
  };
}

/** The findings attached to one role: all of them, the routine advice, and the notices shown on the card. */
export type RoleFindings = {
  all: RecipeFinding[];
  routine: RecipeFinding | null;
  notices: RecipeFinding[];
};

/** Findings about what apply itself asks for or what is set up after it, which no card shows. */
const settledByApply: ReadonlySet<string> = new Set(["harness.credential"]);

/**
 * The findings at `roles.<role>` or under it: the routine advice is a `schedule.missing` finding
 * or one at `roles.<role>.schedules`; notices are the rest outside any schedule path, leaving out
 * what apply settles.
 */
export function roleFindings(
  findings: readonly RecipeFinding[] | null | undefined,
  role: string,
): RoleFindings {
  const path = `roles.${role}`;
  const all = asArray(findings).filter(
    (item) =>
      (item.path === path || item.path?.startsWith(`${path}.`)) && item.code !== "review.required",
  );
  const routine =
    all.find((item) => item.code === "schedule.missing" || item.path === `${path}.schedules`) ??
    null;
  const notices = all.filter(
    (item) =>
      item.code !== "schedule.missing" &&
      !item.path?.includes(".schedules") &&
      !settledByApply.has(item.code),
  );
  return { all, routine, notices };
}

/** A finding in the plan's issues list, labelled by what the operator should do with it. */
export type PlanIssue = {
  finding: RecipeFinding;
  label: "Coach should update prompts" | "Needs a decision" | "Optional";
  blocking: boolean;
};

/**
 * The findings no card shows: every `access.*` finding, and errors and warnings outside role paths
 * except `machine.*` ones, which the machine picker shows.
 * The list is titled "System issues" when one is an error, "Notes" otherwise; null when empty.
 */
export function planIssues(findings: readonly RecipeFinding[] | null | undefined): {
  title: "System issues" | "Notes";
  items: PlanIssue[];
} | null {
  const unhandled = asArray(findings).filter((item) => {
    if (item.code === "review.required") return false;
    if (String(item.code || "").startsWith("machine.")) return false;
    if (String(item.code || "").startsWith("access.")) return true;
    if (item.path?.startsWith("roles.")) return false;
    return item.severity === "error" || item.severity === "warning";
  });
  if (!unhandled.length) return null;
  const items = unhandled.map((finding): PlanIssue => {
    const blocking = finding.severity === "error";
    const label = String(finding.code || "").startsWith("access.")
      ? "Coach should update prompts"
      : blocking
        ? "Needs a decision"
        : "Optional";
    return { finding, label, blocking };
  });
  return { title: items.some((item) => item.blocking) ? "System issues" : "Notes", items };
}
