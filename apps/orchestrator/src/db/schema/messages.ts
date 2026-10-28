/** The message a run or a coach conversation keeps, and the metadata stored beside it. */
import type { Harness, RunTaskSource } from "./agents.js";

/** A tool call as the model makes it, in the Chat Completions shape. */
export type ToolCall = {
  id: string;
  type: string;
  function: { name: string; arguments: string };
};

export type SystemMessage = { role: "system"; content: string };

export type UserMessage = { role: "user"; content: string };

export type AssistantMessage = { role: "assistant"; content: string; tool_calls?: ToolCall[] };

export type ToolMessage = { role: "tool"; tool_call_id: string; content: string };

/** A stored message, as the model reads it. */
export type MessagePayload = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export type AttachmentKind = "image" | "file";

/** A file an operator attached to a message. */
export type AttachmentRef = {
  id: string;
  filename: string;
  mime: string;
  kind: AttachmentKind;
};

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
};

export type CostSource = "provider" | "catalog" | "unavailable";

/** A provider's reasoning block as it streams it: its fields are the provider's own. */
export type ReasoningDetail = Record<string, unknown> & { index?: number };

/** What a model call records on the assistant message it returns. */
export type CompletionMetadata = {
  usage: TokenUsage;
  latency_ms: number;
  finish_reason: string;
  model: string;
  response_id: string | null;
  provider_request_id: string | null;
  cost_usd: number;
  cost_source: CostSource;
  /** The catalog's pricing version, when the catalog priced the call. */
  pricing_version?: string;
  reasoning?: string;
  reasoning_details?: ReasoningDetail[];
};

/** What a tool call records on its result: the call, how its output was kept, and what the tool reported. */
export type ToolResultMetadata = {
  tool_name: string;
  tool_call_id: string;
  duration_ms: number;
  output_filter: string;
  truncated: boolean;
  original_bytes: number;
  stored_bytes: number;
  error: string | null;
  /** The tool calls the run has left after this one. */
  remaining_tool_calls?: number;
  /** The step whose result a repeated read of an unchanged range points to. */
  repeat_of?: number;
} & ReportedToolMetadata;

/** The fields a native tool reports about its call, kept on the call's result. */
export type ReportedToolMetadata = {
  exit_code?: number | null;
  /** The directory a `shell` command ended in. */
  cwd?: string;
  path?: string;
  /** The first and last line a `file_read` returned; null for a binary or empty file. */
  range?: [number, number] | null;
  content_hash?: string;
  lines?: number;
  log_path?: string | null;
  timed_out?: boolean;
  background_id?: string;
  /** A background command's state, as `shell_status` read it. */
  state?: string;
  matches?: number;
  files?: number;
  harness?: Harness;
  status?: string;
  session_id?: string | null;
  repository?: string | null;
  files_changed?: number;
  insertions?: number;
  deletions?: number;
  start_sha?: string | null;
  end_sha?: string | null;
};

/** Where a run's opening or operator message came from. */
export type RunMessageSource = "system" | "ui" | "continuation" | "schedule" | "group_chat" | "handoff";

/** What a run's system or user message records about where it came from. */
export type RunInputMetadata = {
  source: RunMessageSource;
  /** The run's task source, copied from the run's metadata. */
  task_source?: RunTaskSource;
  attachments?: AttachmentRef[];
  previous_run_id?: string;
  schedule_id?: string;
  instruction_hash?: string;
  group_message_id?: number;
  group_seq?: number;
  author_type?: string;
  author_name?: string;
  tagged?: string[];
  you_were_tagged?: boolean;
  recipients?: string[];
};

/**
 * The metadata of a run's message. Which fields it carries depends on the message: an
 * assistant message has the completion's, a tool result the call's, a system or user message
 * its source. `generation` numbers every message but the system prompt.
 */
export type MessageMetadata = { generation?: number } & Partial<RunInputMetadata> &
  Partial<CompletionMetadata> &
  Partial<ToolResultMetadata>;

export type StudioFocusKind = "run" | "memory_version" | "routine" | "file" | "issue" | "tool";

/** The piece of evidence a Studio focus pin names. */
export type StudioFocus = {
  kind: StudioFocusKind;
  agent_id: string;
  agent_name: string;
  label: string;
  run_id: string | null;
  seq: number | null;
  call_id: string | null;
  tool_name: string | null;
  revision_id: string | null;
  version_index: number | null;
  schedule_id: string | null;
  display_path: string | null;
  change_id: string | null;
  issue_id: string | null;
};

/** Where a coach conversation's system or user message came from. */
export type ConversationMessageSource = "studio_system" | "builder_system" | "studio_focus" | "continuation" | "ui";

/** What a coach conversation's generation records on the assistant message it commits. */
export type ConversationStepMetadata = CompletionMetadata & {
  generation: number;
  projection_policy_version: number;
  projected_input_hash: string;
  stubbed_message_seqs: number[];
};

/** How the operator answered a Studio edit request or login request, kept on the tool result that made it. */
export type ConversationResolutionMetadata = {
  edit_status: "applied" | "declined";
  edit_resolved_at: string;
  edit_version: number | null;
  access_status: "granted" | "declined";
  access_resolved_at: string;
  resolved_by_user_id: string | null;
};

/**
 * The metadata of a Studio or Builder message. A system message records its prompt's hash, a
 * user message its source, an assistant message the completion, a tool result the tool and how
 * the call ended, and a Studio edit or login request how the operator answered it.
 */
export type ConversationMessageMetadata = { generation?: number } & Partial<ConversationStepMetadata> & {
    source?: ConversationMessageSource;
    system_prompt_hash?: string;
    /** Set when the session's system prompt was recomposed in place. */
    refreshed?: boolean;
    focus?: StudioFocus;
    tool_name?: string;
    tool_error?: boolean;
    interrupted?: boolean;
    detail?: string;
  } & Partial<ConversationResolutionMetadata>;
