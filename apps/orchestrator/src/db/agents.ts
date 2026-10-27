import type { InferSelectModel } from "drizzle-orm";
import type { ChangeActor } from "../lib/change-actor.js";
import { newId } from "../lib/ids.js";
import { GuildNameTaken, RowMissing } from "./errors.js";
import { guildOperatorsColumn, type GuildOperatorRow } from "./guilds.js";
import { type Queryable, stamp, withTransaction } from "./pg.js";
import { agents, guilds, machines, orgs, taskRevisions, type Harness } from "./schema/index.js";

type Agent = InferSelectModel<typeof agents>;
type Machine = InferSelectModel<typeof machines>;
type Guild = InferSelectModel<typeof guilds>;

export type AgentSummaryRow = Pick<Agent, "id" | "guild_id" | "name" | "avatar_shape" | "avatar_color">;

export type GuildAgentRow = AgentSummaryRow &
  Pick<
    Agent,
    | "org_id"
    | "focus"
    | "wake_triggers"
    | "config"
    | "created_at"
    | "updated_at"
    | "task"
    | "task_version"
    | "task_hash"
    | "task_updated_at"
    | "machine_id"
    | "machine_slot"
  > & {
    machine_name: Machine["name"];
    machine_box: Machine["box"];
  };

export type AgentRow = GuildAgentRow &
  Pick<Agent, "workspace_mib" | "harness_logins"> & {
    machine_cpu: Machine["cpu"];
    machine_memory_mib: Machine["memory_mib"];
    machine_max_workspace_mib: Machine["max_workspace_mib"];
    machine_workspace_mib: Machine["workspace_mib"];
    machine_harnesses: Machine["harnesses"];
    guild_name: Guild["name"];
    guild_about: Guild["about"];
    guild_description: Guild["description"];
    org_slug: InferSelectModel<typeof orgs>["slug"];
    guild_operators: GuildOperatorRow[];
  };

/** Where an agent sits: its id, guild, and organisation. */
export type AgentPlaceRow = Pick<AgentRow, "id" | "guild_id" | "org_id">;

export type AgentConfigRow = Pick<
  Agent,
  "id" | "guild_id" | "name" | "config" | "created_at" | "updated_at"
>;

export type AgentConfigPatch = {
  name?: string | null | undefined;
  avatarShape?: string | null | undefined;
  avatarColor?: string | null | undefined;
  focus?: string | null | undefined;
  wakeTriggers?: string | null | undefined;
};

/** An agent's standing task as its file reads: `task.md`'s text, version, and hash. */
export type AgentTaskRow = {
  org_id: Agent["org_id"];
  agent_id: Agent["id"];
  content_text: Agent["task"];
  version: Agent["task_version"];
  content_hash: Agent["task_hash"];
  updated_at: Agent["task_updated_at"];
};

/** A task's new text and its hash. */
export type TaskContent = { text: string; hash: string };

/** A script as written: the row, its organisation, its version, and whether the write created it. */
export type WrittenAgentScript = {
  script: AgentScriptRow;
  orgId: string;
  version: number;
  created: boolean;
};

export type AgentTaskRevisionRow = Pick<
  InferSelectModel<typeof taskRevisions>,
  "version" | "replaced_at" | "replaced_by_name"
> & {
  content: string;
};

export type AgentScriptRow = {
  id: string;
  agent_id: string;
  name: string;
  description: string;
  parameters: Record<string, unknown> | null;
  source: string;
  source_hash: string;
  created_at: string;
  updated_at: string;
};

export type NewAgent = {
  agentId: string;
  guildId: string;
  name: string;
  config: Agent["config"];
  focus?: string | undefined;
  wakeTriggers?: string | undefined;
  avatarShape?: string | undefined;
  avatarColor?: string | undefined;
  task?: string | undefined;
  taskHash?: string | undefined;
};

/** Where a new agent goes: a named machine, and the most agents a machine may hold. */
export type AgentPlacement = {
  machineId?: string | null | undefined;
  maxAgentsPerMachine?: number | null | undefined;
};

export type NewAgentScript = {
  scriptId: string;
  agentId: string;
  name: string;
  description: string;
  parameters: Record<string, unknown> | null;
  source: string;
  sourceHash: string;
};

type ScriptQueryRow = AgentScriptRow & {
  org_id: string;
  version: number;
};

