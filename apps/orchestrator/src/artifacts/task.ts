import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type pg from "pg";
import {
  collectTaskEmbeds,
  EMBED_DEPTH,
  embedSource,
  inlineTaskEmbeds,
  inspectEmbed,
  inspectTaskEmbeds,
  noteReader,
  snapshotTaskCollections,
  snapshotTaskEmbeds,
  taskEmbedActor,
  walkTaskEmbeds,
  type EmbedStep,
} from "./embeds.js";
import { ArtifactError } from "./errors.js";
import { getMemoryRow, storedMemoryText } from "./memory.js";
import { displayPathFor } from "./paths.js";
import type { ArtifactStore } from "./store.js";
import { TASK_REVISIONS_MAX, WRITE_MAX_BYTES, type ArtifactActor } from "./types.js";
import {
  getAgentTask,
  insertTaskRevision,
  lockAgentTask,
  pruneTaskRevisions,
  updateAgentTask,
  type AgentRow,
  type AgentTaskRow,
} from "../db/agents.js";
import type { HashedArtifactRow } from "../db/artifacts.js";
import { recordFileChange } from "../db/file-changes.js";
import { type Queryable, withTransaction } from "../db/pg.js";
import type { RunTaskSource, TaskEmbedSnapshot } from "../db/schema/index.js";

const FALLBACK_TASK = "Assist the user and collaborate with the guild members.\n";

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
async function writeAgentTaskInTransaction(
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

/** A draft of an agent's Task: the text it proposes and the version of the Task it was built on. */
export type TaskDraft = { content: string; baseVersion: number };

/**
 * What publishing a draft did: nothing when the agent has no Task, when its Task is no longer at
 * the draft's version, or when the draft's text is the Task's; otherwise the Task as written.
 */
export type TaskPublish =
  | { outcome: "missing" }
  | { outcome: "conflict" }
  | { outcome: "unchanged" }
  | { outcome: "published"; task: AgentTaskRow };

/**
 * Writes a draft as the agent's Task inside the transaction `tx` runs, when the Task is still at
 * the draft's version and the draft changes its text. A version that moves on during the write is
 * a conflict too.
 */
export async function publishAgentTask(
  tx: pg.PoolClient,
  actor: ArtifactActor,
  agentId: string,
  draft: TaskDraft,
): Promise<TaskPublish> {
  const live = await getAgentTask(tx, actor.orgId, agentId);
  if (!live) {
    return { outcome: "missing" };
  }
  if (live.version !== draft.baseVersion) {
    return { outcome: "conflict" };
  }
  if (hashTaskContent(draft.content) === live.content_hash) {
    return { outcome: "unchanged" };
  }
  try {
    const task = await writeAgentTaskInTransaction(tx, actor, agentId, draft.content, draft.baseVersion);
    return { outcome: "published", task };
  } catch (error) {
    if (error instanceof ArtifactError && error.status === 409) {
      return { outcome: "conflict" };
    }
    throw error;
  }
}

/** A Task's text with its embeds inlined, or why the store refuses to inline them. */
export type TaskExpansion = { ok: true; text: string } | { ok: false; error: string };

/** An agent's Task as its next run reads it, and the Memory the run reads beside it. */
export type AgentTaskView = {
  /** The Task as the operator wrote it. */
  text: string;
  version: number;
  /** The hash of `text`. */
  hash: string;
  displayPath: string;
  /** Whether `text` embeds a note or a table. */
  hasEmbeds: boolean;
  /** `text` with its embeds inlined as the agent reads them. */
  expanded: TaskExpansion;
  /** The agent's Memory as stored; null when it has none. */
  memory: HashedArtifactRow | null;
  /** The Memory text a prompt reads. */
  memoryText: string;
};

/** `text` as the agent's run would read it as its Task: its embeds inlined as the agent reads them. ArtifactError past the embed budget. */
export async function expandTaskText(store: ArtifactStore, agent: AgentRow, text: string): Promise<string> {
  return inlineTaskEmbeds(embedSource(store), taskEmbedActor(agent.org_id, agent), text);
}

/** The agent's Task, inlined as its next run reads it, with the agent's Memory. */
export async function agentTask(store: ArtifactStore, agent: AgentRow): Promise<AgentTaskView> {
  let expanded: TaskExpansion;
  try {
    expanded = { ok: true, text: await expandTaskText(store, agent, agent.task) };
  } catch (error) {
    if (!(error instanceof ArtifactError)) {
      throw error;
    }
    expanded = { ok: false, error: error.message };
  }
  const memory = await getMemoryRow(store, taskEmbedActor(agent.org_id, agent), agent.id);
  return {
    text: agent.task,
    version: agent.task_version,
    hash: agent.task_hash,
    displayPath: taskDisplayPath(agent.org_id, agent.id),
    hasEmbeds: collectTaskEmbeds(agent.task).length > 0,
    expanded,
    memory,
    memoryText: storedMemoryText(memory),
  };
}

/**
 * Where a run's Task comes from: its version, hash and display path, and the notes and
 * collections it embeds as the agent reads them. A walk the store refuses keeps what it
 * snapshotted before the refusal.
 */
export async function taskSnapshot(store: ArtifactStore, agent: AgentRow): Promise<RunTaskSource> {
  const source = embedSource(store);
  const actor = taskEmbedActor(agent.org_id, agent);
  let embeds: TaskEmbedSnapshot[] = [];
  let collections: string[] = [];
  try {
    embeds = await snapshotTaskEmbeds(source, actor, agent.task);
    collections = await snapshotTaskCollections(source, actor, agent.task);
  } catch (error) {
    if (!(error instanceof ArtifactError)) {
      throw error;
    }
  }
  return {
    version: agent.task_version,
    hash: agent.task_hash,
    display_path: taskDisplayPath(agent.org_id, agent.id),
    embeds,
    collections,
    has_embeds: collectTaskEmbeds(agent.task).length > 0,
  };
}

/** The embeds an agent's run meets in its Task, one level past what it inlines, and the inlined ones the agent cannot read. */
export type TaskEmbedRun = { steps: EmbedStep[]; unreachable: Set<string> };

/** How the agent's run walks the embeds of its Task, as the agent reads them. */
export async function taskEmbedRun(
  store: ArtifactStore,
  agent: Pick<AgentRow, "org_id" | "id" | "guild_id" | "name" | "task">,
): Promise<TaskEmbedRun> {
  const source = embedSource(store);
  const actor = taskEmbedActor(agent.org_id, agent);
  const steps = await walkTaskEmbeds(agent.task, noteReader(source, actor), EMBED_DEPTH + 1);
  const hrefs = [...new Set(steps.filter((step) => step.inlined).map((step) => step.href))];
  const inspected = await Promise.all(hrefs.map((href) => inspectEmbed(source, actor, href)));
  return { steps, unreachable: new Set(inspected.filter((item) => !item.ok).map((item) => item.href)) };
}

/** The embeds of the agent's Task, and of the notes its run inlines, that do not resolve as the agent reads them. */
export async function brokenTaskEmbeds(
  store: ArtifactStore,
  agent: Pick<AgentRow, "org_id" | "id" | "guild_id" | "name" | "task">,
): Promise<string[]> {
  const inspected = await inspectTaskEmbeds(embedSource(store), taskEmbedActor(agent.org_id, agent), agent.task);
  return inspected.filter((item) => !item.ok).map((item) => item.href);
}
