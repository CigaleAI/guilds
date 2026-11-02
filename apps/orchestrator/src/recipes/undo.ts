import { deleteCollection } from "../artifacts/collections.js";
import { deleteNoteById } from "../artifacts/notes.js";
import type { ArtifactActor } from "../artifacts/types.js";
import { deleteAgent } from "../db/agents.js";
import { deleteGuild } from "../db/guilds.js";
import type { ApplyCreated } from "../db/schema/index.js";
import type { RecipeApply } from "./apply.js";

/** What undoing an apply deletes: the guild it created, when it created one, and what it made in it. */
export type AppliedItems = ApplyCreated & { guildId: string | null };

/**
 * Deletes what an apply made, as `actor`: its agents, the guild it created, its collections, and
 * its notes, whose rows may name no guild or agent it made (an organisation row alone). Each
 * deletion goes on when another fails.
 */
export async function undoApply(
  apply: Pick<RecipeApply, "db" | "artifacts">,
  actor: ArtifactActor,
  made: AppliedItems,
): Promise<void> {
  await Promise.allSettled(made.agents.map((agentId) => deleteAgent(apply.db, agentId, actor)));
  if (made.guildId !== null) {
    await Promise.allSettled([deleteGuild(apply.db, made.guildId, actor)]);
  }
  await Promise.allSettled(made.collections.map((collectionId) => deleteCollection(apply.artifacts, actor, collectionId)));
  await Promise.allSettled(made.notes.map((noteId) => deleteNoteById(apply.artifacts, actor, noteId)));
}
