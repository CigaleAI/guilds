import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type pg from "pg";
import { ArtifactError } from "./errors.js";
import { displayPathFor } from "./paths.js";
import { TASK_REVISIONS_MAX, WRITE_MAX_BYTES, type ArtifactActor } from "./types.js";
import {
  insertTaskRevision,
  lockAgentTask,
  pruneTaskRevisions,
  updateAgentTask,
  type AgentTaskRow,
} from "../db/agents.js";
import { recordFileChange } from "../db/file-changes.js";
import { type Queryable, withTransaction } from "../db/pg.js";

export const FALLBACK_TASK = "Assist the user and collaborate with the guild members.\n";
export const FALLBACK_TASK_HASH = "80672a5468f14aafbd6e02d8ca30846bdb8483f45e2408190cd4751a9e01d33a";

export function resolveTaskContent(seed: string, templatesRoot = ""): string {
  const focus = seed.trim();
  if (focus) {
    return `${focus}\n`;
  }
  if (!templatesRoot) {
    return FALLBACK_TASK;
  }
  try {
    return readFileSync(path.join(templatesRoot, "task.md"), "utf8");
  } catch {
    return FALLBACK_TASK;
  }
}

export function hashTaskContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function taskDisplayPath(orgId: string, agentId: string): string {
  return displayPathFor({
    orgId,
    level: "agent",
    ownerId: agentId,
    kind: "task",
    path: "",
    key: "task.md",
  });
}

export async function writeAgentTask(
  pool: Queryable,
  actor: ArtifactActor,
  agentId: string,
  content: string,
  expectedVersion?: number,
): Promise<AgentTaskRow> {
  return withTransaction(pool, (client) =>
    writeAgentTaskInTransaction(client, actor, agentId, content, expectedVersion),
  );
}

/**
 * Writes the agent's task inside the transaction `tx` runs. The text it replaces is kept as a
 * revision; a write that changes nothing returns the task as it is.
 */
export async function writeAgentTaskInTransaction(
  tx: pg.PoolClient,
  actor: ArtifactActor,
  agentId: string,
  content: string,
  expectedVersion?: number,
): Promise<AgentTaskRow> {
  if (!actor.operator) {
    throw new ArtifactError("task is not writable", 422);
  }
  if (Buffer.byteLength(content, "utf8") > WRITE_MAX_BYTES) {
    throw new ArtifactError("write exceeds 256 KB", 422);
  }
  const locked = await lockAgentTask(tx, actor.orgId, agentId);
  if (!locked) {
    throw new ArtifactError("task.md not found", 404);
  }
  if (expectedVersion !== undefined && locked.version !== expectedVersion) {
    throw new ArtifactError("version conflict", 409);
  }
  const hash = hashTaskContent(content);
  if (locked.content_hash === hash) {
    return locked;
  }
  const now = new Date();
  if (locked.content_text) {
    await insertTaskRevision(tx, locked, actor, now);
    await pruneTaskRevisions(tx, locked.org_id, agentId, TASK_REVISIONS_MAX);
  }
  const task = await updateAgentTask(tx, locked, { text: content, hash }, now);
  if (!task) {
    throw new ArtifactError("version conflict", 409);
  }
  await recordFileChange(tx, actor, {
    orgId: task.org_id,
    taskAgentId: task.agent_id,
    displayPath: taskDisplayPath(task.org_id, task.agent_id),
    operation: "update",
    version: task.version,
  });
  return task;
}
