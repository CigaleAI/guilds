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

export type RunConfigSnapshot = AgentConfig & {
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

/**
 * `tool.progress` on a run's stream: the lines a running tool call reported since the last event,
 * and the harness session it runs in when it has one.
 */
export type ToolProgressEvent = {
  run_id: string;
  tool_call_id: string;
  lines: string[];
  session_id?: string | null;
};

/**
 * `assistant.delta` or `assistant.reasoning.delta` on a run's or a coach session's stream: the text
 * the model wrote since the last one. A coach's reply frames carry it as `content` too.
 */
export type LiveDelta = { text: string; content?: string };

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

/** A `shell` call's arguments: the command, and whether it runs in the background. */
export type ShellArguments = { command?: string; background?: boolean };

/** A `shell_status` call's arguments: the background command it checks, and whether it stops it. */
export type ShellStatusArguments = { id?: string; stop?: boolean };

/** A `file_read` call's arguments: the file, and the line it reads from. */
export type FileReadArguments = { path?: string; offset?: number };

/** A `code_search` call's arguments: the pattern, whether it matches lines or file names, and where. */
export type CodeSearchArguments = { pattern?: string; mode?: string; path?: string };

/** A `code_task` call's arguments: the brief, the repository, and the harness session it resumes. */
export type CodeTaskArguments = { brief?: string; repo?: string; session_id?: string };

/** The name a call gives the script (`script_run`, `script_create`) or the secret (`secret_store`) it works on. */
export type NamedToolArguments = { name?: string };

/** A `report_issue` call's arguments: the issue's summary. */
export type ReportIssueArguments = { summary?: string };

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

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
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
  cost_source: "provider" | "catalog" | "unavailable";
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
  /** The step whose result a repeated read of an unchanged range points to. */
  repeat_of?: number;
} & ReportedToolMetadata;

/** Where a run's opening or operator message came from. */
export type RunMessageSource =
  "system" | "ui" | "continuation" | "schedule" | "group_chat" | "handoff";

/** What a run's system or user message records about where it came from. */
export type RunInputMetadata = {
  source: RunMessageSource;
  attachments?: MessageAttachment[];
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
 * The metadata of a run's message. Which fields it carries depends on the message: an assistant
 * message has the completion's, a tool result the call's, a system or user message its source.
 * `generation` numbers every message but the system prompt.
 */
export type MessageMetadata = { generation?: number } & Partial<RunInputMetadata> &
  Partial<CompletionMetadata> &
  Partial<ToolResultMetadata>;

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
  Partial<ToolResultMetadata>;

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
