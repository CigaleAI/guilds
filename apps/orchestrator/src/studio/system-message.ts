// The system message a Studio session stores at seq 0, recomposed from the live roster before each
// generation.

import type pg from "pg";
import { getConversationMessage, updateConversationMessage } from "../db/conversations.js";
import type { Queryable } from "../db/pg.js";
import type { StudioInventoryRow, StudioSessionRow } from "../db/studio.js";
import { composeStudioSystemMessage, hydrateStudioMember, readStudioSystemTemplate } from "./system.js";

/** What the stored system message is read and rewritten through. */
export type SystemMessageDeps = {
  db: Queryable;
  notesSystemPath: string;
};

/** The system message for this generation, from the roster rows the caller already read. */
export function composeLiveSystem(
  notesSystemPath: string,
  session: StudioSessionRow,
  rows: StudioInventoryRow[],
): { content: string; hash: string } {
  const config = session.config_snapshot;
  const members = rows.map((row) => hydrateStudioMember(row));
  return composeStudioSystemMessage({
    mode: session.mode,
    template: readStudioSystemTemplate({ guidelinesPath: notesSystemPath }),
    sourceGuild: session.source_guild_id ? { ...session.source_guild_snapshot, id: session.source_guild_id } : null,
    members,
    config: {
      model: config.model,
      temperature: config.temperature,
      max_tokens: config.max_tokens,
      max_steps: config.max_steps,
      max_tool_calls: config.max_tool_calls,
      max_input_tokens: config.max_input_tokens,
    },
  });
}

/** Recomposes the session's system message and rewrites its stored row when the hash changed. */
export async function refreshSystemMessage(
  deps: SystemMessageDeps,
  session: StudioSessionRow,
  rows: StudioInventoryRow[],
  client?: pg.PoolClient,
): Promise<string> {
  const system = composeLiveSystem(deps.notesSystemPath, session, rows);
  const existing = await getConversationMessage(client ?? deps.db, "studio", session.id, 0);
  if (existing && existing.metadata.system_prompt_hash !== system.hash) {
    await updateConversationMessage(client ?? deps.db, "studio", {
      session_id: session.id,
      seq: 0,
      payload: { role: "system", content: system.content },
      metadata: { ...existing.metadata, source: "studio_system", system_prompt_hash: system.hash, refreshed: true },
    });
  }
  return system.content;
}
