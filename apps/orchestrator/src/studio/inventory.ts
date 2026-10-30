// The Studio inventory: each agent of the source guild as the roster lists it.

import { collectTaskEmbeds } from "../artifacts/embeds.js";
import type { StudioInventoryRow } from "../db/studio.js";
import { hydrateStudioMember, type RosterAgent, type StudioMemberHydration } from "./system.js";

/** An agent as the Studio inventory lists it: its roster header's fields, its avatar, excerpt, and latest run. */
export type StudioInventoryItem = Omit<RosterAgent, "latest_run"> & {
  avatar_shape: string;
  avatar_color: string;
  scripting: boolean;
  task_excerpt: StudioMemberHydration["task_excerpt"];
  task_excerpt_truncated: StudioMemberHydration["task_excerpt_truncated"];
  task_updated_at: string;
  paused_count: number;
  latest_run: {
    id: string;
    kind: StudioInventoryRow["latest_run_kind"];
    status: StudioInventoryRow["latest_run_status"];
    at: StudioInventoryRow["latest_run_at"];
    task_prompt_hash: StudioInventoryRow["latest_task_hash"];
  } | null;
  draft_status: StudioInventoryRow["draft_status"];
};

/** One roster row as the Studio inventory lists it, with the warnings an operator acts on. */
export function inventoryItem(row: StudioInventoryRow): StudioInventoryItem {
  const content = row.task_content;
  const member = hydrateStudioMember(row);
  const warnings: string[] = [];
  if (!content.trim()) warnings.push("empty_task");
  if (row.latest_run_errors?.length) warnings.push("generation_errors");
  if (row.draft_id && row.draft_base_version !== row.task_version) {
    warnings.push("stale_draft");
  }
  return {
    id: row.id,
    name: row.name,
    focus: row.focus,
    avatar_shape: row.avatar_shape,
    avatar_color: row.avatar_color,
    scripting: row.config.scripting,
    task_version: row.task_version,
    task_hash: row.task_hash,
    task_excerpt: member.task_excerpt,
    task_excerpt_truncated: member.task_excerpt_truncated,
    has_embeds: collectTaskEmbeds(content).length > 0,
    task_updated_at: row.task_updated_at,
    routine_count: row.routine_count,
    paused_count: row.paused_count,
    latest_run: row.latest_run_id
      ? {
          id: row.latest_run_id,
          kind: row.latest_run_kind,
          status: row.latest_run_status,
          at: row.latest_run_at,
          task_prompt_hash: row.latest_task_hash,
        }
      : null,
    draft_id: row.draft_id,
    draft_status: row.draft_status,
    warnings,
  };
}
