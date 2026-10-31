import type { RunKind } from "../../../api/types/runs";

/** What History lists runs of: every kind, or one. */
export const runKindFilters = ["all", "direct", "group", "schedule"] as const satisfies readonly (
  RunKind | "all"
)[];

export type RunKindFilter = (typeof runKindFilters)[number];

/** Whether a select's value is one of History's run kind filters. */
export function isRunKindFilter(value: string): value is RunKindFilter {
  const known: readonly string[] = runKindFilters;
  return known.includes(value);
}
