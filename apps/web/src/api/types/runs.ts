import type { JsonSchema } from "../wire";
import type { AgentConfig, Harness } from "./agents";
import type { SecretRef } from "./secrets";

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
  function?: { name?: string; description?: string; parameters?: JsonSchema };
};

export type RunConfigSnapshot = Omit<
  AgentConfig,
  "keep_tool_result_generations" | "repositories" | "read_only_repositories"
> & {
  /** The agent's own, or its guild's when it sets none, as the run started with it. */
  keep_tool_result_generations: number;
  projection_policy_version?: number;
  tools: OfferedTool[];
  mcp: {
    connection_id: string;
    server_id: string;
    slug: string;
    tools: { name: string; remote_name: string }[];
  }[];
  secrets: SecretRef[];
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
  /** What each turn of a subscription agent's run changed; a turn that changed nothing has none. */
  turn_changes?: RunTurnChange[];
  /** The run's pending wake-up, null when it has none; a run list leaves it out. */
  pending_wake?: PendingWake | null;
};

/** A run's pending wake-up: when it is due, the agent's note to itself, and when it was set. */
export type PendingWake = {
  id: string;
  due_at: string;
  message: string | null;
  created_at: string;
};

/** `run.wake.changed`: the run's pending wake-up after a change, null when none is left. */
export type RunWakeChange = { pending_wake: PendingWake | null };

/** A fired wake-up as its message tells the agent: when it was set, due and fired, its note, and the wake-ups left. */
export type WakeUp = {
  id: string;
  set_at: string;
  due_at: string;
  fired_at: string | null;
  message: string | null;
  wake_ups_left: number;
};

/** The operator's first message to an agent, with the images attached to it. */
export type NewRun = { message: string; files?: File[] };

/** The operator's next message in a run, with the images attached to it. */
export type RunMessageInput = { runId: string; content: string; files?: File[] };

/** A turn's diff in one repository, cut at the server's limit. */
export type RunDiff = { repository: string; diff: string; truncated: boolean };

/** `tool.progress` on a run's stream: the lines a running tool call reported since the last event. */
export type ToolProgressEvent = { run_id: string; tool_call_id: string; lines: string[] };

/**
 * `assistant.delta` or `assistant.reasoning.delta` on a run's or a coach session's stream: the text
 * the model wrote since the last one. A coach's reply frames carry it as `content` too.
 */
export type LiveDelta = { text: string; content?: string };


/**
 * What one turn of a subscription agent's run changed: the call id its checkpoints are kept
 * under, its generation, and each repository it changed.
 */
export type RunTurnChange = { call_id: string; generation: number; repos: RunRepositoryChange[] };

/** One repository's change over a run, or over one turn of it: its start and end checkpoints and their diffstat. */
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

/** A tool call as the model makes it, in the Chat Completions shape. */
export type ToolCall = {
  id: string;
  type: string;
  function: { name: string; arguments: string };
};

/*
 * A tool call's arguments are JSON text the model wrote to the tool's schema. Each type below names
 * the parameters of a group of built-in tools that the run view reads, with the type the schema
 * gives each one; a parameter the model left out is absent.
 */

/** A note tool's arguments (`note_find`, `note_get`, `note_write`, `note_delete`, and the older `artifact_*` and `note_read`/`note_list`). */
export type NoteToolArguments = {
  query?: string;
  path?: string;
  key?: string;
  /** The level an older `note_list` listed. */
  scope?: string;
};

/** A record tool's arguments: the collection it works in, the search it runs, and the record it names. */
export type RecordToolArguments = { collection?: string; query?: string; id?: number };

/** A file tool's arguments (`file_find`, `file_fetch`, `file_put`, `file_delete`): the search, the file, and the home path it shares. */
export type FileToolArguments = { query?: string; path?: string; home_path?: string };

/**
 * A call of a harness's own tool's arguments (Claude Code's Bash, Read, Edit, Grep, …), as far as
 * a summary reads them: the command, the file or path, the pattern, the address, the query, and
 * the description.
 */
export type HarnessToolArguments = {
  command?: string;
  file_path?: string;
  path?: string;
  pattern?: string;
  url?: string;
  query?: string;
  description?: string;
};

/** A Codex patch's arguments, as its item reports them: the files it changed, each with how. */
export type FileChangeArguments = { changes: Array<{ path: string; kind?: string }> };

/** The name a call gives the script (`script_run`, `script_create`) or the secret (`secret_store`) it works on. */
export type NamedToolArguments = { name?: string };

/** A `report_issue` call's arguments: the issue's summary. */
export type ReportIssueArguments = { summary?: string };

/** A `wake_after` call's arguments: the delay in minutes, and the agent's note. */
export type WakeAfterArguments = { minutes?: number; message?: string };

/** A `browse` call's arguments: the task it delegates, and the page it starts from. */
export type BrowseArguments = { task?: string; start?: string };

/** A step-by-step browser tool's arguments: the page it opens, and the way it scrolls. */
export type BrowserToolArguments = { url?: string; direction?: string };

/**
 * A Studio tool's arguments: the agent it addresses, by id, by the target it names or by name, and
 * what an edit it proposes does to the note, table or routine it names.
 */
