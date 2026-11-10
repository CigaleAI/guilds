import { artifactStore } from "../../src/artifacts/store.js";
import { NO_HIDDEN_GUILDS } from "../../src/artifacts/types.js";
import type { AgentRow } from "../../src/db/agents.js";
import type { GuildToolCallRow, GuildToolCallStatRow } from "../../src/db/activity.js";
import type { ArtifactOrTombstoneRow, MemoryRevisionRow } from "../../src/db/artifacts.js";
import type { GuildIssueRow } from "../../src/db/issues.js";
import type { Queryable } from "../../src/db/pg.js";
import type { MessageRow, RunRow } from "../../src/db/runs.js";
import type { ScheduleRow } from "../../src/db/schedules.js";
import type { StudioOperator } from "../../src/studio/actor.js";
import { StudioUnprocessableError } from "../../src/studio/errors.js";
import { resolveStudioFocus, type StudioFocusRequest } from "../../src/studio/focus.js";
import { agentRow } from "./generation.js";
import { userRow } from "./users.js";

// A fake database that answers the queries a Studio focus pin sends, and the operator who pins.

export const FOCUS_NOW = new Date("2026-11-10T12:00:00.000Z");

/** What the fake database holds: the rows each query of a focus pin reads. */
export type FocusTables = {
  agents: AgentRow[];
  runs: RunRow[];
  messages: MessageRow[];
  schedules: ScheduleRow[];
  issues: GuildIssueRow[];
  memory: { agent_id: string; content_text: string }[];
  revisions: MemoryRevisionRow[];
  toolStats: GuildToolCallStatRow[];
  toolCalls: GuildToolCallRow[];
  artifacts: ArtifactOrTombstoneRow[];
  /** Whether the organisation's notes and files have an access row for the source guild. */
  inGuildScope: boolean;
  changes: FileChangeRecord[];
};

/** A recorded change as the file-change query returns it. */
export type FileChangeRecord = {
  id: string;
  artifact_id: string | null;
  task_agent_id: string | null;
  display_path: string;
  operation: "create" | "update" | "delete";
  version: number;
  actor_type: string;
  actor_id: string;
  actor_name: string;
  run_id: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  run_kind: string | null;
  created_at: string;
};

/** A database that answers each query a focus pin sends from `tables`, and every other query with no rows. */
export function focusDatabase(tables: FocusTables): Queryable {
  const answers: Array<[RegExp, (params: unknown[]) => unknown[]]> = [
    [/AS calls/, () => tables.toolStats],
    [/AS call_id/, () => tables.toolCalls],
    [/FROM runs WHERE id = \$1/, ([id]) => tables.runs.filter((row) => row.id === id)],
    [
      /FROM messages WHERE run_id = \$1/,
      ([runId]) => tables.messages.filter((row) => row.run_id === runId),
    ],
    [/WHERE a\.id = \$1/, ([id]) => tables.agents.filter((row) => row.id === id)],
    [
      /WHERE a\.guild_id = \$1/,
      ([guildId]) => tables.agents.filter((row) => row.guild_id === guildId),
    ],
    [
      /task AS content_text/,
      ([orgId, id]) =>
        tables.agents
          .filter((row) => row.org_id === orgId && row.id === id)
          .map((row) => ({ agent_id: row.id, content_text: row.task, version: row.task_version })),
    ],
    [
      /FROM schedules WHERE id = \$1 AND agent_id = \$2/,
      ([id, agentId]) =>
        tables.schedules.filter((row) => row.id === id && row.agent_id === agentId),
    ],
    [
      /FROM guild_issues i/,
      ([guildId, id]) => tables.issues.filter((row) => row.guild_id === guildId && row.id === id),
    ],
    [
      /a\.kind = 'memory'/,
      ([, agentId]) => tables.memory.filter((row) => row.agent_id === agentId),
    ],
    [/FROM file_changes fc/, () => tables.changes],
    [/AS found/, () => [{ found: tables.inGuildScope }]],
    [/FROM artifacts a/, () => tables.artifacts],
    [
      /FROM memory_revisions/,
      ([, agentId]) => tables.revisions.filter((row) => row.agent_id === agentId),
    ],
  ];
  return {
    query: async (text: string, params: unknown[] = []) => ({
      rows: answers.find(([pattern]) => pattern.test(text))?.[1](params) ?? [],
    }),
  } as unknown as Queryable;
}

/** The fake database's tables: an agent of the source guild and one outside it, and what `overrides` adds. */
export function focusTables(overrides: Partial<FocusTables> = {}): FocusTables {
  return {
    agents: [
      agentRow({
        id: "a_1",
        guild_id: "guild_1",
        org_id: "org_1",
        name: "curator",
        task: "Keep the digest.",
        task_version: 3,
      }),
      agentRow({ id: "a_far", guild_id: "guild_far", org_id: "org_1", name: "stranger" }),
    ],
    runs: [],
    messages: [],
    schedules: [],
    issues: [],
    memory: [],
    revisions: [],
    toolStats: [],
    toolCalls: [],
    artifacts: [],
    inGuildScope: false,
    changes: [],
    ...overrides,
  };
}

/** The operator who pins, in the organisation and source guild of the agents. */
export const focusOperator: StudioOperator = {
  orgId: "org_1",
  sourceGuildId: "guild_1",
  user: userRow({ id: "user_operator", name: "operator" }),
  hidden: NO_HIDDEN_GUILDS,
};

/** What `request` resolves to against `data`, as the operator pins it at FOCUS_NOW. */
export function resolveFocus(data: FocusTables, request: StudioFocusRequest) {
  const db = focusDatabase(data);
  return resolveStudioFocus(
    { db, artifacts: artifactStore(db) },
    focusOperator,
    request,
    FOCUS_NOW,
  );
}

/** The revision that archived Memory's first text when the operator replaced it. */
export const memoryRevision = {
  id: "rev_1",
  org_id: "org_1",
  agent_id: "a_1",
  content_text: "old line",
  replaced_at: "2026-11-09T08:00:00.000Z",
  replaced_by_type: "user",
  replaced_by_id: "user_operator",
  replaced_by_name: "operator",
  replaced_by_detail: "",
  created_at: "2026-11-09T08:00:00.000Z",
} as never as MemoryRevisionRow;

/** Tables where the agent's live Memory replaced one archived revision. */
export const memoryFocusTables = () =>
  focusTables({
    memory: [{ agent_id: "a_1", content_text: "old line\nnew line" }],
    revisions: [memoryRevision],
  });

/** Whether a refusal is the 422 with `message`. */
export function isUnprocessable(message: string): (error: unknown) => boolean {
  return (error) => error instanceof StudioUnprocessableError && error.message === message;
}

/** The agent of the source guild the formatters quote. */
export const curator = agentRow({
  id: "a_1",
  guild_id: "guild_1",
  org_id: "org_1",
  name: "curator",
});
