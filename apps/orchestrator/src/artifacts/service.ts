import type { AgentRow } from "../db/agents.js";
import type { HashedArtifactRow, ArtifactRow } from "../db/artifacts.js";
import type { RunTaskSource, TaskEmbedSnapshot } from "../db/schema/index.js";
import {
  collectTaskEmbeds,
  embedSource,
  inlineTaskEmbeds,
  snapshotTaskCollections,
  snapshotTaskEmbeds,
  taskEmbedActor,
} from "./embeds.js";
import { ArtifactError } from "./errors.js";
import { getMemoryRow, storedMemoryText } from "./memory.js";
import { getByDisplayPath } from "./notes.js";
import { parseDisplayPath, type ParsedDisplayPath } from "./paths.js";
import type { ArtifactStore } from "./store.js";
import { taskDisplayPath } from "./task.js";
import type { ArtifactActor } from "./types.js";

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

/** What a display path holds for an actor: a row, live or deleted, or an archived Memory revision. */
export type ArtifactView =
  | { kind: "row"; row: ArtifactRow; deleted: boolean }
  | { kind: "revision"; content: string; displayPath: string };

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

/**
 * A display path the actor may name, parsed. ArtifactError when it is malformed, when it lies
 * outside the actor's organisation, or when it names the Memory archive to an agent: the archive
 * is the operator's, so its paths are unknown to an agent.
 */
export function parseActorPath(actor: ArtifactActor, href: string): ParsedDisplayPath {
  const parsed = parseDisplayPath(href);
  if (parsed.kind === "revision" && !actor.operator) {
    throw new ArtifactError("unknown artifact path", 404);
  }
  if (parsed.orgId !== actor.orgId) {
    throw new ArtifactError("artifact is not in this organisation", 404);
  }
  return parsed;
}

/**
 * What a display path holds for the actor. ArtifactError when `parseActorPath` refuses the path,
 * when it names a collection, and when it holds nothing the actor reads.
 */
export async function artifactAt(store: ArtifactStore, actor: ArtifactActor, href: string): Promise<ArtifactView> {
  parseActorPath(actor, href);
  const read = await getByDisplayPath(store, actor, href);
  if (read.revision) {
    return { kind: "revision", content: read.revision.content, displayPath: read.revision.display_path };
  }
  if (!read.row) {
    throw new ArtifactError("artifact not found", 404);
  }
  return { kind: "row", row: read.row, deleted: read.tombstone === true };
}