const SCRIPT_RETURNING = `
  id, org_id, agent_id, key AS name, title AS description, content_json AS parameters,
  content_text AS source, content_hash AS source_hash, version, created_at, updated_at
`;

function scriptArtifactRow(row: ScriptQueryRow): AgentScriptRow {
  return {
    id: row.id,
    agent_id: row.agent_id,
    name: row.name,
    description: row.description,
    parameters: row.parameters ?? null,
    source: row.source,
    source_hash: row.source_hash,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listAllAgents(pool: Queryable): Promise<AgentSummaryRow[]> {
  const result = await pool.query<AgentSummaryRow>(
    `SELECT id, guild_id, name, avatar_shape, avatar_color FROM agents ORDER BY created_at`,
  );
  return result.rows;
}

export async function listAgents(pool: Queryable, guildId: string): Promise<GuildAgentRow[]> {
  const result = await pool.query<GuildAgentRow>(
    `SELECT a.id, a.guild_id, a.org_id, a.name, a.focus, a.wake_triggers, a.avatar_shape, a.avatar_color, a.config,
            a.created_at, a.updated_at, a.task, a.task_version, a.task_hash, a.task_updated_at,
            a.machine_id, a.machine_slot, m.name AS machine_name, m.box AS machine_box
     FROM agents a JOIN machines m ON m.id = a.machine_id
     WHERE a.guild_id = $1 ORDER BY a.created_at`,
    [guildId],
  );
  return result.rows;
}

/** Whether one of the guild's operators goes by `name`, which none of its agents may take. */
export async function guildHasOperatorNamed(db: Queryable, guildId: string, name: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM guild_operators go JOIN users u ON u.id = go.user_id
     WHERE go.guild_id = $1 AND u.name = $2`,
    [guildId, name],
  );
  return Boolean(result.rowCount);
}

/** A new agent as written: its task and the machine slot it sits in decided. */
export type AgentInsert = Omit<NewAgent, "task" | "taskHash"> & {
  task: string;
  taskHash: string;
  machineId: string;
  machineSlot: number;
};

/** Inserts an agent into its guild's organisation; returns the organisation and the task's first version. */
export async function insertAgent(
  db: Queryable,
  agent: AgentInsert,
  now: Date,
): Promise<{ org_id: string; task_version: number }> {
  const result = await db.query<{ org_id: string; task_version: number }>(
    `INSERT INTO agents (
       id, guild_id, name, config, focus, avatar_shape, avatar_color, org_id,
       created_at, updated_at, group_chat_delivered_through,
       task, task_version, task_hash, task_updated_at, wake_triggers, machine_id, machine_slot
     )
     SELECT $1, $2, $3, $4::jsonb, $6, $7, $8, p.org_id, $5, $5, p.group_chat_seq,
            $9, 1, $10, $5, $11, $12, $13
     FROM guilds p WHERE p.id = $2
     RETURNING org_id, task_version`,
    [
      agent.agentId,
      agent.guildId,
      agent.name,
      JSON.stringify(agent.config),
      stamp(now),
      agent.focus ?? "",
      agent.avatarShape ?? "teardrop",
      agent.avatarColor ?? "#7c5cff",
      agent.task,
      agent.taskHash,
      agent.wakeTriggers ?? "",
      agent.machineId,
      agent.machineSlot,
    ],
  );
  const row = result.rows[0] ?? null;
  if (!row) {
    throw new RowMissing("agent insert failed: guild not found");
  }
  return row;
}

/** Whether an agent of any organisation goes by `name`. */
export async function agentNameTaken(pool: Queryable, name: string): Promise<boolean> {
  const result = await pool.query(`SELECT 1 FROM agents WHERE name = $1 LIMIT 1`, [name]);
  return result.rows.length > 0;
}

export async function deleteAgent(pool: Queryable, agentId: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(
      `DELETE FROM artifact_access
        WHERE (subject_type = 'agent' AND subject_id = $1)
           OR (target_kind = 'note' AND target_id IN (SELECT id FROM artifacts WHERE agent_id = $1))`,
      [agentId],
    );
    // A secret granted only to this agent goes with it.
    await client.query(
      `DELETE FROM secrets s
        WHERE NOT s.org_wide
          AND EXISTS (SELECT 1 FROM secret_grants g WHERE g.secret_id = s.id AND g.agent_id = $1)
          AND NOT EXISTS (
                SELECT 1 FROM secret_grants g
                 WHERE g.secret_id = s.id AND (g.agent_id IS NULL OR g.agent_id <> $1))`,
      [agentId],
    );
    await client.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await client.query(`DELETE FROM usage_counters WHERE scope = 'agent' AND scope_id = $1`, [
      agentId,
    ]);
  });
}

export async function getAgent(pool: Queryable, agentId: string): Promise<AgentRow | null> {
  const result = await pool.query<AgentRow>(
    `SELECT
       a.id, a.guild_id, a.name, a.focus, a.wake_triggers, a.avatar_shape, a.avatar_color, a.config,
       a.created_at, a.updated_at,
       a.task, a.task_version, a.task_hash, a.task_updated_at, a.workspace_mib, a.harness_logins,
       a.machine_id, a.machine_slot, m.name AS machine_name, m.box AS machine_box,
       m.cpu AS machine_cpu, m.memory_mib AS machine_memory_mib,
       m.max_workspace_mib AS machine_max_workspace_mib, m.workspace_mib AS machine_workspace_mib,
       m.harnesses AS machine_harnesses,
       p.name AS guild_name, p.about AS guild_about, p.description AS guild_description,
       p.org_id AS org_id, o.slug AS org_slug,
       ${guildOperatorsColumn("guild_operators")}
     FROM agents a
     JOIN guilds p ON p.id = a.guild_id
     JOIN orgs o ON o.id = p.org_id
     JOIN machines m ON m.id = a.machine_id
     WHERE a.id = $1`,
    [agentId],
  );
  return result.rows[0] ?? null;
}

/** Records when the agent's harness last found a login in its home, and whose it is when known. */
export async function markHarnessLogin(
  pool: Queryable,
  agentId: string,
  harness: Harness,
  now: Date,
  account: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE agents
     SET harness_logins = harness_logins
       || jsonb_build_object($2::text, jsonb_build_object('seen_at', $3::text, 'account', $4::text))
     WHERE id = $1`,
    [agentId, harness, now.toISOString(), account],
  );
}

/** Forgets the agent's harness login, once a check found no credential in its home. */
export async function clearHarnessLogin(
  pool: Queryable,
  agentId: string,
  harness: Harness,
): Promise<void> {
  await pool.query(`UPDATE agents SET harness_logins = harness_logins - $2::text WHERE id = $1`, [
    agentId,
    harness,
  ]);
}

export async function setAgentWorkspaceMib(
  pool: Queryable,
  agentId: string,
  mib: number,
): Promise<void> {
  await pool.query(`UPDATE agents SET workspace_mib = $2 WHERE id = $1`, [agentId, mib]);
}

export async function getAgentTask(
  db: Queryable,
  orgId: string,
  agentId: string,
): Promise<AgentTaskRow | null> {
  const result = await db.query<AgentTaskRow>(
    `SELECT org_id, id AS agent_id, task AS content_text, task_version AS version,
            task_hash AS content_hash, task_updated_at AS updated_at
       FROM agents
      WHERE org_id = $1 AND id = $2`,
    [orgId, agentId],
  );
  return result.rows[0] ?? null;
}

const TASK_COLUMNS = `org_id, id AS agent_id, task AS content_text, task_version AS version,
  task_hash AS content_hash, task_updated_at AS updated_at`;

/** An agent's task, locked for the rest of the transaction `db` runs; null when there is no such agent. */
export async function lockAgentTask(
  db: Queryable,
  orgId: string,
  agentId: string,
): Promise<AgentTaskRow | null> {
  const result = await db.query<AgentTaskRow>(
    `SELECT ${TASK_COLUMNS} FROM agents WHERE org_id = $1 AND id = $2 FOR UPDATE`,
    [orgId, agentId],
  );
  return result.rows[0] ?? null;
}

/** Keeps the text of a task being replaced as a revision, stamped with who replaced it. */
export async function insertTaskRevision(
  db: Queryable,
  replaced: AgentTaskRow,
  actor: ChangeActor,
  now: Date,
): Promise<void> {
  await db.query(
    `INSERT INTO task_revisions (
       id, org_id, agent_id, version, content_text, replaced_at,
       replaced_by_type, replaced_by_id, replaced_by_name, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $6)`,
    [
      newId("trev"),
      replaced.org_id,
      replaced.agent_id,
      replaced.version,
      replaced.content_text,
      stamp(now),
      actor.actorType,
      actor.actorId,
      actor.actorName,
    ],
  );
}

/** Drops an agent's task revisions past the newest `keep`. */
export async function pruneTaskRevisions(
  db: Queryable,
  orgId: string,
  agentId: string,
  keep: number,
): Promise<void> {
  await db.query(
    `DELETE FROM task_revisions
      WHERE id IN (
        SELECT id FROM task_revisions
         WHERE org_id = $1 AND agent_id = $2
         ORDER BY version DESC
        OFFSET $3
      )`,
    [orgId, agentId, keep],
  );
}

/** Replaces the task `replaced` holds with `content`, one version up; null when its version moved on. */
export async function updateAgentTask(
  db: Queryable,
  replaced: AgentTaskRow,
  content: TaskContent,
  now: Date,
): Promise<AgentTaskRow | null> {
  const result = await db.query<AgentTaskRow>(
    `UPDATE agents
        SET task = $2, task_hash = $3, task_version = task_version + 1, task_updated_at = $4
      WHERE id = $1 AND org_id = $5 AND task_version = $6
      RETURNING ${TASK_COLUMNS}`,
    [replaced.agent_id, content.text, content.hash, stamp(now), replaced.org_id, replaced.version],
  );
  return result.rows[0] ?? null;
}

export async function listAgentTaskRevisions(
  pool: Queryable,
  orgId: string,
  agentId: string,
): Promise<AgentTaskRevisionRow[]> {
  const result = await pool.query<AgentTaskRevisionRow>(
    `SELECT version, content_text AS content, replaced_at, replaced_by_name
       FROM task_revisions
      WHERE org_id = $1 AND agent_id = $2
      ORDER BY version DESC`,
    [orgId, agentId],
  );
  return result.rows;
}

export async function updateAgentConfig(
  pool: Queryable,
  agentId: string,
  config: Agent["config"],
  now: Date,
  options: AgentConfigPatch = {},
): Promise<AgentConfigRow | null> {
  const writeConfigPatch = async (client: Queryable): Promise<AgentConfigRow | null> => {
    if (options.name) {
      const agent =
        (
          await client.query<{ guild_id: string }>(
            `SELECT guild_id FROM agents WHERE id = $1 FOR UPDATE`,
            [agentId],
          )
        ).rows[0] ?? null;
      if (!agent) {
        return null;
      }
      const clash = await client.query(
        `SELECT 1 FROM guild_operators go JOIN users u ON u.id = go.user_id
         WHERE go.guild_id = $1 AND u.name = $2`,
        [agent.guild_id, options.name],
      );
      if (clash.rowCount) {
        throw new GuildNameTaken(options.name, "operator");
      }
    }
    const result = await client.query<AgentConfigRow>(
      `UPDATE agents
       SET config = $2::jsonb,
           updated_at = $3,
           avatar_shape = COALESCE($4, avatar_shape),
           avatar_color = COALESCE($5, avatar_color),
           focus = COALESCE($6, focus),
           wake_triggers = COALESCE($7, wake_triggers),
           name = COALESCE($8, name)
       WHERE id = $1
       RETURNING id, guild_id, name, config, created_at, updated_at`,
      [
        agentId,
        JSON.stringify(config),
        stamp(now),
        options.avatarShape ?? null,
        options.avatarColor ?? null,
        options.focus ?? null,
        options.wakeTriggers ?? null,
        options.name ?? null,
      ],
    );
    return result.rows[0] ?? null;
  };
  return options.name ? withTransaction(pool, writeConfigPatch) : writeConfigPatch(pool);
}

/** Writes an agent's script, reviving a deleted one of the same name. */
export async function upsertAgentScript(
  pool: Queryable,
  script: NewAgentScript,
  actor: ChangeActor,
  now: Date,
): Promise<WrittenAgentScript> {
  const { scriptId, agentId, name, description, parameters, source, sourceHash } = script;
  return withTransaction(pool, async (client) => {
    const agentResult = await client.query<{
      id: string;
      org_id: string;
      guild_id: string;
      name: string;
    }>(`SELECT id, org_id, guild_id, name FROM agents WHERE id = $1`, [agentId]);
    const agent = agentResult.rows[0] ?? null;
    if (!agent) {
      throw new RowMissing("agent script upsert failed");
    }
    const payload = parameters === null ? null : JSON.stringify(parameters);
    const existing = await client.query<{ id: string; deleted_at: string | null }>(
      `SELECT id, deleted_at FROM artifacts
        WHERE agent_id = $1 AND kind = 'script' AND path = 'scripts' AND key = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [agentId, name],
    );
    const previous = existing.rows[0];
    const liveId = previous?.id;
    const result = liveId
      ? await client.query<ScriptQueryRow>(
          `UPDATE artifacts
              SET title = $2, content_text = $3, content_json = $4::jsonb,
                  search_text = $5, content_hash = $6, version = version + 1,
                  deleted_at = NULL, updated_at = $7,
                  updated_by_type = $8, updated_by_id = $9, updated_by_name = $10
            WHERE id = $1
            RETURNING ${SCRIPT_RETURNING}`,
          [
            liveId,
            description,
            source,
            payload,
            description.slice(0, 400),
            sourceHash,
            stamp(now),
            actor.actorType,
            actor.actorId,
            actor.actorName,
          ],
        )
      : await client.query<ScriptQueryRow>(
          `INSERT INTO artifacts (
             id, org_id, level, owner_id, guild_id, agent_id, origin_guild_id, kind,
             collection_id, path, key, title, content_text, content_json, search_text,
             content_hash, version,
             created_by_type, created_by_id, created_by_name,
             updated_by_type, updated_by_id, updated_by_name, created_at, updated_at
           ) VALUES (
             $1,$2,'agent',$3,$4,$3,$4,'script',NULL,'scripts',$5,$6,$7,$8::jsonb,$9,$10,1,
             $11,$12,$13,$11,$12,$13,$14,$14
           )
           RETURNING ${SCRIPT_RETURNING}`,
          [
            scriptId,
            agent.org_id,
            agentId,
            agent.guild_id,
            name,
            description,
            source,
            payload,
            description.slice(0, 400),
            sourceHash,
            actor.actorType,
            actor.actorId,
            actor.actorName,
            stamp(now),
          ],
        );
    const row = result.rows[0] ?? null;
    if (!row) {
      throw new RowMissing("agent script upsert failed");
    }
    return {
      script: scriptArtifactRow(row),
      orgId: agent.org_id,
      version: row.version,
      created: !liveId || Boolean(previous?.deleted_at),
    };
  });
}

export async function listAgentScripts(
  pool: Queryable,
  agentId: string,
): Promise<AgentScriptRow[]> {
  const result = await pool.query<ScriptQueryRow>(
    `SELECT ${SCRIPT_RETURNING}
       FROM artifacts
      WHERE agent_id = $1 AND kind = 'script' AND path = 'scripts' AND deleted_at IS NULL
      ORDER BY key`,
    [agentId],
  );
  return result.rows.map(scriptArtifactRow);
}

export async function getAgentScript(
  pool: Queryable,
  agentId: string,
  name: string,
): Promise<AgentScriptRow | null> {
  const result = await pool.query<ScriptQueryRow>(
    `SELECT ${SCRIPT_RETURNING}
       FROM artifacts
      WHERE agent_id = $1 AND kind = 'script' AND path = 'scripts' AND key = $2
        AND deleted_at IS NULL
      LIMIT 1`,
    [agentId, name],
  );
  const row = result.rows[0] ?? null;
  return row ? scriptArtifactRow(row) : null;
}

/** Deletes an agent's script by name, stamped with the time of the delete; null when it has none such. */
export async function deleteAgentScript(
  pool: Queryable,
  actor: ChangeActor,
  agentId: string,
  name: string,
): Promise<Omit<WrittenAgentScript, "created"> | null> {
  const now = new Date();
  const result = await pool.query<ScriptQueryRow>(
    `UPDATE artifacts
        SET deleted_at = $3, updated_at = $3, updated_by_type = $4,
            updated_by_id = $5, updated_by_name = $6
      WHERE agent_id = $1 AND kind = 'script' AND path = 'scripts' AND key = $2
        AND deleted_at IS NULL
      RETURNING ${SCRIPT_RETURNING}`,
    [agentId, name, stamp(now), actor.actorType, actor.actorId, actor.actorName],
  );
  const row = result.rows[0] ?? null;
  return row ? { script: scriptArtifactRow(row), orgId: row.org_id, version: row.version } : null;
}
