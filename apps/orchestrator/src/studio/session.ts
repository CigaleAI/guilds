// A Studio session as every Studio module reads it: whether it is live, how the operator app reads
// it, the guild it records, the logins its coach holds, its conversation, and what the sessions
// spent.

import {
  conversationUsageByOrg,
  listConversationMessages,
  type ConversationMessageRow,
  type ConversationUsageRow,
} from "../db/conversations.js";
import type { GuildRow } from "../db/guilds.js";
import type { Queryable } from "../db/pg.js";
import type { CoachSessionConfig, StudioSourceGuild } from "../db/schema/index.js";
import type { StudioSessionRow } from "../db/studio.js";
import { StudioConflictError } from "./errors.js";

/** A session an operator can still work in: not archived or blocked, its source guild still there. */
export type LiveStudioSession = StudioSessionRow & { source_guild_id: string };

/**
 * A Studio session as the operator app reads it: where it stands, its guild as the session recorded
 * it, the logins its coach may read through, and its coach's model and limits.
 */
export type StudioSession = Pick<
  StudioSessionRow,
  | "id"
  | "org_id"
  | "mode"
  | "status"
  | "blocked_reason"
  | "generation_state"
  | "generation_number"
  | "source_guild_id"
  | "selected_target_agent_id"
  | "parent_session_id"
  | "created_by_name"
  | "created_at"
  | "updated_at"
  | "archived_at"
> & {
  source_guild: StudioSessionRow["source_guild_snapshot"];
  granted_connection_ids: string[];
  coach: Pick<CoachSessionConfig, "model" | "temperature" | "max_tokens" | "max_steps" | "max_tool_calls" | "max_input_tokens">;
};

/** The session's work goes on: StudioConflictError when it is archived, blocked, or its source guild is gone. */
export function assertLive(session: StudioSessionRow): asserts session is LiveStudioSession {
  if (session.status === "archived") {
    throw new StudioConflictError("session is archived");
  }
  if (!session.source_guild_id || session.status === "blocked") {
    throw new StudioConflictError("session source is not live");
  }
}

/** The logins the session's coach may read through. */
export function grantedConnectionIds(session: StudioSessionRow): string[] {
  const raw = session.granted_connection_ids;
  return Array.isArray(raw) ? raw.map((id) => String(id)) : [];
}

/** The guild as a session records it; its description is the coach's objective. */
export function sourceGuildSnapshot(guild: Pick<GuildRow, "id" | "name" | "about" | "description">): StudioSourceGuild {
  const objective = guild.description.trim();
  return { id: guild.id, name: guild.name, about: guild.about, ...(objective ? { objective } : {}) };
}

/** The session as the operator app reads it. */
export function viewSession(row: StudioSessionRow): StudioSession {
  const config = row.config_snapshot;
  return {
    id: row.id,
    org_id: row.org_id,
    mode: row.mode,
    status: row.status,
    blocked_reason: row.blocked_reason,
    generation_state: row.generation_state,
    generation_number: row.generation_number,
    source_guild_id: row.source_guild_id,
    source_guild: row.source_guild_snapshot,
    selected_target_agent_id: row.selected_target_agent_id,
    parent_session_id: row.parent_session_id,
    granted_connection_ids: grantedConnectionIds(row),
    coach: {
      model: config.model,
      temperature: config.temperature,
      max_tokens: config.max_tokens,
      max_steps: config.max_steps,
      max_tool_calls: config.max_tool_calls,
      max_input_tokens: config.max_input_tokens,
    },
    created_by_name: row.created_by_name,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
  };
}

/** The session's conversation, in order. */
export async function listSessionMessages(
  db: Queryable,
  sessionId: StudioSessionRow["id"],
): Promise<ConversationMessageRow[]> {
  return listConversationMessages(db, "studio", sessionId);
}

/** What Studio sessions spent, per organisation. */
export async function studioUsageByOrg(db: Queryable): Promise<Map<string, ConversationUsageRow>> {
  return conversationUsageByOrg(db, "studio");
}
