import type {
  ActivityAgent,
  ActivityMessage,
  ActivityToolCall,
  ActivityTrigger,
  ActivityView,
  ActivityWake,
  ActivityWrite,
} from "../../../api/types/studio";

/** Activity ledgers for the tests: agents, rows, wakes, writes and calls, in minutes after T0. */

export const MIN = 60_000;
export const T0 = Date.parse("2026-09-26T09:00:00Z");
export const at = (minutes: number) => new Date(T0 + minutes * MIN).toISOString();

export function agent(id: string): ActivityAgent {
  return { id, name: id.slice(2), avatar_color: "#888888", avatar_shape: "" };
}

/** A public row; a null author is the operator. */
export function row(
  seq: number,
  minutes: number,
  author: string | null,
  sourceRun: string | null = null,
): ActivityMessage {
  return {
    seq,
    created_at: at(minutes),
    author_type: author === null ? "user" : "agent",
    author_name: author ?? "operator",
    author_agent_id: author,
    author_user_id: author === null ? "user_operator" : null,
    source_run_id: sourceRun,
    tagged: [],
    preview: `row ${seq}`,
    length: 5,
  };
}

export function byRow(seq: number | null, reason: "tag" | "jev" = "tag"): ActivityTrigger {
  return { type: "message", seq, through_seq: seq, reason, routing: null, inferred: false };
}

export function wake(
  runId: string,
  agentId: string,
  [start, end]: [number, number],
  overrides: Partial<ActivityWake> = {},
): ActivityWake {
  return {
    run_id: runId,
    agent_id: agentId,
    kind: "group",
    started_at: at(start),
    ended_at: at(end),
    running: false,
    trigger: { type: "direct", user_id: "user_operator" },
    outcome: "silent",
    failed: false,
    errors: [],
    posts: [],
    writes: [],
    tool_calls: [],
    tool_call_count: 0,
    reply: null,
    opening: null,
    last_seq: null,
    cost_usd: 0,
    ...overrides,
  };
}

export function write(
  kind: ActivityWrite["kind"],
  target: string,
  path: string,
  operation: string,
) {
  return {
    kind,
    target,
    display_path: path,
    operation,
    tool_name: null,
    call_id: null,
    at: at(5),
  } satisfies ActivityWrite;
}

export function call(name: string, args = "{}", error: string | null = null): ActivityToolCall {
  return { call_id: `c_${name}`, name, arguments: args, error, duration_ms: 10, at: at(5) };
}

export function view(overrides: Partial<ActivityView> = {}): ActivityView {
  return {
    guild_id: "g_1",
    since: at(0),
    until: at(60),
    agents: [],
    routines: [],
    messages: [],
    wakes: [],
    ...overrides,
  };
}

/**
 * The operator's row #10 wakes intake, whose #11 wakes writer, whose #12 wakes editor (which fails).
 * A routine wakes editor later, and the operator chats with writer directly. Writer has a routine
 * that did not fire.
 */
export function pipeline(): ActivityView {
  return view({
    agents: [agent("a_editor"), agent("a_writer"), agent("a_intake")],
    routines: [
      {
        id: "sch_1",
        agent_id: "a_editor",
        description: "Hourly review",
        label: "Every hour (UTC)",
        instruction: "Review.",
      },
      {
        id: "sch_2",
        agent_id: "a_writer",
        description: "Daily draft",
        label: "Every day at 09:00 (UTC)",
        instruction: "Draft.",
      },
    ],
    messages: [
      row(10, 1, null),
      row(11, 3, "a_intake", "w_intake"),
      row(12, 8, "a_writer", "w_writer"),
    ],
    wakes: [
      wake("w_intake", "a_intake", [1.5, 4], {
        trigger: byRow(10),
        outcome: "posted",
        posts: [{ seq: 11, call_id: "c_11", at: at(3) }],
        cost_usd: 0.02,
      }),
      wake("w_writer", "a_writer", [4.5, 9], {
        trigger: byRow(11, "jev"),
        outcome: "posted",
        posts: [{ seq: 12, call_id: "c_12", at: at(8) }],
        cost_usd: 0.05,
      }),
      wake("w_editor", "a_editor", [9, 12], {
        trigger: byRow(12),
        failed: true,
        errors: [{ operation: "generation", message: "Out of budget.", at: at(12) }],
        cost_usd: 0.01,
      }),
      wake("w_routine", "a_editor", [40, 41], {
        kind: "schedule",
        trigger: { type: "routine", schedule_id: "sch_1" },
        outcome: "wrote",
        writes: [write("record", "projects", "org/o/collections/projects/7", "update")],
      }),
      wake("w_direct", "a_writer", [50, 55], { kind: "direct", running: true, cost_usd: 0.03 }),
    ],
  });
}
