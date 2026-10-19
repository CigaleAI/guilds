import { formatColumnTimestamp } from "./codecs.js";
import { jsonObj, rowGet } from "./json.js";

export function iso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== "string") {
    throw new TypeError("timestamp must be a string");
  }
  if (value.includes("T")) {
    return value;
  }
  return formatColumnTimestamp(value);
}

export function messageItem(row: Record<string, unknown>): {
  id: unknown;
  seq: unknown;
  payload: unknown;
  metadata: unknown;
  created_at: string;
} {
  return {
    id: row.id,
    seq: row.seq,
    payload: jsonObj(row.payload),
    metadata: jsonObj(row.metadata),
    created_at: iso(row.created_at),
  };
}

function publicConfigSnapshot(value: unknown): unknown {
  const snapshot = jsonObj(value);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return snapshot;
  }
  const { scripts: _scripts, ...rest } = snapshot as Record<string, unknown>;
  return rest;
}

export function runItem(
  row: Record<string, unknown>,
  { generating }: { generating: boolean },
): Record<string, unknown> {
  const errors = jsonObj(row.errors);
  const metadata = jsonObj(rowGet(row, "metadata") || {});
  return {
    id: row.id,
    agent_id: row.agent_id,
    status: row.status,
    config_snapshot: publicConfigSnapshot(row.config_snapshot),
    errors: Array.isArray(errors) ? errors : [],
    generating,
    system_prompt_hash: rowGet(row, "system_prompt_hash") ?? null,
    task_prompt_hash: rowGet(row, "task_prompt_hash") ?? null,
    memory_prompt_hash: rowGet(row, "memory_prompt_hash") ?? null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    kind: rowGet(row, "kind") || "direct",
    group_chat_through_seq: rowGet(row, "group_chat_through_seq") ?? null,
    ...scheduleFields(row, metadata),
    ...codingFields(metadata),
  };
}

// A coding run carries what it changed in each repository, and its place in a run chain.
// Other runs omit the keys.
function codingFields(metadata: unknown): {
  repos?: unknown;
  chain?: unknown;
  continued_by_run_id?: string;
} {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }
  const { repos, chain, continued_by_run_id: continuedBy } = metadata as {
    repos?: unknown;
    chain?: unknown;
    continued_by_run_id?: unknown;
  };
  return {
    ...(Array.isArray(repos) ? { repos } : {}),
    ...(chain && typeof chain === "object" ? { chain } : {}),
    ...(typeof continuedBy === "string" ? { continued_by_run_id: continuedBy } : {}),
  };
}

// Schedule runs carry the routine that woke them and the hash of the
// instruction it fired with. Other kinds omit both keys.
function scheduleFields(
  row: Record<string, unknown>,
  metadata: unknown,
): { schedule_id?: string; instruction_hash?: string | null } {
  const scheduleId = rowGet(row, "schedule_id");
  if (typeof scheduleId !== "string" || !scheduleId) {
    return {};
  }
  const hash =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as { instruction_hash?: unknown }).instruction_hash
      : undefined;
  return {
    schedule_id: scheduleId,
    instruction_hash: typeof hash === "string" ? hash : null,
  };
}

export function groupMessageItem(row: Record<string, unknown>): Record<string, unknown> {
  const tagged = jsonObj(row.tagged_names);
  const taggedAgentIds = jsonObj(row.tagged_agent_ids);
  const taggedUserIds = jsonObj(row.tagged_user_ids ?? []);
  return {
    id: row.id,
    seq: row.seq,
    author_type: row.author_type,
    author_name: row.author_name,
    author_agent_id: row.author_agent_id ?? null,
    author_user_id: row.author_user_id ?? null,
    source_run_id: row.source_run_id ?? null,
    content: row.content,
    tagged: Array.isArray(tagged) ? tagged : [],
    tagged_agent_ids: Array.isArray(taggedAgentIds) ? taggedAgentIds : [],
    tagged_user_ids: Array.isArray(taggedUserIds) ? taggedUserIds : [],
    created_at: iso(row.created_at),
  };
}
