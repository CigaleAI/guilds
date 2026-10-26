import { newId } from "../lib/ids.js";
import { type Queryable, stamp } from "./pg.js";
import { iso } from "./views.js";

/** The coach message an operator applied a change from: its Studio session and sequence. */
export type StudioOrigin = { sessionId: string; seq: number };

/**
 * Who made a change: a person, an agent, or an agent's run, with the tool
 * call that carried it and, for an edit applied in the Studio, its coach message.
 */
export type ChangeActor = {
  actorType: "user" | "agent" | "run";
  actorId: string;
  actorName: string;
  toolCall: { id: string; name: string } | null;
  studio?: StudioOrigin;
};

export type ConfigTargetKind = "routine" | "access" | "guild_text" | "collection" | "note" | "file";
export type ConfigOperation = "create" | "update" | "delete";

/**
 * One change to record. Where it sits defaults from what is named: an agent
 * gives its guild and organisation, a guild its organisation.
 */
export type ConfigChange = {
  targetKind: ConfigTargetKind;
  targetId: string;
  operation: ConfigOperation;
  summary: string;
  orgId?: string | null;
  guildId?: string | null;
  agentId?: string | null;
};

export type ChangeLink = { session_id: string; seq: number };

export type ConfigChangeView = {
  id: string;
  guild_id: string | null;
  agent_id: string | null;
  target_kind: ConfigTargetKind;
  target_id: string;
  operation: ConfigOperation;
  summary: string;
  actor: { type: string; id: string; name: string };
  run_id: string | null;
  tool: { call_id: string; name: string | null } | null;
  studio: ChangeLink | null;
  created_at: string;
};

/** A person acting through the app or the API. */
export function userActor(user: Record<string, unknown>): ChangeActor {
  return {
    actorType: "user",
    actorId: String(user.id),
    actorName: String(user.name ?? "operator"),
    toolCall: null,
  };
}

/** An agent's run acting through one of its tool calls. */
export function runActor(
  run: { runId: string; agentName: string },
  toolCall: { id: string; name: string },
): ChangeActor {
  return { actorType: "run", actorId: run.runId, actorName: run.agentName, toolCall };
}

/** The actor, run, tool call, and coach message columns `file_changes` and `config_changes` share, in that order. */
export function actorColumns(actor: ChangeActor): unknown[] {
  return [
    actor.actorType,
    actor.actorId,
    actor.actorName,
    actor.actorType === "run" ? actor.actorId : null,
    actor.toolCall?.id ?? null,
    actor.toolCall?.name ?? null,
    actor.studio?.sessionId ?? null,
    actor.studio?.seq ?? null,
  ];
}

/** The coach message a stored change links to, or null when none does. */
export function studioLink(row: Record<string, unknown>): ChangeLink | null {
  if (!row.studio_session_id || row.studio_seq === null || row.studio_seq === undefined) {
    return null;
  }
  return { session_id: String(row.studio_session_id), seq: Number(row.studio_seq) };
}

// The organisation and guild a change names nothing for follow from its agent or guild.
const INSERT_CONFIG_CHANGE = `
  INSERT INTO config_changes (
    id, org_id, guild_id, agent_id, target_kind, target_id, operation, summary,
    actor_type, actor_id, actor_name, run_id, tool_call_id, tool_name,
    studio_session_id, studio_seq, created_at
  )
  SELECT $1, COALESCE($2::text, a.org_id, g.org_id), COALESCE($3::text, a.guild_id), $4::text,
         $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
    FROM (SELECT 1) AS one
    LEFT JOIN agents a ON a.id = $4::text
    LEFT JOIN guilds g ON g.id = COALESCE($3::text, a.guild_id)`;

export async function recordConfigChange(
  db: Queryable,
  actor: ChangeActor,
  change: ConfigChange,
): Promise<string> {
  const id = newId("cchg");
  await db.query(INSERT_CONFIG_CHANGE, [
    id,
    change.orgId ?? null,
    change.guildId ?? null,
    change.agentId ?? null,
    change.targetKind,
    change.targetId,
    change.operation,
    change.summary,
    ...actorColumns(actor),
    stamp(new Date()),
  ]);
  return id;
}

/** Records `change` unless it is null: a write that changed nothing logs nothing. */
export async function recordChangeIfAny(
  db: Queryable,
  actor: ChangeActor,
  change: ConfigChange | null,
): Promise<void> {
  if (change) {
    await recordConfigChange(db, actor, change);
  }
}

function mapConfigChange(row: Record<string, unknown>): ConfigChangeView {
  return {
    id: String(row.id),
    guild_id: row.guild_id ? String(row.guild_id) : null,
    agent_id: row.agent_id ? String(row.agent_id) : null,
    target_kind: String(row.target_kind) as ConfigTargetKind,
    target_id: String(row.target_id),
    operation: String(row.operation) as ConfigOperation,
    summary: String(row.summary),
    actor: { type: String(row.actor_type), id: String(row.actor_id), name: String(row.actor_name) },
    run_id: row.run_id ? String(row.run_id) : null,
    tool: row.tool_call_id
      ? { call_id: String(row.tool_call_id), name: row.tool_name ? String(row.tool_name) : null }
      : null,
    studio: studioLink(row),
    created_at: iso(row.created_at),
  };
}

/** Every recorded change to one target of an organisation, newest first. */
export async function listConfigChanges(
  db: Queryable,
  orgId: string,
  target: { kind: ConfigTargetKind; id: string },
): Promise<ConfigChangeView[]> {
  const result = await db.query(
    `SELECT id, guild_id, agent_id, target_kind, target_id, operation, summary,
            actor_type, actor_id, actor_name, run_id, tool_call_id, tool_name,
            studio_session_id, studio_seq, created_at
       FROM config_changes
      WHERE org_id = $1 AND target_kind = $2 AND target_id = $3
      ORDER BY created_at DESC, id DESC`,
    [orgId, target.kind, target.id],
  );
  return (result.rows as Array<Record<string, unknown>>).map(mapConfigChange);
}