export type StudioToolArguments = {
  agent_id?: string;
  target_agent_id?: string;
  agent_name?: string;
  action?: string;
  key?: string;
  name?: string;
  collection?: string;
  /** The connection tool `studio_call_connection_tool` calls. */
  tool?: string;
};

/** A Builder tool's arguments: the capability search it runs, and the connector it describes. */
export type BuilderToolArguments = { query?: string; server_ref?: string };

/** A bundled search connector's arguments (Tavily, TwitterAPI.io): the query, the account and the post it reads. */
export type ConnectorToolArguments = { query?: string; user?: string; id?: string };

export type SystemMessage = { role: "system"; content: string };

export type UserMessage = { role: "user"; content: string };

export type AssistantMessage = { role: "assistant"; content: string; tool_calls?: ToolCall[] };

export type ToolMessage = { role: "tool"; tool_call_id: string; content: string };

/** A stored message, as the model reads it. */
export type MessagePayload = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

/**
 * The tokens a model call, or a harness's turn, spent: its input, its output, and the parts of the
 * input read from and written to the cache; cache writes only where the source reports them.
 */
export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens?: number;
};

/** What a model call records on the assistant message it returns. */
export type CompletionMetadata = {
  usage: TokenUsage;
  latency_ms: number;
  finish_reason: string;
  model: string;
  response_id: string | null;
  provider_request_id: string | null;
  cost_usd: number;
  /** Where the cost comes from; `subscription` for a harness's turn, which no price per token charges. */
  cost_source: "provider" | "catalog" | "unavailable" | "subscription";
  /** The catalog's pricing version, when the catalog priced the call. */
  pricing_version?: string;
  reasoning?: string;
};

/**
 * What one `browse` call spent: the browsing service's own tokens and cost (`jev_*`), the model
 * it drove the page with (`llm_*`), and their sum.
 */
export type BrowserUsageMetadata = {
  model: string;
  jev_input_tokens: number;
  jev_output_tokens: number;
  jev_cost_usd: number;
  llm_input_tokens: number;
  llm_output_tokens: number;
  llm_cost_usd: number;
  cost_usd: number;
};

/** The fields a native tool reports about its call, kept on the call's result. */
export type ReportedToolMetadata = {
  /** The exit code of the command a script or browser tool ran. */
  exit_code?: number | null;
  /** How a `browse` call ended. */
  status?: string;
  /** The page a `browse` call ended on; null when it never loaded one. */
  final_url?: string | null;
  /** The browser actions a `browse` call took. */
  steps?: number;
  /** What a `browse` call spent, counted in the usage counters apart from model calls. */
  browser_usage?: BrowserUsageMetadata;
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
} & ReportedToolMetadata;

/** Where a run's system or user message came from. */
export type RunMessageSource =
  "system" | "ui" | "continuation" | "schedule" | "group_chat" | "handoff" | "wake";

/** What a run's system or user message records about where it came from. */
export type RunInputMetadata = {
  source: RunMessageSource;
  attachments?: MessageAttachment[];
  previous_run_id?: string;
  schedule_id?: string;
  instruction_hash?: string;
  /** The wake-up a `wake` message fires. */
  wake_id?: string;
  /** Whether the wake-up reopened a completed run for this generation. */
  reopened_run?: boolean;
  group_message_id?: number;
  group_seq?: number;
  reply_to_seq?: number;
  author_type?: string;
  author_name?: string;
  tagged?: string[];
  you_were_tagged?: boolean;
  recipients?: string[];
};

/**
 * How much of a harness turn's tokens its reply records: `complete`, those the CLI reported for the
 * whole turn at its end; `partial`, those of the model calls it reported before the turn ended
 * without that report; `none`, when it reported neither.
 */
export type HarnessUsageExtent = "complete" | "partial" | "none";

/**
 * What a message a harness's CLI wrote records: the harness, and on the turn's reply how much of
 * the turn's tokens it records. A subscription agent's run keeps its harness's messages, and the
 * calls of the harness's own tools with their results, under it.
 */
export type HarnessMessageMetadata = { from_harness: Harness; usage_extent?: HarnessUsageExtent };

/**
 * The metadata of a run's message. Which fields it carries depends on the message: an assistant
 * message has the completion's, a tool result the call's, a system or user message its source,
 * and a message of a harness's the harness. `generation` numbers every message but the system
 * prompt.
 */
export type MessageMetadata = { generation?: number } & Partial<RunInputMetadata> &
  Partial<CompletionMetadata> &
  Partial<ToolResultMetadata> &
  Partial<HarnessMessageMetadata>;

/** One row of a run: system prompt, user turn, assistant turn (with tool calls) or tool result. */
export type RunMessage = {
  id: number;
  seq: number;
  payload: MessagePayload;
  metadata: MessageMetadata;
  created_at: string;
  /** The cost stored beside the message: a model reply's, or a tool result's spend such as a `browse` call's; null when it records none. */
  cost_usd: number | null;
};

/**
 * What a conversation's message records about its step, in a run or a coach conversation alike:
 * its generation, the completion a model call records, and the call a tool result records.
 */
export type StepMetadata = { generation?: number } & Partial<CompletionMetadata> &
  Partial<ToolResultMetadata> &
  Partial<HarnessMessageMetadata>;

/** A recorded message of a model conversation, a run's or a coach's, as its steps read it. */
export type StepMessage = Omit<RunMessage, "metadata"> & { metadata: StepMetadata };

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
