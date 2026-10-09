import { jsonObj } from "../db/json.js";

/**
 * Run chains. A coding run whose prompt reaches this share of `max_input_tokens` asks the
 * agent for a hand-off and continues in a new run with a freshly composed prompt, so each
 * run's rows stay exactly what the model saw.
 */
export const HANDOFF_FRACTION = 0.7;
export const MAX_CHAIN_RUNS = 5;

export const HANDOFF_REQUEST =
  "Hand-off: this run's history is close to its input limit, so the work continues in a " +
  "new run that starts from a fresh prompt. Reply now with text only, no tool calls: the " +
  "hand-off that run starts from. Give the goal, what is done, what is decided, what " +
  "remains, and the files that matter as path:line. The working tree, Memory, and notes " +
  "carry over; this conversation does not.";

export const HANDOFF_TOOL_REFUSED = "ERROR: a hand-off was requested; reply with text only";

export const MAX_CHAIN_MESSAGE = `This task reached ${MAX_CHAIN_RUNS} chained runs. Start a new run to continue.`;

export type ChainPosition = { root_run_id: string; index: number; previous_run_id: string | null };

/** Where a run sits in its chain: a run without `metadata.chain` is the first of its own. */
export function chainOf(run: Record<string, unknown>): ChainPosition {
  const metadata = jsonObj(run.metadata);
  const chain =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).chain
      : null;
  if (chain && typeof chain === "object" && !Array.isArray(chain)) {
    const record = chain as Record<string, unknown>;
    const index = Number(record.index);
    if (typeof record.root_run_id === "string" && Number.isInteger(index) && index >= 1) {
      return {
        root_run_id: record.root_run_id,
        index,
        previous_run_id: typeof record.previous_run_id === "string" ? record.previous_run_id : null,
      };
    }
  }
  return { root_run_id: String(run.id), index: 1, previous_run_id: null };
}

/** The run that continued this one, when it did. */
export function continuedBy(run: Record<string, unknown>): string | null {
  const metadata = jsonObj(run.metadata);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const next = (metadata as Record<string, unknown>).continued_by_run_id;
  return typeof next === "string" && next ? next : null;
}

/** The text of the agent's hand-off reply; empty when it wrote none. */
export function handoffText(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" ? String((part as { text?: unknown }).text ?? "") : ""))
      .join("")
      .trim();
  }
  return "";
}

/** The one user message a continuation run opens with. */
export function continuationMessage(
  previousRunId: string,
  handoff: string,
): [Record<string, unknown>, Record<string, unknown>] {
  const body: Record<string, unknown> = { previous_run_id: previousRunId, handoff: handoff || null };
  if (!handoff) {
    body.note = "The previous run wrote no hand-off. Work from Memory, notes, and the working tree.";
  }
  return [
    { role: "user", content: `Continuation: ${JSON.stringify(body, null, 2)}` },
    { generation: 1, source: "continuation", previous_run_id: previousRunId },
  ];
}
