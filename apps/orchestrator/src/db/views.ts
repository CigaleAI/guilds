import { formatColumnTimestamp } from "./codecs.js";
import type { GroupMessageRow } from "./group-chat.js";
import type { MessageRow, RunRow } from "./runs.js";
import type { RunChain, RunConfigSnapshot, RunMetadata, RunRepositoryChange } from "./schema/index.js";

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

/** The ISO form of a nullable timestamp column; null when the column is empty. */
export function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return iso(value);
}

/** A run message as the API and the live stream send it. */
export type MessageView = Pick<MessageRow, "id" | "seq" | "payload" | "metadata"> & { created_at: string };

export function messageItem(row: Pick<MessageRow, "id" | "seq" | "payload" | "metadata" | "created_at">): MessageView {
  return {
    id: row.id,
    seq: row.seq,
    payload: row.payload,
    metadata: row.metadata,
    created_at: iso(row.created_at),
  };
}

/** A run as the API sends it: its snapshot without the scripts it carries, and whether it is generating. */
export type RunView = Pick<
  RunRow,
  | "id"
  | "agent_id"
  | "status"
  | "errors"
  | "system_prompt_hash"
  | "task_prompt_hash"
  | "memory_prompt_hash"
  | "kind"
  | "group_chat_through_seq"
> & {
  config_snapshot: PublicRunConfigSnapshot;
  generating: boolean;
  created_at: string;
  updated_at: string;
  schedule_id?: string;
  instruction_hash?: string | null;
  repos?: RunRepositoryChange[];
  chain?: RunChain;
  continued_by_run_id?: string;
};

/** A run's config snapshot as the API sends it: without the scripts it pins. */
export type PublicRunConfigSnapshot = Omit<RunConfigSnapshot, "scripts">;

function publicConfigSnapshot(snapshot: RunConfigSnapshot): PublicRunConfigSnapshot {
  const { scripts: _scripts, ...rest } = snapshot;
  return rest;
}

export function runItem(row: RunRow, generating: boolean): RunView {
  return {
    id: row.id,
    agent_id: row.agent_id,
    status: row.status,
    config_snapshot: publicConfigSnapshot(row.config_snapshot),
    errors: row.errors,
    generating,
    system_prompt_hash: row.system_prompt_hash,
    task_prompt_hash: row.task_prompt_hash,
    memory_prompt_hash: row.memory_prompt_hash,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    kind: row.kind,
    group_chat_through_seq: row.group_chat_through_seq,
    ...scheduleFields(row.schedule_id, row.metadata),
    ...codingFields(row.metadata),
  };
}

// A coding run carries what it changed in each repository, and its place in a run chain.
// Other runs omit the keys.
function codingFields(metadata: RunMetadata): Pick<RunView, "repos" | "chain" | "continued_by_run_id"> {
  const { repos, chain, continued_by_run_id: continuedBy } = metadata;
  return {
    ...(repos ? { repos } : {}),
    ...(chain ? { chain } : {}),
    ...(continuedBy ? { continued_by_run_id: continuedBy } : {}),
  };
}

// Schedule runs carry the routine that woke them and the hash of the
// instruction it fired with. Other kinds omit both keys.
function scheduleFields(scheduleId: string | null, metadata: RunMetadata): Pick<RunView, "schedule_id" | "instruction_hash"> {
  if (!scheduleId) {
    return {};
  }
  return { schedule_id: scheduleId, instruction_hash: metadata.instruction_hash ?? null };
}

/** A group chat message as the API and the live stream send it. */
export type GroupMessageView = Pick<
  GroupMessageRow,
  "id" | "seq" | "author_type" | "author_name" | "author_agent_id" | "author_user_id" | "source_run_id" | "content"
> & {
  tagged: string[];
  tagged_agent_ids: string[];
  tagged_user_ids: string[];
  created_at: string;
};

export function groupMessageItem(row: GroupMessageRow): GroupMessageView {
  return {
    id: row.id,
    seq: row.seq,
    author_type: row.author_type,
    author_name: row.author_name,
    author_agent_id: row.author_agent_id,
    author_user_id: row.author_user_id,
    source_run_id: row.source_run_id,
    content: row.content,
    tagged: row.tagged_names,
    tagged_agent_ids: row.tagged_agent_ids,
    tagged_user_ids: row.tagged_user_ids,
    created_at: iso(row.created_at),
  };
}
