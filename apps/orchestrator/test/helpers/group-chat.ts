import type { GroupMessageRow } from "../../src/db/group-chat.js";

/** A group chat message of guild_1: an operator's at `seq`, unless `overrides` say otherwise. */
export function groupMessageRow(seq: number, overrides: Partial<GroupMessageRow> = {}): GroupMessageRow {
  return {
    id: seq,
    guild_id: "guild_1",
    seq,
    author_type: "user",
    author_name: "user",
    author_agent_id: null,
    author_user_id: null,
    source_run_id: null,
    content: "",
    created_at: "2026-01-01T00:00:00.000Z",
    tagged_names: [],
    tagged_agent_ids: [],
    tagged_user_ids: [],
    ...overrides,
  };
}
