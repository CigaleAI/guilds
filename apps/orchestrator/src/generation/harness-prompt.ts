import type { MessageRow } from "../db/runs.js";

/** What a turn of the harness reads: the run's system prompt, and the messages that opened the generation. */
export type HarnessTurnPrompt = { system: string; prompt: string };

/**
 * What a turn of the harness reads from the run's rows: the system prompt the run starts with,
 * and the user messages added since the run's last reply, in the text a model is sent them.
 */
export function harnessTurnPrompt(rows: MessageRow[]): HarnessTurnPrompt {
  const system =
    rows.flatMap((row) => (row.payload.role === "system" ? [row.payload.content] : []))[0] ?? "";
  const lastReply = rows.findLastIndex(
    (row) => row.payload.role === "assistant" || row.payload.role === "tool",
  );
  const opening = rows
    .slice(lastReply + 1)
    .flatMap((row) => (row.payload.role === "user" ? [row.payload.content] : []));
  return { system, prompt: opening.join("\n\n") };
}
