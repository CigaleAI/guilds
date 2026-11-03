import { deleteCollection } from "../artifacts/collections.js";
import { deleteNoteById } from "../artifacts/notes.js";
import type { ArtifactActor } from "../artifacts/types.js";
import { deleteAgent } from "../db/agents.js";
import { deleteGuild } from "../db/guilds.js";
import type { ApplyCreated } from "../db/schema/index.js";
import type { RecipeApply } from "./apply.js";

/** What undoing an apply deletes: the guild it created, when it created one, and what it made in it. */
export type AppliedItems = ApplyCreated & { guildId: string | null };

/** One deletion of an undo: what it deletes, and the deletion. */
type UndoStep = { what: string; run: () => Promise<void> };

/**
 * Deletes what an apply made, as `actor`, one deletion after another: its agents, the guild it
 * created, its collections, and its notes by id. A note the guild's deletion leaves (the guild is
 * not private) is deleted by its own step; one it took (the guild is private) is skipped. A failed
 * deletion does not stop the others; returns each that failed, with why, none when the undo is whole.
 */
export async function undoApply(
  apply: Pick<RecipeApply, "db" | "artifacts">,
  actor: ArtifactActor,
  made: AppliedItems,
): Promise<string[]> {
  const steps: UndoStep[] = [
    ...made.agents.map((agentId) => ({ what: `agent ${agentId}`, run: () => deleteAgent(apply.db, agentId) })),
    ...(made.guildId === null
      ? []
      : [{ what: `guild ${made.guildId}`, run: () => deleteGuild(apply.db, made.guildId ?? "") }]),
    ...made.collections.map((collectionId) => ({
      what: `collection ${collectionId}`,
      run: () => deleteCollection(apply.artifacts, actor, collectionId).then(() => undefined),
    })),
    ...made.notes.map((noteId) => ({ what: `note ${noteId}`, run: () => deleteNoteById(apply.artifacts, actor, noteId) })),
  ];
  const failures: string[] = [];
  // One at a time: an agent's deletion and its guild's both remove the access rows naming the agent.
  for (const step of steps) {
    const [settled] = await Promise.allSettled([step.run()]);
    if (settled?.status === "rejected") {
      failures.push(`${step.what}: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`);
    }
  }
  return failures;
}
