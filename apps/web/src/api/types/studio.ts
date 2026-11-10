import type { CompletionMetadata, MessagePayload, RunError, RunKind } from "./runs";
import type { Schedule } from "./schedules";
import type { BindingScope, McpConnectionStatus } from "./access";

/**
 * Shapes of the orchestrator's JSON API for Studio, as the app reads them. Timestamps are ISO-8601
 * in UTC.
 */

/**
 * A Studio session: a coach conversation about one live guild. The coach proposes Task drafts
 * and edits; the operator applies or publishes them.
 */
export type StudioSession = {
  id: string;
  org_id: string;
  mode: "optimize";
  status: "active" | "blocked" | "archived";
  blocked_reason: "input_token_limit" | "source_deleted" | null;
  generation_state: "idle" | "generating" | "cancelling";
  generation_number: number;
  source_guild_id: string;
  /** The guild as the session sees it: its name, short about text and longer description. */
  source_guild: { id: string; name: string; about: string; objective?: string } | null;
  selected_target_agent_id: string | null;
  parent_session_id: string | null;
  granted_connection_ids: string[];
  coach: {
    model: string;
    temperature: number;
    max_tokens: number;
    max_steps: number;
    max_tool_calls: number;
    max_input_tokens: number;
  };
  created_by_name: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

/** A coach session to start on a guild, with its coach's model; `parent` continues an earlier one. */
export type NewStudioSession = {
  guildId: string;
  model: string;
  temperature: number;
  parent?: string;
};

/**
 * The evidence an operator pins to a Studio message: its kind and the ids that name it, null for
 * one it names none of. A step or version is a non-negative integer.
 */
export type StudioFocusRequest = {
  kind: StudioFocusKind;
  agent_id?: string | null;
  run_id?: string | null;
  seq?: number | null;
  call_id?: string | null;
  revision_id?: string | null;
  version_index?: number | null;
  schedule_id?: string | null;
  display_path?: string | null;
  change_id?: string | null;
  issue_id?: string | null;
  tool_name?: string | null;
};

/** The operator's message to the coach, pinned to what `focus` names when given. */
export type StudioMessageInput = { content: string; focus?: StudioFocusRequest };

/** What the operator does with a Task draft; `content` is the revised text of a revision. */
export type StudioDraftAction = {
  draftId: string;
  action: "publish" | "discard" | "revise";
  content?: string;
};

/** The operator's answer to one coach edit, by the seq of the message that asked. */
export type StudioEditDecision = { seq: number; decision: "apply" | "decline" };

/** The operator's answer to a login the coach asked for, by the seq of the message that asked. */
export type StudioLoginDecision = { seq: number; decision: "grant" | "decline" };

/** A login the coach may, or may no longer, read through. */
export type StudioConnectionGrant = { connectionId: string; granted: boolean };

/** How one agent is offered a tool, and how its calls went in the window. */
export type StudioToolUsage = {
  agent_id: string;
  offered: boolean;
  calls: number;
  errors: number;
  median_ms: number | null;
  last_at: string | null;
};

/** A tool the guild's agents are offered or called in the window. */
export type StudioTool = {
  name: string;
  source: "native" | "script" | "connector" | null;
  group: string;
  description: string;
  server_id: string | null;
  offered_to: string[];
  calls: number;
  errors: number;
  median_ms: number | null;
  last_at: string | null;
  agents: StudioToolUsage[];
};

/** One call of a tool by one of the guild's agents. */
export type StudioToolCall = {
  at: string;
  agent_id: string;
  run_id: string;
  call_id: string | null;
  seq: number | null;
  arguments: string;
  status: "ok" | "error";
  error: string | null;
  duration_ms: number | null;
};

/** One page of a tool's calls, newest first; `next_cursor` reads the page after it. */
export type StudioToolCallsPage = { calls: StudioToolCall[]; next_cursor: string | null };

/** Who acted on a State item: a person, one of the guild's agents, or an agent of another guild. */
export type StateActor = { kind: "person" | "agent" | "other_guild"; id: string; name: string };

/** Where a State change or read opens: its run step, or the coach message it was applied from. */
export type StateLink =
  | { kind: "run"; run_id: string; agent_id: string | null; call_id: string | null }
  | { kind: "coach"; session_id: string; seq: number };

export type StateShare = { actor: StateActor; count: number; share: number };

export type StateFlag = "no_agent_read" | "writers" | "deletes_others_rows" | "untouched";

/** A note, table, script, or Memory of the guild's state, with its changes and reads in the window. */
export type StateItemRow = {
  display_path: string;
  kind: "note" | "memory" | "script" | "file" | "table";
  /** The agent whose Memory or script it is; null for a note, a file, and a table. */
  agent_id: string | null;
  title: string;
  /** Bytes of text, or records for a table. */
  size: number;
  version: number | null;
  created_by: string;
  created_at: string;
  collection_id: string | null;
  note_id: string | null;
  /** The note's, file's, Memory's, or script's artifact, whose changes are its own; null for a table. */
  artifact_id: string | null;
  changes: number;
  reads: number;
  top_writer: StateShare | null;
  top_reader: StateShare | null;
  writers: number;
  last_change: { at: string; actor: StateActor } | null;
  flags: StateFlag[];
};

export type StateTally = { actor: StateActor; how: string; count: number };

/** One recorded change of a State item. */
export type StateHistoryEntry = {
  at: string;
  operation: "create" | "update" | "delete";
  actor: StateActor;
  link: StateLink | null;
  /** For a table, the record the change touched; null for the table itself. */
  record: string | null;
  /** For a table's shape change, what it did. */
  summary: string | null;
};

export type StateItemDetail = {
  item: StateItemRow;
  changes: StateTally[];
  reads: StateTally[];
  history: StateHistoryEntry[];
  next_cursor: string | null;
};

export type StudioFocusKind = "run" | "memory_version" | "routine" | "file" | "issue" | "tool";

/**
 * The evidence a Studio message is pinned to, as the server resolved and stored it: its kind and
 * label, its agent, and the ids that locate it, null for one it names none of.
 */
export type StudioFocus = {
  kind: StudioFocusKind;
  agent_id: string | null;
  agent_name: string | null;
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
export type ConversationMessageSource =
  "studio_system" | "builder_system" | "studio_focus" | "continuation" | "ui";

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
 * user message its source and, pinned, its focus, an assistant message the completion, a tool
 * result the tool and how the call ended, and a Studio edit or login request how the operator
 * answered it.
 */
export type ConversationMessageMetadata = {
  generation?: number;
} & Partial<ConversationStepMetadata> & {
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

/** One row of the coach conversation, shaped like a run's rows. */
export type StudioMessage = {
  id: number;
  session_id: string;
  seq: number;
  generation: number;
  payload: MessagePayload;
  metadata: ConversationMessageMetadata | null;
  cost_usd: number | null;
  created_at: string;
};

/*
 * The requests a coach's tool result carries for the operator to decide, as the app reads them
 * from the result's text: each field is kept only when it holds what it names.
 */

/** What a coach edit can change. */
export type EditKind = "memory" | "note" | "guild" | "collection" | "access" | "routine";

/** What a table, routine, or note edit does to its target. */
export type EditAction = "create" | "edit" | "delete";

/**
 * What a coach edit changes: an agent's memory, access, or routine, a note, the guild's
 * descriptions, or a table.
 */
export type EditTarget = {
  agent_id?: string;
  agent_name?: string;
  display_path?: string;
  title?: string;
  guild_id?: string;
  guild_name?: string;
  /** A table's id, null until the table a create request names exists. */
  collection_id?: string | null;
  /** A table's name. */
  name?: string;
  /** A routine's id, null until the routine a create request names exists. */
  schedule_id?: string | null;
  /** A routine's one-line label. */
  description?: string;
};

/** The lines an edit adds and removes. */
export type LineCounts = { added?: number; removed?: number };

/** What an access overlay sets: a native tool, a connection, or one tool of a connection. */
export type AccessChangeKind = "native_tool" | "mcp" | "mcp_tool";

/** How an access overlay sets its tool or connection. */
export type AccessSetting = "on" | "off" | "inherit";

/** One overlay an access edit writes. */
export type AccessChange = {
  kind: AccessChangeKind;
  id: string;
  label: string;
  setting: AccessSetting;
};

/** An edit the coach asks the operator to apply or decline. */
export type EditWidget = {
  kind: "edit";
  title?: string;
  reason?: string;
  edit: {
    kind?: EditKind;
    /** What a table, routine, or note edit does to its target; a note edit without one changes its text. */
    action?: EditAction;
    target?: EditTarget;
    base_version?: number;
    /** The guild fields a guild edit changes. */
    fields?: string[];
    lines?: LineCounts;
    /** An access edit's changes, one per tool or connection. */
    changes?: AccessChange[];
    /** Whether an access edit turns on anything the agent cannot use today. */
    widens?: boolean;
  };
};

/** A Task draft the coach wrote, decided like an edit: published, edited and published, or discarded. */
export type DraftWidget = {
  kind: "draft";
  agent: { id: string; name: string };
  draft_id: string;
  rationale?: string;
};

/** A login the coach asks to read through. */
export type AccessWidget = {
  kind: "access";
  title?: string;
  reason?: string;
  connection: {
    id?: string;
    server?: { id?: string; slug?: string; display_name?: string };
    owner_scope?: string;
    account_hint?: string;
  };
};

/** A request the coach made in its turn: an edit, a login, or a Task draft. */
export type StudioWidget = EditWidget | AccessWidget | DraftWidget;

/** `message.committed` on a coach session's stream: the row the session committed. */
export type StudioMessageCommit = { message: StudioMessage };

/** `session.error` on a coach session's stream: why the coach stopped. */
export type SessionFailure = { detail: string };

/** An agent of the guild as Studio lists it: its Task version, latest run and pending draft. */
export type StudioAgent = {
  id: string;
  name: string;
  focus: string;
  avatar_shape: string;
  avatar_color: string;
  task_version: number | null;
  task_excerpt: string;
  has_embeds: boolean;
  routine_count: number;
  latest_run: { id: string; kind: RunKind; status: string; at: string } | null;
  draft_id: string | null;
  draft_status: StudioDraft["status"] | null;
  warnings: ("empty_task" | "generation_errors" | "stale_draft")[];
  /** Script tools and the Scripts tab; missing means on. */
  scripting: boolean;
};

/** One agent's prompt as Studio inspects it: its Task and the system prompt a run would get. */
export type StudioInspector = {
  agent: { id: string; name: string; focus: string };
  task: {
    display_path: string | null;
    version: number | null;
    content: string;
    /** Hash of the Task a run receives now, with its embeds resolved. */
    effective_hash: string;
    effective_matches_source: boolean;
    has_embeds: boolean;
    embed_warning: string | null;
  };
  /** The guild guidelines every run receives. */
  guidelines: { content: string; content_hash: string };
  /** The agent's memory as a run receives it. */
  memory: { content: string; prompt_hash: string };
  effective_prompt: {
    content: string;
    task_content: string;
    latest_run: {
      id: string;
      kind: RunKind;
      created_at: string;
      guidelines_match: boolean;
      task_match: boolean;
      memory_match: boolean;
    } | null;
  };
  generating: boolean;
};

/** A proposed Task change for one agent, against the version it started from. */
export type StudioDraft = {
  id: string;
  session_id: string;
  target_agent_id: string;
  target_snapshot: { name?: string } | null;
  base_version: number;
  base_content: string;
  proposed_content: string;
  rationale: string;
  risks: unknown;
  status: "draft" | "conflicted" | "superseded" | "discarded" | "published" | "unchanged";
  draft_number: number;
  supersedes_draft_id: string | null;
  /** The coach message that created the draft; the operator's edits keep it. */
  created_message_seq: number | null;
  created_at: string;
  published_resource_version: number | null;
  size_delta_bytes: number;
  large_deletion: boolean;
};

/** The guild's about and description, the text a guild edit reads and writes. */
export type GuildText = { about: string; description: string };

/** An edit the coach asked to make to a memory, note, the guild or a table, waiting for the operator. */
export type StudioEdit = {
  status: "pending" | "applied" | "declined";
  stale: boolean;
  /**
   * The live text now: a note or memory, the guild's about and description, or a table's
   * definition or an agent's access written out line by line (empty for a table or note not
   * created yet).
   */
  live: string | GuildText | null;
  /** The text the edit writes, in the same shape as `live`; empty for a table or note it deletes. */
  proposed: string | GuildText | null;
  /** What applying a table, note create or delete, or access edit does. */
  effects?: string[];
  error?: string;
  applied_version?: number;
};

/** A login the coach may read through, once the operator grants it. */
export type StudioConnection = {
  id: string;
  server: { id: string; slug: string; display_name: string };
  owner_scope: BindingScope;
  owner_id: string | null;
  account_hint: string;
  status: McpConnectionStatus;
  granted: boolean;
  readable_tools: string[];
  tool_count: number;
};

/** A run as Studio's inspector lists it, without its transcript. */
export type StudioRun = {
  id: string;
  kind: RunKind;
  status: "active" | "completed";
  generating: boolean;
  task_prompt_hash: string | null;
  system_prompt_hash: string | null;
  memory_prompt_hash: string | null;
  schedule_id: string | null;
  /** Hash of the routine instruction the run fired with. */
  instruction_hash: string | null;
  group_chat_through_seq: number | null;
  created_at: string;
  updated_at: string;
  error_count: number;
  last_error: RunError | null;
};

/** A routine as Studio lists it: the routine, how often it fired, and its latest run. */
export type StudioRoutine = Schedule & {
  run_count: number;
  latest_run: StudioRun | null;
};

/** A member of the source guild. */
export type ActivityAgent = {
  id: string;
  name: string;
  avatar_color: string;
  avatar_shape: string;
};

/**
 * A routine of the guild: the schedule a `schedule` wake fired from. `label` is its timing in
 * words; `instruction` is what each firing tells the agent.
 */
export type ActivityRoutine = {
  id: string;
  agent_id: string;
  description: string;
  label: string;
  instruction: string;
};

/**
 * A public row of the group chat. Rows the window's wakes answered can predate `since`.
 * `preview` holds the first 400 characters; `length` counts the full text.
 */
export type ActivityMessage = {
  seq: number;
  created_at: string;
  author_type: "user" | "agent";
  author_name: string;
  author_agent_id: string | null;
  /** The person who posted an operator row; null for an agent's row. */
  author_user_id: string | null;
  /** The wake that posted the row; null for the operator's rows. */
  source_run_id: string | null;
  /** Names the row tags. */
  tagged: string[];
  preview: string;
  length: number;
};

/** The routing model's pick for an untagged row. */
export type ActivityRouting = {
  source: string;
  choice: string | null;
  confidence: number | null;
};

/**
 * Why a group wake started: the agent was tagged, the routing model chose it,
 * routing fell back, or the delivery rules picked it.
 */
export type ActivityTriggerReason = "tag" | "jev" | "rules" | "fallback";

/** What started a wake: a public row, a routine firing, or a direct chat. */
export type ActivityTrigger =
  | {
      type: "message";
      /** The row that woke the agent; null when the snapshot names none. */
      seq: number | null;
      /** The latest row in the wake's snapshot. */
      through_seq: number | null;
      reason: ActivityTriggerReason;
      routing: ActivityRouting | null;
      /** True when the run stored no waking row and `seq` was found from the row's tags. */
      inferred: boolean;
    }
  | { type: "routine"; schedule_id: string | null }
  | { type: "direct"; user_id: string | null };

/** What a write touched: a collection record, a note, a script, the agent's memory, or a repository. */
export type ActivityWriteKind = "record" | "note" | "script" | "memory" | "code";

/** One file change a wake made inside the window. */
export type ActivityWrite = {
  kind: ActivityWriteKind;
  /** The collection for a record, `memory.md` for memory, otherwise the file name. */
  target: string;
  display_path: string;
  operation: string;
  tool_name: string | null;
  call_id: string | null;
  at: string;
  /** For `code`: what the wake changed in the repository. */
  code?: { branch: string | null; files_changed: number; insertions: number; deletions: number };
};

/** An error a wake recorded inside the window. */
export type ActivityError = { operation: string | null; message: string | null; at: string | null };

/**
 * A tool call a wake made inside the window, with its result's error and duration. `arguments`
 * holds the first 160 characters.
 */
export type ActivityToolCall = {
  call_id: string | null;
  name: string;
  arguments: string;
  error: string | null;
  duration_ms: number | null;
  at: string;
};

/** A public row a wake posted inside the window. */
export type ActivityPost = { seq: number; call_id: string | null; at: string };

/** One wake. The ledger lists wakes by `started_at`. */
export type ActivityWake = {
  run_id: string;
  agent_id: string;
  kind: "group" | "schedule" | "direct";
  /** When the run started; for a direct chat, its first message inside the window. */
  started_at: string;
  /** Its last message, or the time of the request while it runs. */
  ended_at: string;
  running: boolean;
  trigger: ActivityTrigger;
  /** `posted` when it posted a public row, `wrote` when it wrote anything but memory, else `silent`. */
  outcome: "posted" | "wrote" | "silent";
  /** True when it recorded an error inside the window. */
  failed: boolean;
  errors: ActivityError[];
  posts: ActivityPost[];
  writes: ActivityWrite[];
  /** Its tool calls in order, at most 200; `tool_call_count` counts them all. */
  tool_calls: ActivityToolCall[];
  tool_call_count: number;
  /** The last text it wrote inside the window, shortened to 400 characters. */
  reply: string | null;
  /** For a direct chat, the operator's first message inside the window. */
  opening: string | null;
  /** Sequence of the run's last stored message; null when it has none. */
  last_seq: number | null;
  /** Spend inside the window, 0 when none was recorded. */
  cost_usd: number;
};

/** The whole ledger for one window. */
export type ActivityView = {
  guild_id: string;
  since: string;
  until: string;
  agents: ActivityAgent[];
  routines: ActivityRoutine[];
  messages: ActivityMessage[];
  wakes: ActivityWake[];
};

export type ReferenceNodeKind = "task" | "note" | "table" | "unresolved";

/** A Task, a note or table, or a link target that does not resolve. */
export type ReferenceNode = {
  /** The display path, or the link as written when it does not resolve. */
  id: string;
  kind: ReferenceNodeKind;
  label: string;
  /** The agent whose Task it is; null for a note, a table, and a link that does not resolve. */
  agent_id: string | null;
  collection_id: string | null;
  /** Part of the guild's state, rather than only reached from it. */
  in_state: boolean;
  bytes: number;
  /** For a Task: the note text a run inlines, counted against the budget. */
  inlined_bytes: number | null;
  /** The hop at which each agent's run meets it: 0 its own Task, up to `depth` inlined, one more left as text. */
  hops: Record<string, number>;
  /** Embed hops from the nearest Task; null when no Task reaches it. */
  depth: number | null;
  /** Why a link does not resolve. */
  reason: string | null;
  /** The agents whose runs inline it but cannot read it, so they get a marker in its place. */
  unreachable_for: string[];
};

export type ReferenceEdgeStatus = "inlined" | "too_deep" | "unreached" | "broken" | "named";

/** An embed (solid) or a path named in the text without embedding it (dotted). */
export type ReferenceEdge = {
  from: string;
  to: string;
  kind: "embed" | "name";
  status: ReferenceEdgeStatus;
};

/** What every Task and file in the guild's state embeds or names. */
export type StudioReferences = {
  guild_id: string;
  /** Bytes of note text one run may inline. */
  budget: number;
  /** How many embed levels a run inlines. */
  depth: number;
  nodes: ReferenceNode[];
  edges: ReferenceEdge[];
};

/**
 * Recipe documents (`guilds.recipe` version 2) and the recipe API's responses. File references
 * point at `apps/orchestrator/src`.
 */
