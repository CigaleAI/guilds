import type { AgentConfig } from "./agents";

/**
 * Shapes of the orchestrator's JSON API for runs, as the app reads them. Timestamps are ISO-8601 in
 * UTC.
 */

export type RunKind = "direct" | "group" | "schedule";

export type RunError = {
  at: string;
  generation: number;
  /** Where it failed: "llm.complete", "generation.max_steps", "generation.cancelled"… */
  operation: string;
  error_type: string;
  message: string;
};

/** A tool as offered to the model: its OpenAI function schema. */
export type OfferedTool = {
  type?: string;
  name?: string;
  function?: { name?: string; description?: string; parameters?: Record<string, unknown> };
};

export type RunConfigSnapshot = AgentConfig & {
  projection_policy_version?: number;
  tools: OfferedTool[];
  mcp: {
    connection_id: string;
    server_id: string;
    slug: string;
    tools: { name: string; remote_name: string }[];
  }[];
  secrets: { id: string; name: string; description: string }[];
};

export type Run = {
  id: string;
  agent_id: string;
  /** "completed" runs take no more messages until resumed. */
  status: "active" | "completed";
  kind: RunKind;
  config_snapshot: RunConfigSnapshot;
  errors: RunError[];
  generating: boolean;
  created_at: string;
  updated_at: string;
  group_chat_through_seq: number | null;
  schedule_id?: string;
  /** What a coding run changed in each repository, between its checkpoints. */
  repos?: RunRepositoryChange[];
  /** A coding run's place in a run chain, when it continues an earlier run. */
  chain?: { root_run_id: string; index: number; previous_run_id: string };
  /** The run that continued this one after its hand-off. */
  continued_by_run_id?: string;
};

/** The operator's first message to an agent, with the images attached to it. */
export type NewRun = { message: string; files?: File[] };

/** The operator's next message in a run, with the images attached to it. */
export type RunMessageInput = { runId: string; content: string; files?: File[] };

/** A run's or a code task's diff in one repository, cut at the server's limit. */
export type RunDiff = { repository: string; diff: string; truncated: boolean };

/** `GET /api/runs/:run_id/tasks/:call_id/log`: a code task's kept harness log, redacted. */
export type HarnessLog = {
  /** Its events as progress lines, the first 2000. */
  lines: string[];
  lines_truncated: boolean;
  /** Its raw JSONL, whole lines from the start within 256 KiB. */
  raw: string;
  raw_truncated: boolean;
  /** The log's whole size in bytes. */
  bytes: number;
  events: number;
  /** Lines of the log that were not JSON. */
  unparsed: number;
};

/** `tool.progress` on a run's stream: the lines a running tool call reported since the last event. */
export type ToolProgressEvent = {
  run_id: string;
  tool_call_id: string;
  lines: string[];
  session_id: string | null;
};

/** `run.continued` on a run's stream: the run of its chain that carries on. */
export type RunContinuation = { run_id: string };

/** One repository's change over a run: its start and end checkpoints and their diffstat. */
export type RunRepositoryChange = {
  name: string;
  branch: string | null;
  head_sha: string | null;
  start_sha: string | null;
  end_sha: string;
  files_changed: number;
  insertions: number;
  deletions: number;
};

/** One row of a run: system prompt, user turn, assistant turn (with tool calls) or tool result. */
export type RunMessage = {
  id: number;
  seq: number;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
};

/** An uploaded chat image the operator attached to a direct-chat message. */
export type ChatAttachment = {
  id: string;
  filename: string;
  mime: string;
  bytes: number;
  kind: "image" | "file";
  url: string;
  created_at: string;
};

/** The reference stored on a user message after upload. */
export type MessageAttachment = {
  id: string;
  filename: string;
  mime: string;
  kind: "image" | "file";
};
