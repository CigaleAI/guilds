import type { StudioAgent } from "../../api/types";

/** What Studio flags on an agent, in words. */
export const warningLabel: Record<StudioAgent["warnings"][number], string> = {
  empty_task: "empty Task",
  memory_skipped: "memory skipped",
  generation_errors: "last run failed",
  stale_draft: "draft is stale",
};
