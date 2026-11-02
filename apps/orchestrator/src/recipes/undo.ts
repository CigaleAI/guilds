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
 * created, its collections, and its notes, whose rows may name no guild or agent it made (an
 * organisation row alone). A failed deletion does not stop the others; returns each that failed,
 * with why, none when the undo is whole.
 */
export async function undoApply(
  apply: Pick<RecipeApply, "db" | "artifacts">,
  actor: ArtifactActor,
  made: AppliedItems,
): Promise<string[]> {
  const steps: UndoStep[] = [
    ...made.agents.map((agentId) => ({ what: `agent ${agentId}`, run: () => deleteAgent(apply.db, agentId, actor) })),
    ...(made.guildId === null
      ? []
      : [{ what: `guild ${made.guildId}`, run: () => deleteGuild(apply.db, made.guildId ?? "", actor) }]),
    ...made.collections.map((collectionId) => ({
      what: `collection ${collectionId}`,
      run: () => deleteCollection(apply.artifacts, actor, collectionId).then(() => undefined),
    })),
    ...made.notes.map((noteId) => ({ what: `note ${noteId}`, run: () => deleteNoteById(apply.artifacts, actor, noteId) })),
  ];
  const failures: string[] = [];
  // One at a time: a deletion reads the access rows the one before it left, so an item whose rows
  // name only agents the apply made is deleted with the last of them.
  for (const step of steps) {
    const [settled] = await Promise.allSettled([step.run()]);
    if (settled?.status === "rejected") {
      failures.push(`${step.what}: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`);
    }
  }
  return failures;
}
