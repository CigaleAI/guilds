import type { AttachmentRef, AttachmentService } from "../attachments/index.js";
import { getAgent, type AgentRow } from "../db/agents.js";
import { isPlainRecord, jsonObj } from "../db/json.js";
import type { Queryable } from "../db/pg.js";
import { listMessages, type RunRow } from "../db/runs.js";
import { messageItem } from "../db/views.js";
import { RunRequestError, type GenerationLoop } from "./index.js";

/** What an operator starts and talks to runs through, built once from the app's services. */
export type RunOperatorServices = {
  db: Queryable;
  /** The generation loop that runs the agents; absent on a box without one. */
  loop: GenerationLoop | null;
  /** The chat image store; absent on a box without one. */
  attachments: AttachmentService | null;
};

/** A run an operator opens: its first message, or null for a run that waits for one, and its images. */
export type RunStart = { message: unknown; attachmentIds: string[] };

/** A message an operator adds to a run, and its images. */
export type RunMessage = { content: unknown; attachmentIds: string[] };

/** The generation loop; a box without one runs nothing (503). */
export function generationLoopOf(services: { loop: GenerationLoop | null }): GenerationLoop {
  if (services.loop === null) {
    throw new RunRequestError(503, "generation is unavailable");
  }
  return services.loop;
}

/** A request's `attachment_ids`: attachment ids, none when absent. */
export function validateAttachmentIds(raw: unknown): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new RunRequestError(422, "attachment_ids must be an array");
  }
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) {
      throw new RunRequestError(422, "attachment_ids must be attachment ids");
    }
    ids.push(item.trim());
  }
  return ids;
}

function modelOf(agent: AgentRow): string {
  const config = jsonObj(agent.config);
  const model = isPlainRecord(config) ? config.model : undefined;
  return typeof model === "string" ? model : "";
}

/** The images a message carries, checked against the organisation's uploads and the agent's model. */
async function resolveAttachments(
  services: RunOperatorServices,
  agent: AgentRow,
  ids: string[],
): Promise<AttachmentRef[]> {
  if (!ids.length) {
    return [];
  }
  if (services.attachments === null) {
    throw new RunRequestError(503, "attachments are not configured");
  }
  return services.attachments.resolveForMessage({
    orgId: agent.org_id,
    model: modelOf(agent),
    ids,
  });
}

/**
 * Opens a run on the agent for the user: with its first message, or waiting for one when there
 * is neither a message nor an image. `withMessage` says which.
 */
export async function startRun(
  services: RunOperatorServices,
  agent: AgentRow,
  userId: string,
  start: RunStart,
): Promise<{ run: Record<string, unknown>; withMessage: boolean }> {
  const ids = start.attachmentIds;
  const raw = start.message;
  const message = raw === undefined || raw === null ? (ids.length ? "" : null) : String(raw);
  if (message !== null && !message.trim() && !ids.length) {
    throw new RunRequestError(422, "message must not be empty");
  }
  const attachments = await resolveAttachments(services, agent, ids);
  const run = await generationLoopOf(services).runs.createRun(agent.id, message, attachments, userId);
  return { run, withMessage: message !== null };
}

/** Adds the operator's message to the run; it carries text, images, or both. */
export async function postRunMessage(
  services: RunOperatorServices,
  run: RunRow,
  message: RunMessage,
): Promise<Record<string, unknown>> {
  const agent = await getAgent(services.db, run.agent_id);
  if (agent === null) {
    throw new RunRequestError(404, "run not found");
  }
  const ids = message.attachmentIds;
  const content =
    message.content === undefined || message.content === null ? "" : String(message.content);
  if (!content.trim() && !ids.length) {
    throw new RunRequestError(422, "content must not be empty");
  }
  const attachments = await resolveAttachments(services, agent, ids);
  return generationLoopOf(services).addMessage(run.id, content, attachments);
}

export async function listRunMessages(
  db: Queryable,
  run: RunRow,
): Promise<Array<ReturnType<typeof messageItem>>> {
  return (await listMessages(db, run.id)).map((row) => messageItem(row));
}
