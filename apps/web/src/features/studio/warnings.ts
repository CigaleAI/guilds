import type { StudioAgent } from "../../api/types/studio";

/** What Studio flags on an agent, in words. */
export const warningLabel: Record<StudioAgent["warnings"][number], string> = {
  empty_task: "empty Task",
  generation_errors: "last run failed",
  stale_draft: "draft is stale",
};
