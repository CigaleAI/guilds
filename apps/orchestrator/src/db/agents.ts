import type { InferSelectModel } from "drizzle-orm";
import type pg from "pg";
import {
  FALLBACK_TASK,
  FALLBACK_TASK_HASH,
  hashTaskContent,
  taskDisplayPath,
  type AgentTaskRow,
} from "../agents/task.js";
import { ArtifactError } from "../artifacts/errors.js";
import { recordFileChange } from "../artifacts/file-changes.js";
import { displayPathFor } from "../artifacts/paths.js";
import { TASK_REVISIONS_MAX, WRITE_MAX_BYTES, type ArtifactActor } from "../artifacts/types.js";
import { newId } from "../lib/ids.js";
import { GuildNameTaken, RowMissing } from "./errors.js";
import { guildOperatorsColumn, type GuildOperatorRow } from "./guilds.js";
import { freeSlot, placementMachine } from "./machines.js";
import { type Queryable, stamp, withTransaction } from "./pg.js";
import { agents, guilds, machines, orgs, taskRevisions } from "./schema/index.js";

type Agent = InferSelectModel<typeof agents>;
type Machine = InferSelectModel<typeof machines>;
type Guild = InferSelectModel<typeof guilds>;

export type AgentSummaryRow = Pick<Agent, "id" | "guild_id" | "name" | "avatar_shape" | "avatar_color">;

export type GuildAgentRow = AgentSummaryRow &
  Pick<
    Agent,
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
  Pick<Agent, "workspace_mib" | "harness_logins" | "org_id"> & {
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
  config: Record<string, unknown>;
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
    `SELECT a.id, a.guild_id, a.name, a.focus, a.wake_triggers, a.avatar_shape, a.avatar_color, a.config,
            a.created_at, a.updated_at, a.task, a.task_version, a.task_hash, a.task_updated_at,
            a.machine_id, a.machine_slot, m.name AS machine_name, m.box AS machine_box
     FROM agents a JOIN machines m ON m.id = a.machine_id
     WHERE a.guild_id = $1 ORDER BY a.created_at`,
    [guildId],
  );
  return result.rows;
}

export async function insertAgent(
  pool: Queryable,
  agent: NewAgent,
  now: Date,
  actor?: ArtifactActor,
  placement: AgentPlacement = {},
): Promise<void> {
  const focus = agent.focus ?? "";
  const wakeTriggers = agent.wakeTriggers ?? "";
  const avatarShape = agent.avatarShape ?? "teardrop";
  const avatarColor = agent.avatarColor ?? "#7c5cff";
  const task = agent.task ?? FALLBACK_TASK;
  const taskHash = agent.taskHash ?? FALLBACK_TASK_HASH;
  await withTransaction(pool, async (client) => {
    const clash = await client.query(
      `SELECT 1 FROM guild_operators go JOIN users u ON u.id = go.user_id
       WHERE go.guild_id = $1 AND u.name = $2`,
      [agent.guildId, agent.name],
    );
    if (clash.rowCount) {
      throw new GuildNameTaken(agent.name, "operator");
    }
    const guild =
      (
        await client.query<{ org_id: string }>(`SELECT org_id FROM guilds WHERE id = $1`, [
          agent.guildId,
        ])
      ).rows[0] ?? null;
    if (!guild) {
      throw new RowMissing("agent insert failed: guild not found");
    }
    const machine = await placementMachine(client, guild.org_id, placement.machineId, {
      browser: agent.config.browser === true,
      coding: agent.config.coding === true,
    });
    const slot = await freeSlot(client, machine, placement.maxAgentsPerMachine ?? undefined);
    const result = await client.query<{ org_id: string; task_version: number }>(
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
        focus,
        avatarShape,
        avatarColor,
        task,
        taskHash,
        wakeTriggers,
        machine.id,
        slot,
      ],
    );
    const inserted = result.rows[0] ?? null;
    if (actor && inserted) {
      await recordFileChange(client, actor, {
        orgId: inserted.org_id,
        taskAgentId: agent.agentId,
        displayPath: taskDisplayPath(inserted.org_id, agent.agentId),
        operation: "create",
        version: inserted.task_version,
        createdAt: now,
      });
    }
  });
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
  harness: string,
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
  harness: string,
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

