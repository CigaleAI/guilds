import {
  CONTEXT_HISTORY_LIMIT,
  HISTORY_CANDIDATE_LIMIT,
  historyStateItem,
  recentGroupRows,
  storedTags,
} from "../groupchat/history.js";
import type { IntegrationSources } from "../instance/integrations.js";
import type { HistoryRouting, RecipientRouting, TypeSafeUsage } from "../db/schema/index.js";
import { writeLog } from "../observability/log.js";
import {
  TypeSafeError,
  createTypeSafeClient,
  requireChoice,
  requireNoul,
  type TypeSafeClient,
  type TypeSafeCriteriaValue,
  type TypeSafeEvaluateFn,
  type TypeSafeQuestion,
} from "./client.js";

export const NONE_RECIPIENT = "none";
// Below this the Choice is treated as unclear and the tag rules decide instead
// (the docs' starting point for "route elsewhere").
export const RECIPIENT_CONFIDENCE_MIN = 0.5;
// Each option carries the agent's focus plus the head of its Task prompt.
export const AGENT_TASK_PREVIEW_CHARS = 1_200;
// State budget is 32k tokens; clip message bodies so a pasted document cannot
// push the request over it (the model only needs the gist to route or rank).
export const LATEST_CONTENT_MAX_CHARS = 6_000;
export const HISTORY_CONTENT_MAX_CHARS = 2_000;
// Last public rows Jev sees when routing: the current message plus prior ones
// as `context`. Small on purpose so an older topic cannot steal a new ask.
export const RECIPIENT_WINDOW = 4;

export type RecipientDecision = {
  source: "tags" | "typesafe" | "low_confidence" | "fallback";
  reason?: string;
  names: Set<string>;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  model?: string;
  usage?: TypeSafeUsage;
};

export type HistoryDecision = {
  source: "limit" | "typesafe" | "fallback";
  reason?: string;
  rows: Array<Record<string, unknown>>;
  keep?: Record<string, number>;
  model?: string;
  usage?: TypeSafeUsage;
};

export type GroupRouter = {
  configured: boolean;
  recipients(args: {
    rows: Array<Record<string, unknown>>;
    members: Array<Record<string, unknown>>;
    pending: Array<Record<string, unknown>>;
    taggedNames?: Set<string>;
    ruleNames?: Set<string>;
  }): Promise<RecipientDecision>;
  history(args: {
    rows: Array<Record<string, unknown>>;
    agentName: string;
    agentFocus?: string;
  }): Promise<HistoryDecision>;
};

