import type { MessageRow } from "../db/runs.js";
import type { AttachmentRef } from "../db/schema/index.js";

/** What a turn of the harness reads: the run's system prompt, and the messages that opened the generation. */
export type HarnessTurnPrompt = { system: string; prompt: string };

/** The rows that open the generation: the user messages added since the run's last reply. */
function openingRows(rows: MessageRow[]): MessageRow[] {
  const lastReply = rows.findLastIndex(
    (row) => row.payload.role === "assistant" || row.payload.role === "tool",
  );
  return rows.slice(lastReply + 1).filter((row) => row.payload.role === "user");
}

/** Where, relative to the agent's home, a turn of run `runId` reads an image attached to one of its messages. */
export function attachmentHomePath(runId: string, ref: AttachmentRef): string {
  return `.runs/${runId}/attachments/${ref.id}/${ref.filename}`;
}

/** The images attached to the messages that open the generation, in their order. */
export function openingAttachments(rows: MessageRow[]): AttachmentRef[] {
  return openingRows(rows).flatMap((row) => row.metadata.attachments ?? []);
}

/** A message as the harness reads it: its text, then a line naming each image attached to it at its path under `home`. */
function messageText(row: MessageRow, home: string): string {
  const images = (row.metadata.attachments ?? []).map(
    (ref) => `Attached image: ${home}/${attachmentHomePath(row.run_id, ref)}`,
  );
  return [row.payload.content, ...images].filter((part) => part.length > 0).join("\n");
}

/**
 * What a turn of the harness reads from the run's rows: the system prompt the run starts with,
 * and the user messages added since the run's last reply, each in the text a model is sent it
 * with a line naming each image attached to it, at its path under the agent's home `home`.
 */
export function harnessTurnPrompt(rows: MessageRow[], home: string): HarnessTurnPrompt {
  const system =
    rows.flatMap((row) => (row.payload.role === "system" ? [row.payload.content] : []))[0] ?? "";
  const opening = openingRows(rows).map((row) => messageText(row, home));
  return { system, prompt: opening.join("\n\n") };
}