/** Writes the agent's task inside the transaction `tx` runs. */
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
  const lockedResult = await tx.query<AgentTaskRow>(
    `SELECT org_id, id AS agent_id, task AS content_text, task_version AS version,
            task_hash AS content_hash, task_updated_at AS updated_at
       FROM agents
      WHERE org_id = $1 AND id = $2
      FOR UPDATE`,
    [actor.orgId, agentId],
  );
  const locked = lockedResult.rows[0] ?? null;
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
  if (locked.content_text) {
    await tx.query(
      `INSERT INTO task_revisions (
         id, org_id, agent_id, version, content_text, replaced_at,
         replaced_by_type, replaced_by_id, replaced_by_name, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $6)`,
      [
        newId("trev"),
        locked.org_id,
        agentId,
        locked.version,
        locked.content_text,
        stamp(new Date()),
        actor.actorType,
        actor.actorId,
        actor.actorName,
      ],
    );
    await tx.query(
      `DELETE FROM task_revisions
        WHERE id IN (
          SELECT id FROM task_revisions
           WHERE org_id = $1 AND agent_id = $2
           ORDER BY version DESC
          OFFSET $3
        )`,
      [locked.org_id, agentId, TASK_REVISIONS_MAX],
    );
  }
  const result = await tx.query<AgentTaskRow>(
    `UPDATE agents
        SET task = $2, task_hash = $3, task_version = task_version + 1, task_updated_at = $4
      WHERE id = $1 AND org_id = $5 AND task_version = $6
      RETURNING org_id, id AS agent_id, task AS content_text, task_version AS version,
                task_hash AS content_hash, task_updated_at AS updated_at`,
    [agentId, content, hash, stamp(new Date()), actor.orgId, locked.version],
  );
  const task = result.rows[0] ?? null;
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
  config: Record<string, unknown>,
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

export async function upsertAgentScript(
  pool: Queryable,
  script: NewAgentScript,
  actor: ArtifactActor,
  now: Date,
): Promise<AgentScriptRow> {
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
    await recordFileChange(client, actor, {
      orgId: agent.org_id,
      artifactId: row.id,
      displayPath: displayPathFor({
        orgId: agent.org_id,
        level: "agent",
        ownerId: agentId,
        kind: "script",
        path: "scripts",
        key: name,
      }),
      operation: liveId && !previous?.deleted_at ? "update" : "create",
      version: row.version,
      createdAt: now,
    });
    return scriptArtifactRow(row);
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

export async function deleteAgentScript(
  pool: Queryable,
  actor: ArtifactActor,
  agentId: string,
  name: string,
): Promise<AgentScriptRow | null> {
  return withTransaction(pool, async (client) => {
    const now = new Date();
    const result = await client.query<ScriptQueryRow>(
      `UPDATE artifacts
          SET deleted_at = $3, updated_at = $3, updated_by_type = $4,
              updated_by_id = $5, updated_by_name = $6
        WHERE agent_id = $1 AND kind = 'script' AND path = 'scripts' AND key = $2
          AND deleted_at IS NULL
        RETURNING ${SCRIPT_RETURNING}`,
      [agentId, name, stamp(now), actor.actorType, actor.actorId, actor.actorName],
    );
    const row = result.rows[0] ?? null;
    if (!row) {
      return null;
    }
    await recordFileChange(client, actor, {
      orgId: row.org_id,
      artifactId: row.id,
      displayPath: displayPathFor({
        orgId: row.org_id,
        level: "agent",
        ownerId: agentId,
        kind: "script",
        path: "scripts",
        key: name,
      }),
      operation: "delete",
      version: row.version,
      createdAt: now,
    });
    return scriptArtifactRow(row);
  });
}