function clip(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max).trimEnd()}…`;
}

function clipContent(content: unknown, max: number): unknown {
  return typeof content === "string" ? clip(content, max) : content;
}

function stateItem(row: Record<string, unknown>, max: number) {
  const item = historyStateItem(row);
  return { ...item, content: clipContent(item.content, max) };
}

function memberNames(members: Array<Record<string, unknown>>): string[] {
  return members.map((member) => String(member.name));
}

// Choice option for one agent: labelled fields, as the docs recommend for
// options that are easy to confuse.
function agentOption(member: Record<string, unknown>, taskChars: number): TypeSafeCriteriaValue {
  const focus = String(member.focus ?? "").trim();
  const task = clip(String(member.task ?? ""), taskChars);
  if (!focus && !task) {
    return null;
  }
  const option: Record<string, string> = {};
  if (focus) {
    option.focus = focus;
  }
  if (task) {
    option.task = task;
  }
  return option;
}

export function serializeRecipientDecision(decision: RecipientDecision): RecipientRouting {
  const payload: RecipientRouting = {
    source: decision.source,
    names: [...decision.names].sort(),
  };
  if (decision.reason) {
    payload.reason = decision.reason;
  }
  if (decision.choice) {
    payload.choice = decision.choice;
  }
  if (decision.confidence !== undefined) {
    payload.confidence = decision.confidence;
  }
  if (decision.probabilities) {
    payload.probabilities = decision.probabilities;
  }
  if (decision.model) {
    payload.model = decision.model;
  }
  if (decision.usage) {
    payload.usage = decision.usage;
  }
  return payload;
}

export function serializeHistoryDecision(decision: HistoryDecision): HistoryRouting {
  const payload: HistoryRouting = {
    source: decision.source,
    seqs: decision.rows.map((row) => Number(row.seq)),
  };
  if (decision.reason) {
    payload.reason = decision.reason;
  }
  if (decision.keep) {
    payload.keep = decision.keep;
  }
  if (decision.model) {
    payload.model = decision.model;
  }
  if (decision.usage) {
    payload.usage = decision.usage;
  }
  return payload;
}

export async function classifyGroupRecipients(args: {
  rows: Array<Record<string, unknown>>;
  members: Array<Record<string, unknown>>;
  pendingNames: string[];
  evaluate: TypeSafeEvaluateFn;
  taskPreviewChars?: number;
}): Promise<{
  names: Set<string>;
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  model?: string;
  usage?: TypeSafeUsage;
}> {
  // Only agents whose cursor is behind can act on this snapshot. The author of
  // the latest message is never pending, so it never appears as an option.
  const pending = new Set(args.pendingNames);
  const roster = args.members.filter((member) => pending.has(String(member.name)));
  const window = recentGroupRows(args.rows, RECIPIENT_WINDOW);
  const latestRow = window[window.length - 1];
  if (!roster.length || !latestRow) {
    return { names: new Set(), choice: NONE_RECIPIENT, confidence: 1, probabilities: {} };
  }
  const taskChars = args.taskPreviewChars ?? AGENT_TASK_PREVIEW_CHARS;
  // Define `none` by what the message asks, not by surface genre: listing
  // genres (status, chatter) makes the model file any message that reads like
  // one under none, whatever it asks.
  const criteria: Record<string, TypeSafeCriteriaValue> = {
    [NONE_RECIPIENT]: "The message asks no agent to do, answer, or record anything.",
  };
  for (const member of roster) {
    criteria[String(member.name)] = agentOption(member, taskChars);
  }
  const result = await args.evaluate({
    state: {
      latest: stateItem(latestRow, LATEST_CONTENT_MAX_CHARS),
      context: window.slice(0, -1).map((row) => stateItem(row, HISTORY_CONTENT_MAX_CHARS)),
    },
    questions: {
      recipient: {
        type: "choice",
        instructions:
          "Which agent should act on `latest`? `context` is the recent messages before `latest`; use it only to resolve what `latest` refers to. Each option describes an agent's duties. Pick the agent whose duties cover what `latest` asks for. Pick `none` when `latest` asks for nothing.",
        criteria,
      },
    },
  });
  const answer = requireChoice(result, "recipient");
  const names = new Set<string>();
  if (answer.choice !== NONE_RECIPIENT) {
    names.add(answer.choice);
  }
  const out: Awaited<ReturnType<typeof classifyGroupRecipients>> = {
    names,
    choice: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
    model: result.model,
  };
  if (result.usage) {
    out.usage = result.usage;
  }
  return out;
}

export async function selectGroupHistory(args: {
  rows: Array<Record<string, unknown>>;
  agentName: string;
  agentFocus?: string;
  evaluate: TypeSafeEvaluateFn;
  limit?: number;
  candidateLimit?: number;
}): Promise<{
  rows: Array<Record<string, unknown>>;
  keep: Record<string, number>;
  model?: string;
  usage?: TypeSafeUsage;
}> {
  const keepLimit = args.limit ?? CONTEXT_HISTORY_LIMIT;
  const window = recentGroupRows(args.rows, args.candidateLimit ?? HISTORY_CANDIDATE_LIMIT);
  if (window.length <= keepLimit) {
    return { rows: window, keep: {} };
  }
  const latest = window[window.length - 1];
  const latestSeq = Number(latest?.seq);
  const always: number[] = [];
  if (Number.isFinite(latestSeq)) {
    always.push(latestSeq);
  }
  for (const row of [...window].reverse()) {
    const seq = Number(row.seq);
    if (storedTags(row).includes(args.agentName) && !always.includes(seq)) {
      always.push(seq);
    }
  }
  // One yes/no Noul per candidate row (the rerank pattern); agent and focus
  // live in state once instead of being repeated in every question.
  const questions: Record<string, TypeSafeQuestion> = {};
  for (const row of window) {
    const seq = Number(row.seq);
    if (always.includes(seq)) {
      continue;
    }
    questions[`keep_${seq}`] = {
      type: "noul",
      instructions: {
        seq,
        question:
          "Does `agent` need the message with this `seq` in `messages` as context to understand or act on `latest`?",
      },
      criteria: {
        true: "The message carries facts, decisions, or requests this agent still needs.",
        false: "Unrelated chatter or superseded detail for this agent.",
      },
    };
  }
  const keep: Record<string, number> = {};
  let model: string | undefined;
  let usage: TypeSafeUsage | undefined;
  if (Object.keys(questions).length) {
    const result = await args.evaluate({
      state: {
        agent: { name: args.agentName, focus: (args.agentFocus ?? "").trim() },
        latest: latest ? stateItem(latest, HISTORY_CONTENT_MAX_CHARS) : null,
        messages: window.map((row) => stateItem(row, HISTORY_CONTENT_MAX_CHARS)),
      },
      questions,
    });
    model = result.model;
    usage = result.usage;
    for (const row of window) {
      const seq = Number(row.seq);
      const id = `keep_${seq}`;
      if (!questions[id]) {
        continue;
      }
      keep[String(seq)] = requireNoul(result, id);
    }
  }
  const ranked = Object.entries(keep)
    .map(([seq, noul]) => ({ seq: Number(seq), noul }))
    .sort((left, right) => right.noul - left.noul || right.seq - left.seq);
  const selected = new Set<number>();
  for (const seq of always) {
    if (selected.size >= keepLimit) {
      break;
    }
    selected.add(seq);
  }
  for (const item of ranked) {
    if (selected.size >= keepLimit) {
      break;
    }
    selected.add(item.seq);
  }
  const rows = window.filter((row) => selected.has(Number(row.seq)));
  const out: Awaited<ReturnType<typeof selectGroupHistory>> = {
    rows: rows.length ? rows : window.slice(-keepLimit),
    keep,
  };
  if (model !== undefined) {
    out.model = model;
  }
  if (usage !== undefined) {
    out.usage = usage;
  }
  return out;
}

export function createGroupRouter(
  options: {
    client?: TypeSafeClient;
    sources?: IntegrationSources;
    confidenceMin?: number;
  } = {},
): GroupRouter {
  const client = options.client ?? createTypeSafeClient(options.sources ? { sources: options.sources } : {});
  const confidenceMin = options.confidenceMin ?? RECIPIENT_CONFIDENCE_MIN;
  return {
    get configured() {
      return client.configured;
    },
    async recipients(args) {
      const pendingNames = args.pending.map((agent) => String(agent.name)).filter(Boolean);
      const tagged = args.taggedNames ?? new Set<string>();
      // What the tag rules alone would deliver: the no-key behaviour.
      const ruleNames = args.ruleNames ?? tagged;
      if (!client.configured) {
        return { source: "tags", names: new Set(ruleNames) };
      }
      try {
        const classified = await classifyGroupRecipients({
          rows: args.rows,
          members: args.members,
          pendingNames,
          evaluate: client.evaluate,
        });
        const decision: RecipientDecision = {
          source: "typesafe",
          names: new Set([...tagged, ...classified.names]),
          choice: classified.choice,
          confidence: classified.confidence,
          probabilities: classified.probabilities,
        };
        if (classified.model) {
          decision.model = classified.model;
        }
        if (classified.usage) {
          decision.usage = classified.usage;
        }
        if (classified.confidence < confidenceMin) {
          decision.source = "low_confidence";
          decision.reason = `confidence ${classified.confidence.toFixed(2)} below ${confidenceMin}`;
          decision.names = new Set([...tagged, ...ruleNames]);
        }
        return decision;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        writeLog("warn", "typesafe recipients fallback", {
          operation: "group.recipients",
          error_type: error instanceof Error ? error.name : "Error",
          status: error instanceof TypeSafeError ? error.status : null,
        });
        return {
          source: "fallback",
          reason,
          names: new Set(pendingNames.length ? pendingNames : memberNames(args.members)),
        };
      }
    },
    async history(args) {
      const fallbackRows = recentGroupRows(args.rows, CONTEXT_HISTORY_LIMIT);
      if (!client.configured) {
        return { source: "limit", rows: fallbackRows };
      }
      try {
        const selected = await selectGroupHistory({
          rows: args.rows,
          agentName: args.agentName,
          ...(args.agentFocus !== undefined ? { agentFocus: args.agentFocus } : {}),
          evaluate: client.evaluate,
        });
        const decision: HistoryDecision = {
          source: "typesafe",
          rows: selected.rows,
          keep: selected.keep,
        };
        if (selected.model) {
          decision.model = selected.model;
        }
        if (selected.usage) {
          decision.usage = selected.usage;
        }
        return decision;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        writeLog("warn", "typesafe history fallback", {
          operation: "group.history",
          error_type: error instanceof Error ? error.name : "Error",
          status: error instanceof TypeSafeError ? error.status : null,
        });
        return { source: "fallback", reason, rows: fallbackRows };
      }
    },
  };
}

export function defaultGroupRouter(): GroupRouter {
  if (process.env.NODE_TEST_CONTEXT) {
    return createGroupRouter({ sources: { env: {}, keys: {} } });
  }
  return createGroupRouter();
}
