import type pg from "pg";
import { ownerRefs } from "../credentials/validate.js";
import { newId } from "../lib/ids.js";
import { GLOBAL_SCOPE, GLOBAL_SCOPE_ID, messageCostUsd, usageDelta, utcMonth } from "../usage.js";
import {
  AgentMessageLimitReached,
  GuildInactive,
  GuildNameTaken,
  LastGuildAdmin,
  SecretNameTaken,
} from "./errors.js";
import { jsonObj } from "./json.js";
import { SEED_USERS } from "../users/index.js";
import { firstRow, isUniqueViolation, stamp, withTransaction } from "./pg.js";
import { maxWorkspaceMibOf } from "../agents/validation.js";
import { DEFAULT_AGENT_MESSAGE_LIMIT, DEFAULT_GUILD_AGENTS } from "../guilds/validation.js";
import { loadConnector } from "../connectors/load.js";
import { ArtifactError } from "../artifacts/errors.js";
import { recordFileChange } from "../artifacts/file-changes.js";
import { displayPathFor } from "../artifacts/paths.js";
import type { ArtifactActor } from "../artifacts/types.js";
import { TASK_REVISIONS_MAX, WRITE_MAX_BYTES } from "../artifacts/types.js";
import {
  FALLBACK_TASK,
  FALLBACK_TASK_HASH,
  hashTaskContent,
  taskDisplayPath,
  type AgentTaskRow,
} from "../agents/task.js";
import {
  DEFAULT_MACHINE_BOX,
  DEFAULT_MACHINE_MAX_WORKSPACE_MIB,
  DEFAULT_MACHINE_NAME,
  lowestFreeSlot,
  MachineError,
  agentMinimum,
  agentsMinimum,
  belowMinimumMessage,
  machineFromRow,
  machineSize,
  sizeLabel,
  sizeMeets,
  type AgentNeeds,
  type MachineAgent,
  type MachineInput,
  type MachineRow,
  type MachineWithAgents,
} from "../machines/index.js";
import type { HeldCap } from "../policy/index.js";
import type { ScheduleTiming } from "../schedules/timing.js";
import type { PlannedWake } from "../schedules/window.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

const MACHINE_COLUMNS =
  "id, org_id, name, box, cpu, memory_mib, max_workspace_mib, workspace_mib, harnesses, created_at, updated_at";

/** The machine every organisation starts with, created in the transaction that creates it. */
export async function insertDefaultMachine(client: Queryable, orgId: string, now: Date): Promise<string> {
  const machineId = newId("mach");
  await client.query(
    `INSERT INTO machines (id, org_id, name, box, max_workspace_mib, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [machineId, orgId, DEFAULT_MACHINE_NAME, DEFAULT_MACHINE_BOX, DEFAULT_MACHINE_MAX_WORKSPACE_MIB, stamp(now)],
  );
  return machineId;
}

/**
 * The machine an agent goes on, locked with the organisation's other machines: the one named, or
 * the organisation's only machine when none is. Refuses a machine below the agent's minimum.
 */
async function placementMachine(
  client: Queryable,
  orgId: string,
  machineId: string | null | undefined,
  needs: AgentNeeds,
): Promise<MachineRow> {
  const rows = (
    await client.query(
      `SELECT ${MACHINE_COLUMNS} FROM machines WHERE org_id = $1 ORDER BY created_at, name FOR UPDATE`,
      [orgId],
    )
  ).rows as Array<Record<string, unknown>>;
  let row: Record<string, unknown> | undefined;
  if (machineId) {
    row = rows.find((item) => item.id === machineId);
    if (!row) {
      throw new MachineError(422, "machine_id names no machine of this organisation");
    }
  } else if (rows.length === 1) {
    row = rows[0];
  } else {
    throw new MachineError(
      422,
      rows.length ? "machine_id is required: the organisation has more than one machine" : "the organisation has no machine",
    );
  }
  const machine = machineFromRow(row!);
  if (!sizeMeets(machineSize(machine), agentMinimum(needs))) {
    throw new MachineError(
      422,
      `${belowMinimumMessage(needsLabel(needs), needs, machine)}. Pick a larger machine, or resize ${machine.name} under Settings, Machines`,
    );
  }
  return machine;
}

/** What an agent with these needs is called in a refusal. */
function needsLabel(needs: AgentNeeds): string {
  if (needs.coding) {
    return "a coding agent";
  }
  return needs.browser ? "a browser agent" : "an agent";
}

/** The lowest slot free on a machine, under `ceiling` agents; a full machine is refused. */
async function freeSlot(client: Queryable, machine: MachineRow, ceiling: number | undefined): Promise<number> {
  const taken = (
    await client.query(`SELECT machine_slot FROM agents WHERE machine_id = $1`, [machine.id])
  ).rows.map((row) => Number((row as { machine_slot: unknown }).machine_slot));
  const slot = lowestFreeSlot(taken, ceiling);
  if (slot === null) {
    throw new MachineError(409, `machine ${machine.name} is full`);
  }
  return slot;
}

/** One machine of the organisation, locked for the rest of the transaction; null when it has none such. */
async function lockMachine(client: Queryable, orgId: string, machineId: string): Promise<MachineRow | null> {
  const row = firstRow(
    await client.query(`SELECT ${MACHINE_COLUMNS} FROM machines WHERE org_id = $1 AND id = $2 FOR UPDATE`, [
      orgId,
      machineId,
    ]),
  );
  return row ? machineFromRow(row) : null;
}

const MACHINES_WITH_AGENTS = `
  SELECT m.id, m.org_id, m.name, m.box, m.cpu, m.memory_mib, m.max_workspace_mib, m.workspace_mib, m.harnesses,
         (SELECT COALESCE(
                   jsonb_agg(jsonb_build_object(
                               'id', a.id, 'name', a.name, 'guild_id', a.guild_id, 'guild_name', g.name,
                               'slot', a.machine_slot,
                               'browser', COALESCE((a.config->>'browser')::boolean, FALSE),
                               'coding', COALESCE((a.config->>'coding')::boolean, FALSE),
                               'max_workspace_mib', a.config->'max_workspace_mib')
                             ORDER BY a.machine_slot),
                   '[]'::jsonb)
            FROM agents a JOIN guilds g ON g.id = a.guild_id
           WHERE a.machine_id = m.id) AS agents
    FROM machines m`;

function machineWithAgents(row: Record<string, unknown>): MachineWithAgents {
  const agents = (row.agents ?? []) as Array<Record<string, unknown>>;
  return {
    ...machineFromRow(row),
    agents: agents.map((agent) => ({ ...agent, max_workspace_mib: maxWorkspaceMibOf(agent) }) as MachineAgent),
  };
}

const SCRIPT_RETURNING = `
  id, org_id, agent_id, key AS name, title AS description, content_json AS parameters,
  content_text AS source, content_hash AS source_hash, version, created_at, updated_at
`;

// A stored step's text: its string content, or the text parts of a content list.
const STEP_TEXT = `
  CASE jsonb_typeof(payload->'content')
    WHEN 'string' THEN left(payload->>'content', 2000)
    WHEN 'array' THEN left((
      SELECT string_agg(part->>'text', ' ')
      FROM jsonb_array_elements(payload->'content') AS part
      WHERE part->>'type' = 'text'
    ), 2000)
  END
`;

const CONNECTOR_COLUMNS = `
  id, slug, tool_prefix, owner_org_id, manifest, source, version, verified, experimental, publisher, enabled,
  oauth_client, overrides, installed_at, updated_at
`;

const MCP_CONNECTION_COLUMNS = `
  id, mcp_server_id, owner_scope, owner_id, account_hint, status,
  ciphertext, nonce, oauth_state, settings, created_at, updated_at, rotated_at
`;

function scheduleColumns(alias: string): string {
  return [
    "id",
    "agent_id",
    "cron",
    "wake_window",
    "window_fires",
    "description",
    "instruction",
    "paused",
    "next_run_at",
    "last_run_at",
    "created_at",
    "updated_at",
  ]
    .map((column) => (alias ? `${alias}.${column}` : column))
    .join(", ");
}

const SCHEDULE_COLUMNS = scheduleColumns("");

// Operators of guild `p`, oldest first: [{ user_id, name, role }].
function guildOperatorsColumn(alias: string): string {
  return `
  (SELECT COALESCE(
            jsonb_agg(jsonb_build_object('user_id', go.user_id, 'name', u.name, 'role', go.role)
                      ORDER BY go.created_at, u.name),
            '[]'::jsonb)
   FROM guild_operators go JOIN users u ON u.id = go.user_id
   WHERE go.guild_id = p.id) AS ${alias}`;
}

const GUILD_COLUMNS = `
  p.id, p.name, p.about, p.description, p.max_agents, p.git_author_email, p.org_id, p.group_agent_message_limit,
  p.visibility, p.routines_enabled, o.slug AS org_slug, p.created_at, p.updated_at, p.archived_at,
  ${guildOperatorsColumn("operators")}`;

// A secret's metadata with its grants, each grant naming its target and the guild it sits in.
const SECRET_COLUMNS = `
  s.id, s.org_id, s.name, s.description, s.org_wide,
  s.created_by_user_id, cu.name AS created_by_user_name,
  s.created_by_agent_id, ca.name AS created_by_agent_name, ca.guild_id AS created_by_agent_guild_id,
  s.created_at, s.updated_at, s.rotated_at,
  (SELECT COALESCE(
            jsonb_agg(jsonb_build_object(
                        'guild_id', g.guild_id,
                        'agent_id', g.agent_id,
                        'name', COALESCE(gg.name, ga.name),
                        'in_guild_id', COALESCE(g.guild_id, ga.guild_id))
                      ORDER BY g.agent_id IS NOT NULL, COALESCE(gg.name, ga.name)),
            '[]'::jsonb)
   FROM secret_grants g
   LEFT JOIN guilds gg ON gg.id = g.guild_id
   LEFT JOIN agents ga ON ga.id = g.agent_id
   WHERE g.secret_id = s.id) AS grants`;

const SECRET_FROM = `secrets s
  LEFT JOIN users cu ON cu.id = s.created_by_user_id
  LEFT JOIN agents ca ON ca.id = s.created_by_agent_id`;

async function insertSecretGrants(
  client: pg.PoolClient,
  secretId: string,
  access: { org_wide: boolean; guild_ids: string[]; agent_ids: string[] },
  now: Date,
): Promise<void> {
  if (access.org_wide) {
    return;
  }
  await client.query(
    `INSERT INTO secret_grants (secret_id, guild_id, agent_id, created_at)
     SELECT $1, guild_id, NULL, $3 FROM unnest($2::text[]) AS guild_id`,
    [secretId, access.guild_ids, stamp(now)],
  );
  await client.query(
    `INSERT INTO secret_grants (secret_id, guild_id, agent_id, created_at)
     SELECT $1, NULL, agent_id, $3 FROM unnest($2::text[]) AS agent_id`,
    [secretId, access.agent_ids, stamp(now)],
  );
}

function scriptArtifactRow(row: Record<string, unknown>): Record<string, unknown> {
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

function mapAgentTask(row: Record<string, unknown>): AgentTaskRow {
  return {
    org_id: String(row.org_id),
    agent_id: String(row.agent_id),
    content_text: String(row.content_text ?? ""),
    version: Number(row.version),
    content_hash: String(row.content_hash),
    updated_at: String(row.updated_at),
  };
}

/** What an edition does with a new organisation, inside the transaction that creates it. */
export type OrgCreatedHook = (client: pg.PoolClient, org: { id: string }, now: Date) => Promise<void>;

export class Repositories {
  private orgCreated: OrgCreatedHook | undefined;

  constructor(
    public pool: pg.Pool,
    options: { orgCreated?: OrgCreatedHook | undefined } = {},
  ) {
    this.orgCreated = options.orgCreated;
  }

  async listUsers(): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT id, name, email, image, timezone, color, created_at, updated_at FROM users`,
    );
    const seedOrder = new Map(SEED_USERS.map((user, index) => [user.id, index]));
    return [...result.rows].sort((a, b) => {
      const left = seedOrder.get(a.id) ?? SEED_USERS.length;
      const right = seedOrder.get(b.id) ?? SEED_USERS.length;
      if (left !== right) {
        return left - right;
      }
      const created = String(a.created_at).localeCompare(String(b.created_at));
      if (created !== 0) {
        return created;
      }
      return String(a.name).localeCompare(String(b.name));
    }) as Array<Record<string, unknown>>;
  }

  async getUser(userId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT id, name, email, image, timezone, color, created_at, updated_at FROM users WHERE id = $1`,
      [userId],
    );
    return firstRow(result);
  }

  /** Sets the fields given; a field left out keeps its value. */
  async updateUserProfile(
    userId: string,
    profile: { name?: string; timezone?: string | null; color?: string | null },
    now: Date,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `UPDATE users SET
         name = CASE WHEN $2 THEN $3 ELSE name END,
         timezone = CASE WHEN $4 THEN $5 ELSE timezone END,
         color = CASE WHEN $6 THEN $7 ELSE color END,
         updated_at = $8
       WHERE id = $1
       RETURNING id, name, email, image, timezone, color, created_at, updated_at`,
      [
        userId,
        profile.name !== undefined,
        profile.name ?? null,
        "timezone" in profile,
        profile.timezone ?? null,
        "color" in profile,
        profile.color ?? null,
        stamp(now),
      ],
    );
    return firstRow(result);
  }

  /** Sets or clears the email a user is identified by behind an authenticating proxy. */
  async setUserEmail(userId: string, email: string | null, now: Date): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `UPDATE users SET email = $2, updated_at = $3
       WHERE id = $1
       RETURNING id, name, email, image, timezone, color, created_at, updated_at`,
      [userId, email, stamp(now)],
    );
    return firstRow(result);
  }

  /**
   * A user and their personal organisation. `orgCreated` runs for this organisation in place of
   * the repositories' own hook.
   */
  async insertUser(
    userId: string,
    name: string,
    now: Date,
    image: string | null = null,
    email: string | null = null,
    options: { orgCreated?: OrgCreatedHook } = {},
  ): Promise<Record<string, unknown>> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `INSERT INTO users (id, name, image, email, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)
         RETURNING id, name, email, image, timezone, color, created_at, updated_at`,
        [userId, name, image, email, stamp(now)],
      );
      const row = firstRow(result);
      if (!row) {
        throw new Error("user insert failed");
      }
      const orgId = newId("org");
      await client.query(
        `INSERT INTO orgs (id, name, slug, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)`,
        [orgId, name, name, stamp(now)],
      );
      await insertDefaultMachine(client, orgId, now);
      await client.query(
        `INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ($1, $2, 'owner', $3)`,
        [orgId, userId, stamp(now)],
      );
      await (options.orgCreated ?? this.orgCreated)?.(client, { id: orgId }, now);
      return row;
    });
  }

  async deleteUser(userId: string): Promise<Record<string, unknown> | null> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(`DELETE FROM users WHERE id = $1 RETURNING id`, [userId]);
      const row = firstRow(result);
      if (row) {
        await client.query(
          `DELETE FROM orgs o
           WHERE NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = o.id)
             AND NOT EXISTS (SELECT 1 FROM guilds p WHERE p.org_id = o.id)`,
        );
      }
      return row;
    });
  }

  async lastOwnedOrgsWithGuilds(userId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT o.id, o.name
       FROM orgs o
       JOIN org_members m ON m.org_id = o.id AND m.user_id = $1 AND m.role = 'owner'
       WHERE (
         SELECT COUNT(*) FROM org_members o2
         WHERE o2.org_id = o.id AND o2.role = 'owner'
       ) = 1
       AND EXISTS (SELECT 1 FROM guilds p WHERE p.org_id = o.id)`,
      [userId],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async listOrgsForUser(userId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT o.id, o.name, o.slug, o.created_at, o.updated_at, m.role
       FROM org_members m
       JOIN orgs o ON o.id = m.org_id
       WHERE m.user_id = $1
       ORDER BY o.created_at, o.name`,
      [userId],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async listOrgs(): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT id, name, slug, created_at, updated_at
       FROM orgs
       ORDER BY created_at, name`,
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async getMembership(orgId: string, userId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT o.id, o.name, o.slug, o.created_at, o.updated_at, m.role
       FROM org_members m
       JOIN orgs o ON o.id = m.org_id
       WHERE m.org_id = $1 AND m.user_id = $2`,
      [orgId, userId],
    );
    return firstRow(result);
  }

  async insertOrg(
    orgId: string,
    name: string,
    slug: string,
    userId: string,
    now: Date,
  ): Promise<Record<string, unknown>> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `INSERT INTO orgs (id, name, slug, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4)
         RETURNING id, name, slug, created_at, updated_at`,
        [orgId, name, slug, stamp(now)],
      );
      const row = firstRow(result);
      if (!row) {
        throw new Error("org insert failed");
      }
      await insertDefaultMachine(client, orgId, now);
      await client.query(
        `INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ($1, $2, 'owner', $3)`,
        [orgId, userId, stamp(now)],
      );
      await this.orgCreated?.(client, { id: orgId }, now);
      return row;
    });
  }

  async updateOrg(
    orgId: string,
    now: Date,
    options: { name?: string | null; slug?: string | null },
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `UPDATE orgs
       SET name = COALESCE($2, name),
           slug = COALESCE($3, slug),
           updated_at = $4
       WHERE id = $1
       RETURNING id, name, slug, created_at, updated_at`,
      [orgId, options.name ?? null, options.slug ?? null, stamp(now)],
    );
    return firstRow(result);
  }

  async listMembers(orgId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `    SELECT m.user_id, m.role, m.created_at, u.name, u.image, u.email, u.color
       FROM org_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.org_id = $1
       ORDER BY m.created_at, u.name`,
      [orgId],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async insertMember(
    orgId: string,
    userId: string,
    role: string,
    now: Date,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `INSERT INTO org_members (org_id, user_id, role, created_at)
       VALUES ($1, $2, $3, $4)
       RETURNING org_id, user_id, role, created_at`,
      [orgId, userId, role, stamp(now)],
    );
    return firstRow(result);
  }

  async updateMemberRole(
    orgId: string,
    userId: string,
    role: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `UPDATE org_members SET role = $3 WHERE org_id = $1 AND user_id = $2
       RETURNING org_id, user_id, role, created_at`,
      [orgId, userId, role],
    );
    return firstRow(result);
  }

  async deleteMember(orgId: string, userId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `DELETE FROM org_members WHERE org_id = $1 AND user_id = $2 RETURNING org_id, user_id`,
      [orgId, userId],
    );
    return firstRow(result);
  }

  async countOwners(orgId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM org_members WHERE org_id = $1 AND role = 'owner'`,
      [orgId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async listGuilds(orgId: string | null = null): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT ${GUILD_COLUMNS}
       FROM guilds p JOIN orgs o ON o.id = p.org_id
       WHERE $1::text IS NULL OR p.org_id = $1
       ORDER BY p.created_at`,
      [orgId],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async listGuildsForUser(orgId: string, userId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT ${GUILD_COLUMNS}
       FROM guilds p JOIN orgs o ON o.id = p.org_id
       WHERE p.org_id = $1
         AND (p.visibility <> 'private'
              OR EXISTS (SELECT 1 FROM guild_operators go WHERE go.guild_id = p.id AND go.user_id = $2))
       ORDER BY p.created_at`,
      [orgId, userId],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async insertGuild(
    guildId: string,
    name: string,
    now: Date,
    orgId: string,
    about = "",
    agentMessageLimit = DEFAULT_AGENT_MESSAGE_LIMIT,
    visibility = "org",
    creatorUserId: string | null = null,
    description = "",
    maxAgents = DEFAULT_GUILD_AGENTS,
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO guilds (id, name, org_id, created_at, updated_at, about, description, max_agents, group_agent_message_limit, visibility)
         VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9)`,
        [guildId, name, orgId, stamp(now), about, description, maxAgents, agentMessageLimit, visibility],
      );
      if (creatorUserId !== null) {
        await client.query(
          `INSERT INTO guild_operators (org_id, guild_id, user_id, role, created_at)
           VALUES ($1, $2, $3, 'admin', $4)`,
          [orgId, guildId, creatorUserId, stamp(now)],
        );
      }
    });
  }

  async deleteGuild(guildId: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await deleteGuildUsage(client, guildId);
      const now = new Date().toISOString();
      await client.query(
        `UPDATE artifacts SET deleted_at = $2, updated_at = $2
          WHERE deleted_at IS NULL
            AND collection_id IN (SELECT id FROM artifact_collections WHERE guild_id = $1 AND deleted_at IS NULL)`,
        [guildId, now],
      );
      await client.query(
        `UPDATE artifact_collections SET deleted_at = $2, updated_at = $2 WHERE guild_id = $1 AND deleted_at IS NULL`,
        [guildId, now],
      );
      await client.query(
        `DELETE FROM collection_access
          WHERE (subject_type = 'guild' AND subject_id = $1)
             OR (subject_type = 'agent' AND subject_id IN (SELECT id FROM agents WHERE guild_id = $1))`,
        [guildId],
      );
      // A secret whose every grant goes with the guild goes with it.
      await client.query(
        `DELETE FROM secrets s
          WHERE NOT s.org_wide
            AND EXISTS (SELECT 1 FROM secret_grants g WHERE g.secret_id = s.id)
            AND NOT EXISTS (
                  SELECT 1 FROM secret_grants g LEFT JOIN agents a ON a.id = g.agent_id
                   WHERE g.secret_id = s.id AND COALESCE(g.guild_id, a.guild_id) <> $1)`,
        [guildId],
      );
      await client.query(`DELETE FROM guilds WHERE id = $1`, [guildId]);
    });
  }

  async getGuild(guildId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT ${GUILD_COLUMNS}
       FROM guilds p JOIN orgs o ON o.id = p.org_id
       WHERE p.id = $1`,
      [guildId],
    );
    return firstRow(result);
  }

  async updateGuild(
    guildId: string,
    now: Date,
    options: {
      name?: string | null;
      about?: string | null;
      visibility?: string | null;
      routinesEnabled?: boolean | null;
      description?: string | null;
      maxAgents?: number | null;
      gitAuthorEmail?: string | null;
    },
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `UPDATE guilds
       SET about = COALESCE($2, about),
           visibility = COALESCE($3, visibility),
           routines_enabled = COALESCE($5, routines_enabled),
           description = COALESCE($6, description),
           max_agents = COALESCE($7, max_agents),
           git_author_email = COALESCE($8, git_author_email),
           name = COALESCE($9, name),
           updated_at = $4
       WHERE id = $1
       RETURNING id`,
      [
        guildId,
        options.about ?? null,
        options.visibility ?? null,
        stamp(now),
        options.routinesEnabled === undefined || options.routinesEnabled === null
          ? null
          : options.routinesEnabled,
        options.description ?? null,
        options.maxAgents ?? null,
        options.gitAuthorEmail ?? null,
        options.name ?? null,
      ],
    );
    return firstRow(result) ? this.getGuild(guildId) : null;
  }

  // Grants `role` to an organisation member, or removes the operator when
  // `role` is null. The guild keeps at least one admin, and an operator's
  // name stays distinct from its agents' names.
  async setGuildOperator(
    guildId: string,
    userId: string,
    role: "admin" | "operator" | null,
    now: Date,
  ): Promise<Record<string, unknown> | null> {
    const changed = await withTransaction(this.pool, async (client) => {
      const guild = firstRow(await client.query(`SELECT org_id FROM guilds WHERE id = $1 FOR UPDATE`, [guildId]));
      if (!guild) {
        return false;
      }
      if (role === null) {
        await client.query(`DELETE FROM guild_operators WHERE guild_id = $1 AND user_id = $2`, [guildId, userId]);
      } else {
        const clash = firstRow(
          await client.query(
            `SELECT u.name FROM users u JOIN agents a ON a.name = u.name AND a.guild_id = $1
             WHERE u.id = $2`,
            [guildId, userId],
          ),
        );
        if (clash) {
          throw new GuildNameTaken(String(clash.name), "agent");
        }
        await client.query(
          `INSERT INTO guild_operators (org_id, guild_id, user_id, role, created_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (guild_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
          [guild.org_id, guildId, userId, role, stamp(now)],
        );
      }
      const admins = firstRow(
        await client.query(
          `SELECT COUNT(*)::int AS n FROM guild_operators WHERE guild_id = $1 AND role = 'admin'`,
          [guildId],
        ),
      );
      if (Number(admins?.n ?? 0) < 1) {
        throw new LastGuildAdmin();
      }
      return true;
    });
    return changed ? this.getGuild(guildId) : null;
  }

  // Guilds in which this user is the only admin, optionally within one organisation.
  async soleAdminGuilds(userId: string, orgId: string | null = null): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT p.id, p.name, p.org_id
       FROM guild_operators go
       JOIN guilds p ON p.id = go.guild_id
       WHERE go.user_id = $1
         AND go.role = 'admin'
         AND ($2::text IS NULL OR go.org_id = $2)
         AND NOT EXISTS (
           SELECT 1 FROM guild_operators other
           WHERE other.guild_id = go.guild_id AND other.role = 'admin' AND other.user_id <> go.user_id
         )
       ORDER BY p.name`,
      [userId, orgId],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async listAgents(guildId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT a.id, a.guild_id, a.name, a.focus, a.wake_triggers, a.avatar_shape, a.avatar_color, a.config,
              a.created_at, a.updated_at, a.archived_at, a.task, a.task_version, a.task_hash, a.task_updated_at,
              a.machine_id, a.machine_slot, m.name AS machine_name, m.box AS machine_box
       FROM agents a JOIN machines m ON m.id = a.machine_id
       WHERE a.guild_id = $1 ORDER BY a.created_at`,
      [guildId],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async insertAgent(
    agentId: string,
    guildId: string,
    name: string,
    config: Record<string, unknown>,
    now: Date,
    focus = "",
    wakeTriggers = "",
    avatarShape = "teardrop",
    avatarColor = "#7c5cff",
    task = FALLBACK_TASK,
    taskHash = FALLBACK_TASK_HASH,
    actor?: ArtifactActor,
    placement: { machineId?: string | null; maxAgentsPerMachine?: number | null } = {},
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const clash = await client.query(
        `SELECT 1 FROM guild_operators go JOIN users u ON u.id = go.user_id
         WHERE go.guild_id = $1 AND u.name = $2`,
        [guildId, name],
      );
      if (clash.rowCount) {
        throw new GuildNameTaken(name, "operator");
      }
      const guild = firstRow(await client.query(`SELECT org_id FROM guilds WHERE id = $1`, [guildId]));
      if (!guild) {
        throw new Error("agent insert failed: guild not found");
      }
      const machine = await placementMachine(client, String(guild.org_id), placement.machineId, {
        browser: config.browser === true,
        coding: config.coding === true,
      });
      const slot = await freeSlot(client, machine, placement.maxAgentsPerMachine ?? undefined);
      const result = await client.query(
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
          agentId,
          guildId,
          name,
          JSON.stringify(config),
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
      const inserted = firstRow(result);
      if (actor && inserted) {
        await recordFileChange(client, actor, {
          orgId: String(inserted.org_id),
          taskAgentId: agentId,
          displayPath: taskDisplayPath(String(inserted.org_id), agentId),
          operation: "create",
          version: Number(inserted.task_version),
          createdAt: now,
        });
      }
    });
  }

  async deleteAgent(agentId: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query(`DELETE FROM collection_access WHERE subject_type = 'agent' AND subject_id = $1`, [agentId]);
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

  async getAgent(agentId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT
         a.id, a.guild_id, a.name, a.focus, a.wake_triggers, a.avatar_shape, a.avatar_color, a.config,
         a.created_at, a.updated_at, a.archived_at,
         a.task, a.task_version, a.task_hash, a.task_updated_at, a.workspace_mib, a.harness_logins,
         a.machine_id, a.machine_slot, m.name AS machine_name, m.box AS machine_box,
         m.cpu AS machine_cpu, m.memory_mib AS machine_memory_mib,
         m.max_workspace_mib AS machine_max_workspace_mib, m.workspace_mib AS machine_workspace_mib,
         m.harnesses AS machine_harnesses,
         p.name AS guild_name, p.about AS guild_about, p.description AS guild_description,
         p.archived_at AS guild_archived_at, p.org_id AS org_id, o.slug AS org_slug,
         ${guildOperatorsColumn("guild_operators")}
       FROM agents a
       JOIN guilds p ON p.id = a.guild_id
       JOIN orgs o ON o.id = p.org_id
       JOIN machines m ON m.id = a.machine_id
       WHERE a.id = $1`,
      [agentId],
    );
    return firstRow(result);
  }

  async listGuildRepositories(guildId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT r.id, r.guild_id, r.name, r.url, r.default_branch, r.connection_id, r.github_id, r.created_at, r.updated_at,
              c.status AS connection_status, c.account_hint AS connection_account
         FROM guild_repositories r
         LEFT JOIN mcp_connections c ON c.id = r.connection_id
        WHERE r.guild_id = $1
        ORDER BY r.name`,
      [guildId],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async insertGuildRepository(input: {
    id: string;
    guildId: string;
    name: string;
    url: string;
    defaultBranch: string;
    connectionId: string | null;
    githubId: number | null;
    now: Date;
  }): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `INSERT INTO guild_repositories (id, guild_id, name, url, default_branch, connection_id, github_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       RETURNING id, guild_id, name, url, default_branch, connection_id, github_id, created_at, updated_at`,
      [
        input.id,
        input.guildId,
        input.name,
        input.url,
        input.defaultBranch,
        input.connectionId,
        input.githubId,
        stamp(input.now),
      ],
    );
    return result.rows[0] as Record<string, unknown>;
  }

  async deleteGuildRepository(guildId: string, repositoryId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `DELETE FROM guild_repositories WHERE guild_id = $1 AND id = $2
       RETURNING id, guild_id, name, url, default_branch, connection_id, github_id, created_at, updated_at`,
      [guildId, repositoryId],
    );
    return firstRow(result);
  }

  /** The organisation's machines, oldest first, each with the agents on it. */
  async listMachines(orgId: string): Promise<MachineWithAgents[]> {
    const result = await this.pool.query(`${MACHINES_WITH_AGENTS} WHERE m.org_id = $1 ORDER BY m.created_at, m.name`, [
      orgId,
    ]);
    return (result.rows as Array<Record<string, unknown>>).map(machineWithAgents);
  }

  /** One machine of the organisation with the agents on it. */
  async getMachineWithAgents(orgId: string, machineId: string): Promise<MachineWithAgents | null> {
    const row = firstRow(
      await this.pool.query(`${MACHINES_WITH_AGENTS} WHERE m.org_id = $1 AND m.id = $2`, [orgId, machineId]),
    );
    return row ? machineWithAgents(row) : null;
  }

  /**
   * The machine an agent goes on: the one named, or the organisation's only machine when none is.
   * Refuses a machine below the agent's minimum.
   */
  async placementMachine(orgId: string, machineId: string | null | undefined, needs: AgentNeeds): Promise<MachineRow> {
    return placementMachine(this.pool, orgId, machineId, needs);
  }

  async getMachine(orgId: string, machineId: string): Promise<MachineRow | null> {
    const row = firstRow(
      await this.pool.query(`SELECT ${MACHINE_COLUMNS} FROM machines WHERE org_id = $1 AND id = $2`, [orgId, machineId]),
    );
    return row ? machineFromRow(row) : null;
  }

  async countMachineAgents(machineId: string): Promise<number> {
    const result = await this.pool.query(`SELECT COUNT(*)::int AS count FROM agents WHERE machine_id = $1`, [machineId]);
    return Number(result.rows[0]?.count ?? 0);
  }

  /**
   * Adds a machine to the organisation. With a `cap`, the machines are counted under the
   * organisation's lock and a full organisation is refused with the cap's error.
   */
  async insertMachine(orgId: string, input: MachineInput, now: Date, cap: HeldCap | null = null): Promise<MachineRow> {
    try {
      return await withTransaction(this.pool, async (client) => {
        await client.query(`SELECT 1 FROM orgs WHERE id = $1 FOR UPDATE`, [orgId]);
        if (cap !== null) {
          const count = await client.query(`SELECT COUNT(*)::int AS count FROM machines WHERE org_id = $1`, [orgId]);
          if (Number(count.rows[0]?.count ?? 0) >= cap.max) {
            throw cap.refuse();
          }
        }
        const row = firstRow(
          await client.query(
            `INSERT INTO machines (id, org_id, name, box, cpu, memory_mib, max_workspace_mib, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
             RETURNING ${MACHINE_COLUMNS}`,
            [newId("mach"), orgId, input.name, input.box, input.cpu, input.memory_mib, input.max_workspace_mib, stamp(now)],
          ),
        );
        return machineFromRow(row!);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new MachineError(409, `${input.name} is already a machine of this organisation`);
      }
      throw error;
    }
  }

  /**
   * Changes a machine's name, tier, size, or disk cap. A size below the minimum of an agent on the
   * machine is refused. Returns the machine before and after the change.
   */
  async updateMachine(
    orgId: string,
    machineId: string,
    input: MachineInput,
    now: Date,
  ): Promise<{ before: MachineRow; after: MachineRow } | null> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const current = await lockMachine(client, orgId, machineId);
        if (current === null) {
          return null;
        }
        const hosted = (
          await client.query(
            `SELECT COALESCE((config->>'browser')::boolean, FALSE) AS browser,
                    COALESCE((config->>'coding')::boolean, FALSE) AS coding
               FROM agents WHERE machine_id = $1`,
            [machineId],
          )
        ).rows as AgentNeeds[];
        const minimum = agentsMinimum(hosted);
        if (hosted.length && !sizeMeets(machineSize(input), minimum)) {
          throw new MachineError(
            409,
            `this machine's agents need at least ${sizeLabel(minimum)}; move them or turn their browser or coding off first`,
          );
        }
        const row = firstRow(
          await client.query(
            `UPDATE machines
                SET name = $3, box = $4, cpu = $5, memory_mib = $6, max_workspace_mib = $7, updated_at = $8
              WHERE org_id = $1 AND id = $2
              RETURNING ${MACHINE_COLUMNS}`,
            [orgId, machineId, input.name, input.box, input.cpu, input.memory_mib, input.max_workspace_mib, stamp(now)],
          ),
        );
        return { before: current, after: machineFromRow(row!) };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new MachineError(409, `${input.name} is already a machine of this organisation`);
      }
      throw error;
    }
  }

  /**
   * Deletes a machine no agent sits on. One that still hosts agents is refused, and so is the
   * organisation's last machine.
   */
  async deleteMachine(orgId: string, machineId: string): Promise<MachineRow | null> {
    return withTransaction(this.pool, async (client) => {
      await client.query(`SELECT 1 FROM orgs WHERE id = $1 FOR UPDATE`, [orgId]);
      const current = await lockMachine(client, orgId, machineId);
      if (current === null) {
        return null;
      }
      const hosted = await client.query(`SELECT 1 FROM agents WHERE machine_id = $1 LIMIT 1`, [machineId]);
      if (hosted.rowCount) {
        throw new MachineError(409, "agents are on this machine; move or delete them first");
      }
      const others = await client.query(`SELECT 1 FROM machines WHERE org_id = $1 AND id <> $2 LIMIT 1`, [
        orgId,
        machineId,
      ]);
      if (!others.rowCount) {
        throw new MachineError(409, "an organisation keeps at least one machine");
      }
      await client.query(`DELETE FROM machines WHERE id = $1`, [machineId]);
      return current;
    });
  }

  /**
   * Moves an agent to another machine of its organisation, in the lowest free slot there. `needs`
   * is what the agent has on once moved, its saved config's when omitted. Returns where it was and
   * where it is.
   */
  async moveAgent(
    agentId: string,
    machineId: string,
    options: { maxAgentsPerMachine?: number | null; needs?: AgentNeeds } = {},
  ): Promise<{ from: { machineId: string; slot: number }; to: { machineId: string; slot: number } } | null> {
    return withTransaction(this.pool, async (client) => {
      const agent = firstRow(
        await client.query(`SELECT org_id, config, machine_id, machine_slot FROM agents WHERE id = $1 FOR UPDATE`, [
          agentId,
        ]),
      );
      if (!agent) {
        return null;
      }
      const from = { machineId: String(agent.machine_id), slot: Number(agent.machine_slot) };
      if (from.machineId === machineId) {
        return { from, to: from };
      }
      const config = jsonObj(agent.config) as Record<string, unknown>;
      const needs = options.needs ?? { browser: config.browser === true, coding: config.coding === true };
      const machine = await placementMachine(client, String(agent.org_id), machineId, needs);
      const slot = await freeSlot(client, machine, options.maxAgentsPerMachine ?? undefined);
      await client.query(`UPDATE agents SET machine_id = $2, machine_slot = $3 WHERE id = $1`, [agentId, machine.id, slot]);
      return { from, to: { machineId: machine.id, slot } };
    });
  }

  /** The coding harness CLIs the machine's image carries, as its container reported them. */
  async setMachineHarnesses(machineId: string, harnesses: string[]): Promise<void> {
    await this.pool.query(`UPDATE machines SET harnesses = $2 WHERE id = $1`, [machineId, harnesses]);
  }

  async setMachineWorkspaceMib(machineId: string, mib: number): Promise<void> {
    await this.pool.query(`UPDATE machines SET workspace_mib = $2 WHERE id = $1`, [machineId, mib]);
  }

  async listMachineIds(): Promise<string[]> {
    const result = await this.pool.query(`SELECT id FROM machines ORDER BY id`);
    return (result.rows as Array<{ id: string }>).map((row) => row.id);
  }

  /** Every agent with the machine it sits on, for laying out and sweeping their directories. */
  async listMachinePlacements(): Promise<Array<{ machineId: string; agentId: string }>> {
    const result = await this.pool.query(`SELECT machine_id, id FROM agents ORDER BY machine_id, machine_slot`);
    return (result.rows as Array<{ machine_id: string; id: string }>).map((row) => ({
      machineId: row.machine_id,
      agentId: row.id,
    }));
  }

  /** Records when the agent's harness last found a login in its home, and whose it is when known. */
  async markHarnessLogin(agentId: string, harness: string, now: Date, account: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE agents
       SET harness_logins = harness_logins
         || jsonb_build_object($2::text, jsonb_build_object('seen_at', $3::text, 'account', $4::text))
       WHERE id = $1`,
      [agentId, harness, now.toISOString(), account],
    );
  }

  /** Forgets the agent's harness login, once a check found no credential in its home. */
  async clearHarnessLogin(agentId: string, harness: string): Promise<void> {
    await this.pool.query(`UPDATE agents SET harness_logins = harness_logins - $2::text WHERE id = $1`, [
      agentId,
      harness,
    ]);
  }

  async setAgentWorkspaceMib(agentId: string, mib: number): Promise<void> {
    await this.pool.query(`UPDATE agents SET workspace_mib = $2 WHERE id = $1`, [agentId, mib]);
  }

  async getAgentTask(
    orgId: string,
    agentId: string,
    client?: Queryable,
  ): Promise<AgentTaskRow | null> {
    const db = client ?? this.pool;
    const result = await db.query(
      `SELECT org_id, id AS agent_id, task AS content_text, task_version AS version,
              task_hash AS content_hash, task_updated_at AS updated_at
         FROM agents
        WHERE org_id = $1 AND id = $2`,
      [orgId, agentId],
    );
    const row = firstRow(result);
    return row ? mapAgentTask(row) : null;
  }

  async writeAgentTask(
    actor: ArtifactActor,
    agentId: string,
    content: string,
    expectedVersion?: number,
    client?: pg.PoolClient,
  ): Promise<AgentTaskRow> {
    if (!actor.operator) {
      throw new ArtifactError("task is not writable", 422);
    }
    if (Buffer.byteLength(content, "utf8") > WRITE_MAX_BYTES) {
      throw new ArtifactError("write exceeds 256 KB", 422);
    }
    const run = async (tx: Queryable): Promise<AgentTaskRow> => {
      const lockedResult = await tx.query(
        `SELECT org_id, id AS agent_id, task AS content_text, task_version AS version,
                task_hash AS content_hash, task_updated_at AS updated_at
           FROM agents
          WHERE org_id = $1 AND id = $2
          FOR UPDATE`,
        [actor.orgId, agentId],
      );
      const lockedRow = firstRow(lockedResult);
      if (!lockedRow) {
        throw new ArtifactError("task.md not found", 404);
      }
      const locked = mapAgentTask(lockedRow);
      if (expectedVersion !== undefined && Number(locked.version) !== Number(expectedVersion)) {
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
      const result = await tx.query(
        `UPDATE agents
            SET task = $2, task_hash = $3, task_version = task_version + 1, task_updated_at = $4
          WHERE id = $1 AND org_id = $5 AND task_version = $6
          RETURNING org_id, id AS agent_id, task AS content_text, task_version AS version,
                    task_hash AS content_hash, task_updated_at AS updated_at`,
        [agentId, content, hash, stamp(new Date()), actor.orgId, locked.version],
      );
      const row = firstRow(result);
      if (!row) {
        throw new ArtifactError("version conflict", 409);
      }
      const task = mapAgentTask(row);
      await recordFileChange(tx, actor, {
        orgId: task.org_id,
        taskAgentId: task.agent_id,
        displayPath: taskDisplayPath(task.org_id, task.agent_id),
        operation: "update",
        version: task.version,
      });
      return task;
    };
    if (client) {
      return run(client);
    }
    return withTransaction(this.pool, run);
  }

  async listAgentTaskRevisions(
    orgId: string,
    agentId: string,
  ): Promise<
    Array<{ version: number; content: string; replaced_at: string; replaced_by_name: string }>
  > {
    const result = await this.pool.query(
      `SELECT version, content_text, replaced_at, replaced_by_name
         FROM task_revisions
        WHERE org_id = $1 AND agent_id = $2
        ORDER BY version DESC`,
      [orgId, agentId],
    );
    return (result.rows as Array<Record<string, unknown>>).map((row) => ({
      version: Number(row.version),
      content: String(row.content_text),
      replaced_at: String(row.replaced_at),
      replaced_by_name: String(row.replaced_by_name),
    }));
  }

  async updateAgentConfig(
    agentId: string,
    config: Record<string, unknown>,
    now: Date,
    options: {
      name?: string | null;
      avatarShape?: string | null;
      avatarColor?: string | null;
      focus?: string | null;
      wakeTriggers?: string | null;
    } = {},
  ): Promise<Record<string, unknown> | null> {
    const apply = async (client: Queryable) => {
      if (options.name) {
        const agent = firstRow(
          await client.query(`SELECT guild_id FROM agents WHERE id = $1 FOR UPDATE`, [agentId]),
        );
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
      const result = await client.query(
        `UPDATE agents
         SET config = $2::jsonb,
             updated_at = $3,
             avatar_shape = COALESCE($4, avatar_shape),
             avatar_color = COALESCE($5, avatar_color),
             focus = COALESCE($6, focus),
             wake_triggers = COALESCE($7, wake_triggers),
             name = COALESCE($8, name)
         WHERE id = $1
         RETURNING id, guild_id, name, config, created_at, updated_at, archived_at`,
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
      return firstRow(result);
    };
    return options.name ? withTransaction(this.pool, apply) : apply(this.pool);
  }

  async upsertAgentScript(
    actor: ArtifactActor,
    scriptId: string,
    agentId: string,
    name: string,
    description: string,
    parameters: Record<string, unknown> | null,
    source: string,
    sourceHash: string,
    now: Date,
  ): Promise<Record<string, unknown>> {
    return withTransaction(this.pool, async (client) => {
      const agentResult = await client.query(
        `SELECT id, org_id, guild_id, name FROM agents WHERE id = $1`,
        [agentId],
      );
      const agent = firstRow(agentResult);
      if (!agent) {
        throw new Error("agent script upsert failed");
      }
      const payload = parameters === null ? null : JSON.stringify(parameters);
      const existing = await client.query(
        `SELECT id, deleted_at FROM artifacts
          WHERE agent_id = $1 AND kind = 'script' AND path = 'scripts' AND key = $2
          ORDER BY created_at DESC
          LIMIT 1`,
        [agentId, name],
      );
      const previous = existing.rows[0] as { id?: string; deleted_at?: unknown } | undefined;
      const liveId = previous?.id;
      const result = liveId
        ? await client.query(
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
        : await client.query(
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
      const row = firstRow(result);
      if (!row) {
        throw new Error("agent script upsert failed");
      }
      await recordFileChange(client, actor, {
        orgId: String(agent.org_id),
        artifactId: String(row.id),
        displayPath: displayPathFor({
          orgId: String(agent.org_id),
          level: "agent",
          ownerId: agentId,
          kind: "script",
          path: "scripts",
          key: name,
        }),
        operation: liveId && !previous?.deleted_at ? "update" : "create",
        version: Number(row.version),
        createdAt: now,
      });
      return scriptArtifactRow(row);
    });
  }

  async listAgentScripts(agentId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT ${SCRIPT_RETURNING}
         FROM artifacts
        WHERE agent_id = $1 AND kind = 'script' AND path = 'scripts' AND deleted_at IS NULL
        ORDER BY key`,
      [agentId],
    );
    return (result.rows as Array<Record<string, unknown>>).map(scriptArtifactRow);
  }

  async getAgentScript(agentId: string, name: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT ${SCRIPT_RETURNING}
         FROM artifacts
        WHERE agent_id = $1 AND kind = 'script' AND path = 'scripts' AND key = $2
          AND deleted_at IS NULL
        LIMIT 1`,
      [agentId, name],
    );
    const row = firstRow(result);
    return row ? scriptArtifactRow(row) : null;
  }

  async deleteAgentScript(
    actor: ArtifactActor,
    agentId: string,
    name: string,
  ): Promise<Record<string, unknown> | null> {
    return withTransaction(this.pool, async (client) => {
      const now = new Date();
      const result = await client.query(
        `UPDATE artifacts
            SET deleted_at = $3, updated_at = $3, updated_by_type = $4,
                updated_by_id = $5, updated_by_name = $6
          WHERE agent_id = $1 AND kind = 'script' AND path = 'scripts' AND key = $2
            AND deleted_at IS NULL
          RETURNING ${SCRIPT_RETURNING}`,
        [agentId, name, stamp(now), actor.actorType, actor.actorId, actor.actorName],
      );
      const row = firstRow(result);
      if (!row) {
        return null;
      }
      await recordFileChange(client, actor, {
        orgId: String(row.org_id),
        artifactId: String(row.id),
        displayPath: displayPathFor({
          orgId: String(row.org_id),
          level: "agent",
          ownerId: agentId,
          kind: "script",
          path: "scripts",
          key: name,
        }),
        operation: "delete",
        version: Number(row.version),
        createdAt: now,
      });
      return scriptArtifactRow(row);
    });
  }

  async insertSchedule(
    scheduleId: string,
    agentId: string,
    timing: ScheduleTiming,
    description: string,
    instruction: string,
    wake: PlannedWake,
    now: Date,
    options: { paused?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const paused = Boolean(options.paused);
    const result = await this.pool.query(
      `INSERT INTO schedules (
         id, agent_id, cron, wake_window, description, instruction, next_run_at, window_fires,
         paused, created_at, updated_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $10)
       RETURNING ${SCHEDULE_COLUMNS}`,
      [
        scheduleId,
        agentId,
        timing.cron,
        timing.window ? JSON.stringify(timing.window) : null,
        description,
        instruction,
        stamp(wake.at),
        wake.windowFires,
        paused,
        stamp(now),
      ],
    );
    const row = firstRow(result);
    if (!row) {
      throw new Error("schedule insert failed");
    }
    return row;
  }

  async listSchedules(agentId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT ${scheduleColumns("s")},
              g.routines_enabled AS guild_routines_enabled
       FROM schedules s
       JOIN agents a ON a.id = s.agent_id
       JOIN guilds g ON g.id = a.guild_id
       WHERE s.agent_id = $1
       ORDER BY s.created_at`,
      [agentId],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async listSchedulesForGuild(guildId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT ${scheduleColumns("s")},
              a.name AS agent_name, a.avatar_shape, a.avatar_color,
              g.routines_enabled AS guild_routines_enabled
       FROM schedules s
       JOIN agents a ON a.id = s.agent_id
       JOIN guilds g ON g.id = a.guild_id
       WHERE a.guild_id = $1
       ORDER BY a.created_at, s.created_at`,
      [guildId],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async insertIssue(
    issueId: string,
    guildId: string,
    orgId: string,
    agentId: string | null,
    agentName: string,
    runId: string | null,
    kind: string,
    severity: string,
    summary: string,
    detail: string,
    toolName: string | null,
    now: Date,
  ): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `INSERT INTO guild_issues (
         id, guild_id, org_id, agent_id, agent_name, run_id, kind, severity, status,
         summary, detail, tool_name, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9, $10, $11, $12, $12)
       RETURNING id, guild_id, org_id, agent_id, agent_name, run_id, kind, severity, status,
                 summary, detail, tool_name, created_at, updated_at, resolved_at, resolved_by`,
      [
        issueId,
        guildId,
        orgId,
        agentId,
        agentName,
        runId,
        kind,
        severity,
        summary,
        detail,
        toolName,
        stamp(now),
      ],
    );
    const row = firstRow(result);
    if (!row) {
      throw new Error("issue insert failed");
    }
    return row;
  }

  async listIssuesForGuild(
    guildId: string,
    status: string | null,
  ): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT i.id, i.guild_id, i.org_id, i.agent_id, i.agent_name, i.run_id, i.kind,
              i.severity, i.status, i.summary, i.detail, i.tool_name,
              i.created_at, i.updated_at, i.resolved_at, i.resolved_by,
              a.name AS live_agent_name, a.avatar_shape, a.avatar_color
       FROM guild_issues i
       LEFT JOIN agents a ON a.id = i.agent_id
       WHERE i.guild_id = $1
         AND ($2::text IS NULL OR i.status = $2)
       ORDER BY CASE i.status WHEN 'open' THEN 0 ELSE 1 END, i.created_at DESC`,
      [guildId, status],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async getIssue(guildId: string, issueId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT i.id, i.guild_id, i.org_id, i.agent_id, i.agent_name, i.run_id, i.kind,
              i.severity, i.status, i.summary, i.detail, i.tool_name,
              i.created_at, i.updated_at, i.resolved_at, i.resolved_by,
              a.name AS live_agent_name, a.avatar_shape, a.avatar_color
       FROM guild_issues i
       LEFT JOIN agents a ON a.id = i.agent_id
       WHERE i.guild_id = $1 AND i.id = $2`,
      [guildId, issueId],
    );
    return firstRow(result);
  }

  async setIssueStatus(
    guildId: string,
    issueId: string,
    status: string,
    resolvedAt: Date | null,
    resolvedBy: string | null,
    now: Date,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `UPDATE guild_issues
       SET status = $3, resolved_at = $4, resolved_by = $5, updated_at = $6
       WHERE guild_id = $1 AND id = $2
       RETURNING id, guild_id, org_id, agent_id, agent_name, run_id, kind, severity, status,
                 summary, detail, tool_name, created_at, updated_at, resolved_at, resolved_by`,
      [guildId, issueId, status, resolvedAt ? stamp(resolvedAt) : null, resolvedBy, stamp(now)],
    );
    const row = firstRow(result);
    if (row === null) {
      return null;
    }
    const hydrated = await this.getIssue(guildId, issueId);
    return hydrated ?? row;
  }

  async resolveOpenIssues(
    guildId: string,
    resolvedAt: Date,
    resolvedBy: string,
    now: Date,
  ): Promise<number> {
    const result = await this.pool.query(
      `UPDATE guild_issues
       SET status = 'resolved', resolved_at = $2, resolved_by = $3, updated_at = $4
       WHERE guild_id = $1 AND status = 'open'
       RETURNING id`,
      [guildId, stamp(resolvedAt), resolvedBy, stamp(now)],
    );
    return result.rows.length;
  }

  // Open issues in the guilds this user operates, newest first.
  async listInboxIssues(orgId: string, userId: string, limit: number): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT i.id, i.guild_id, i.org_id, i.agent_id, i.agent_name, i.run_id, i.kind,
              i.severity, i.status, i.summary, i.detail, i.tool_name,
              i.created_at, i.updated_at, i.resolved_at, i.resolved_by,
              a.name AS live_agent_name, a.avatar_shape, a.avatar_color, p.name AS guild_name
       FROM guild_issues i
       JOIN guild_operators go ON go.guild_id = i.guild_id AND go.user_id = $2
       JOIN guilds p ON p.id = i.guild_id
       LEFT JOIN agents a ON a.id = i.agent_id
       WHERE i.org_id = $1 AND i.status = 'open'
       ORDER BY i.created_at DESC
       LIMIT $3`,
      [orgId, userId, limit],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  // Public messages tagging this user, in guilds they operate, that are past
  // their read cursor for that guild. Newest first.
  async listInboxMentions(orgId: string, userId: string, limit: number): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT m.id, m.guild_id, m.seq, m.author_type, m.author_name, m.author_agent_id,
              m.content, m.created_at, p.name AS guild_name, a.avatar_shape, a.avatar_color
       FROM guild_operators go
       JOIN guilds p ON p.id = go.guild_id
       JOIN group_messages m ON m.guild_id = go.guild_id
       LEFT JOIN group_chat_reads r ON r.guild_id = go.guild_id AND r.user_id = go.user_id
       LEFT JOIN agents a ON a.id = m.author_agent_id
       WHERE go.org_id = $1
         AND go.user_id = $2
         AND m.seq > COALESCE(r.seen_through_seq, 0)
         AND m.tagged_user_ids @> jsonb_build_array($2::text)
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $3`,
      [orgId, userId, limit],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  // Guilds where this operator has an unread tag. Marks each chat read through
  // its current sequence so those tags leave the inbox.
  async markInboxMentionsRead(orgId: string, userId: string, now: Date): Promise<string[]> {
    const result = await this.pool.query(
      `SELECT DISTINCT p.id AS guild_id, p.group_chat_seq
       FROM guild_operators go
       JOIN guilds p ON p.id = go.guild_id
       JOIN group_messages m ON m.guild_id = go.guild_id
       LEFT JOIN group_chat_reads r ON r.guild_id = go.guild_id AND r.user_id = go.user_id
       WHERE go.org_id = $1
         AND go.user_id = $2
         AND m.seq > COALESCE(r.seen_through_seq, 0)
         AND m.tagged_user_ids @> jsonb_build_array($2::text)`,
      [orgId, userId],
    );
    const guildIds: string[] = [];
    for (const row of result.rows) {
      const guildId = String(row.guild_id);
      await this.markGroupChatSeen(guildId, userId, Number(row.group_chat_seq), now);
      guildIds.push(guildId);
    }
    return guildIds;
  }

  async countOpenIssues(guildId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM guild_issues WHERE guild_id = $1 AND status = 'open'`,
      [guildId],
    );
    return Number(firstRow(result)?.n ?? 0);
  }

  async deleteSchedule(agentId: string, scheduleId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `DELETE FROM schedules WHERE id = $1 AND agent_id = $2
       RETURNING ${SCHEDULE_COLUMNS}`,
      [scheduleId, agentId],
    );
    return firstRow(result);
  }

  async getSchedule(agentId: string, scheduleId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT ${SCHEDULE_COLUMNS}
       FROM schedules WHERE id = $1 AND agent_id = $2`,
      [scheduleId, agentId],
    );
    return firstRow(result);
  }

  async setSchedulePaused(
    agentId: string,
    scheduleId: string,
    paused: boolean,
    wake: PlannedWake | null,
    now: Date,
  ): Promise<Record<string, unknown> | null> {
    if (paused || wake === null) {
      const result = await this.pool.query(
        `UPDATE schedules SET paused = true, updated_at = $3
         WHERE id = $1 AND agent_id = $2
         RETURNING ${SCHEDULE_COLUMNS}`,
        [scheduleId, agentId, stamp(now)],
      );
      return firstRow(result);
    }
    const result = await this.pool.query(
      `UPDATE schedules SET paused = false, next_run_at = $3, window_fires = $4, updated_at = $5
       WHERE id = $1 AND agent_id = $2
       RETURNING ${SCHEDULE_COLUMNS}`,
      [scheduleId, agentId, stamp(wake.at), wake.windowFires, stamp(now)],
    );
    return firstRow(result);
  }

  async setScheduleNextRun(scheduleId: string, wake: PlannedWake, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE schedules SET next_run_at = $2, window_fires = $3, updated_at = $4
       WHERE id = $1 AND paused = false`,
      [scheduleId, stamp(wake.at), wake.windowFires, stamp(now)],
    );
  }

  async listBindingsCovering(options: {
    orgId?: string | null;
    guildId?: string | null;
    agentId?: string | null;
  }): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT id, catalog_kind, catalog_id, scope, scope_id, enabled,
              connection_id, created_at, updated_at
       FROM bindings
       WHERE scope = 'platform'
          OR (scope = 'org' AND scope_id = $1)
          OR (scope = 'guild' AND scope_id = $2)
          OR (scope = 'agent' AND scope_id = $3)
       ORDER BY created_at`,
      [options.orgId ?? null, options.guildId ?? null, options.agentId ?? null],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  /**
   * The connectors an organisation sees, loaded with their overrides, by slug: the platform's,
   * and with `orgId` that organisation's own. Without one, the platform's alone.
   */
  async listMcpServers(orgId: string | null = null): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT ${CONNECTOR_COLUMNS}
       FROM connectors
       WHERE owner_org_id IS NULL OR owner_org_id = $1
       ORDER BY slug`,
      [orgId],
    );
    return result.rows.map((row) => loadConnector(row as Record<string, unknown>));
  }

  async listMcpConnections(options: {
    orgId?: string | null;
    guildId?: string | null;
    agentId?: string | null;
  }): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT id, mcp_server_id, owner_scope, owner_id, guild_id, agent_id,
              account_hint, status, ciphertext, nonce, oauth_state, org_id,
              settings, created_at, updated_at, rotated_at
       FROM mcp_connections
       WHERE owner_scope = 'platform'
          OR (owner_scope = 'org' AND owner_id = $1)
          OR (owner_scope = 'guild' AND owner_id = $2)
          OR (owner_scope = 'agent' AND owner_id = $3)
       ORDER BY created_at`,
      [options.orgId ?? null, options.guildId ?? null, options.agentId ?? null],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async listSecrets(
    orgId: string,
    options: { guildId?: string | null; agentId?: string | null } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT ${SECRET_COLUMNS}
       FROM ${SECRET_FROM}
       WHERE s.org_id = $1
         AND ($2::text IS NULL OR s.org_wide OR EXISTS (
               SELECT 1 FROM secret_grants g LEFT JOIN agents a ON a.id = g.agent_id
               WHERE g.secret_id = s.id AND (g.guild_id = $2 OR a.guild_id = $2)))
         AND ($3::text IS NULL OR s.org_wide OR EXISTS (
               SELECT 1 FROM secret_grants g
               WHERE g.secret_id = s.id
                 AND (g.agent_id = $3 OR g.guild_id = (SELECT guild_id FROM agents WHERE id = $3))))
       ORDER BY s.name`,
      [orgId, options.guildId ?? null, options.agentId ?? null],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  /** The agent's environment: organisation-wide secrets, its guild's grants, and its own. */
  async listAgentSecrets(options: {
    orgId: string;
    guildId: string;
    agentId: string;
  }): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT s.id, s.name, s.description
       FROM secrets s
       WHERE s.org_id = $1
         AND (s.org_wide
           OR EXISTS (
             SELECT 1 FROM secret_grants g
             WHERE g.secret_id = s.id
               AND (g.guild_id = $2 OR g.agent_id = $3)))
       ORDER BY s.name`,
      [options.orgId, options.guildId, options.agentId],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async getSecret(secretId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT ${SECRET_COLUMNS}, s.ciphertext, s.nonce
       FROM ${SECRET_FROM}
       WHERE s.id = $1`,
      [secretId],
    );
    return firstRow(result);
  }

  async getSecretByName(orgId: string, name: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT ${SECRET_COLUMNS}
       FROM ${SECRET_FROM}
       WHERE s.org_id = $1 AND s.name = $2`,
      [orgId, name],
    );
    return firstRow(result);
  }

  async insertSecret(input: {
    secretId: string;
    orgId: string;
    name: string;
    description: string;
    access: { org_wide: boolean; guild_ids: string[]; agent_ids: string[] };
    ciphertext: Buffer;
    nonce: Buffer;
    createdByUserId?: string | null;
    createdByAgentId?: string | null;
    now: Date;
  }): Promise<Record<string, unknown>> {
    try {
      return await withTransaction(this.pool, async (client) => {
        await client.query(
          `INSERT INTO secrets (
             id, org_id, name, description, org_wide, ciphertext, nonce,
             created_by_user_id, created_by_agent_id, created_at, updated_at, rotated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $10)`,
          [
            input.secretId,
            input.orgId,
            input.name,
            input.description,
            input.access.org_wide,
            input.ciphertext,
            input.nonce,
            input.createdByUserId ?? null,
            input.createdByAgentId ?? null,
            stamp(input.now),
          ],
        );
        await insertSecretGrants(client, input.secretId, input.access, input.now);
        const row = firstRow(
          await client.query(`SELECT ${SECRET_COLUMNS} FROM ${SECRET_FROM} WHERE s.id = $1`, [input.secretId]),
        );
        if (!row) {
          throw new Error("secret insert failed");
        }
        return row;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new SecretNameTaken(input.name);
      }
      throw error;
    }
  }

  async updateSecret(
    secretId: string,
    changes: { name?: string | null; description?: string | null; ciphertext?: Buffer | null; nonce?: Buffer | null },
    now: Date,
  ): Promise<Record<string, unknown> | null> {
    const rotate = changes.ciphertext !== undefined && changes.ciphertext !== null;
    try {
      const result = await this.pool.query(
        `UPDATE secrets
         SET name = COALESCE($2, name),
             description = COALESCE($3, description),
             ciphertext = COALESCE($4, ciphertext),
             nonce = COALESCE($5, nonce),
             updated_at = $6,
             rotated_at = CASE WHEN $7 THEN $6 ELSE rotated_at END
         WHERE id = $1
         RETURNING id`,
        [
          secretId,
          changes.name ?? null,
          changes.description ?? null,
          rotate ? changes.ciphertext : null,
          rotate ? (changes.nonce ?? null) : null,
          stamp(now),
          rotate,
        ],
      );
      if (!result.rowCount) {
        return null;
      }
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new SecretNameTaken(String(changes.name ?? ""));
      }
      throw error;
    }
    return this.getSecret(secretId);
  }

  /** Replaces who gets the secret; organisation-wide drops every grant. */
  async setSecretAccess(
    secretId: string,
    access: { org_wide: boolean; guild_ids: string[]; agent_ids: string[] },
    now: Date,
  ): Promise<Record<string, unknown> | null> {
    const found = await withTransaction(this.pool, async (client) => {
      const updated = await client.query(
        `UPDATE secrets SET org_wide = $2, updated_at = $3 WHERE id = $1 RETURNING id`,
        [secretId, access.org_wide, stamp(now)],
      );
      if (!updated.rowCount) {
        return false;
      }
      await client.query(`DELETE FROM secret_grants WHERE secret_id = $1`, [secretId]);
      await insertSecretGrants(client, secretId, access, now);
      return true;
    });
    return found ? this.getSecret(secretId) : null;
  }

  async deleteSecret(secretId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(`DELETE FROM secrets WHERE id = $1 RETURNING id`, [secretId]);
    return firstRow(result);
  }

  async countSecretsCreatedByAgent(agentId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM secrets WHERE created_by_agent_id = $1`,
      [agentId],
    );
    return Number(firstRow(result)?.count ?? 0);
  }

  /** The organisation's guilds and agents among these ids, each agent with its guild. */
  async secretGrantTargets(
    orgId: string,
    guildIds: string[],
    agentIds: string[],
  ): Promise<{ guildIds: Set<string>; agentGuilds: Map<string, string> }> {
    const guilds = await this.pool.query(
      `SELECT id FROM guilds WHERE org_id = $1 AND id = ANY($2::text[])`,
      [orgId, guildIds],
    );
    const agents = await this.pool.query(
      `SELECT id, guild_id FROM agents WHERE org_id = $1 AND id = ANY($2::text[])`,
      [orgId, agentIds],
    );
    return {
      guildIds: new Set(guilds.rows.map((row) => String(row.id))),
      agentGuilds: new Map(agents.rows.map((row) => [String(row.id), String(row.guild_id)])),
    };
  }

  /** Every agent of the organisation that this access reaches. */
  async listAgentIdsReached(
    orgId: string,
    access: { org_wide: boolean; guild_ids: string[]; agent_ids: string[] },
  ): Promise<string[]> {
    const result = await this.pool.query(
      `SELECT id FROM agents
       WHERE org_id = $1 AND ($2 OR guild_id = ANY($3::text[]) OR id = ANY($4::text[]))
       ORDER BY id`,
      [orgId, access.org_wide, access.guild_ids, access.agent_ids],
    );
    return result.rows.map((row) => String(row.id));
  }

  async insertBindingIfAbsent(
    bindingId: string,
    catalogKind: string,
    catalogId: string,
    scope: string,
    scopeId: string | null,
    enabled: boolean,
    now: Date,
  ): Promise<Record<string, unknown>> {
    const existing =
      scope === "platform"
        ? await this.pool.query(
            `SELECT id, catalog_kind, catalog_id, scope, scope_id, enabled,
                    connection_id, created_at, updated_at
             FROM bindings
             WHERE catalog_kind = $1 AND catalog_id = $2 AND scope = 'platform'`,
            [catalogKind, catalogId],
          )
        : await this.pool.query(
            `SELECT id, catalog_kind, catalog_id, scope, scope_id, enabled,
                    connection_id, created_at, updated_at
             FROM bindings
             WHERE catalog_kind = $1 AND catalog_id = $2
               AND scope = $3 AND scope_id = $4`,
            [catalogKind, catalogId, scope, scopeId],
          );
    const found = firstRow(existing);
    if (found) {
      return found;
    }
    const [orgId, guildId, agentId] = ownerRefs(scope, scopeId);
    const inserted = await this.pool.query(
      `INSERT INTO bindings (
         id, catalog_kind, catalog_id, scope, scope_id,
         org_id, guild_id, agent_id, enabled, connection_id,
         created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $10)
       RETURNING id, catalog_kind, catalog_id, scope, scope_id, enabled,
                 connection_id, created_at, updated_at`,
      [bindingId, catalogKind, catalogId, scope, scopeId, orgId, guildId, agentId, enabled, stamp(now)],
    );
    const row = firstRow(inserted);
    if (!row) {
      throw new Error("binding insert failed");
    }
    return row;
  }

  async getBinding(
    catalogKind: string,
    catalogId: string,
    scope: string,
    scopeId: string | null,
  ): Promise<Record<string, unknown> | null> {
    const result =
      scope === "platform"
        ? await this.pool.query(
            `SELECT id, catalog_kind, catalog_id, scope, scope_id, enabled,
                    connection_id, created_at, updated_at
             FROM bindings
             WHERE catalog_kind = $1 AND catalog_id = $2 AND scope = 'platform'`,
            [catalogKind, catalogId],
          )
        : await this.pool.query(
            `SELECT id, catalog_kind, catalog_id, scope, scope_id, enabled,
                    connection_id, created_at, updated_at
             FROM bindings
             WHERE catalog_kind = $1 AND catalog_id = $2
               AND scope = $3 AND scope_id = $4`,
            [catalogKind, catalogId, scope, scopeId],
          );
    return firstRow(result);
  }

  async upsertBinding(
    bindingId: string,
    catalogKind: string,
    catalogId: string,
    scope: string,
    scopeId: string | null,
    enabled: boolean,
    connectionId: string | null,
    now: Date,
  ): Promise<Record<string, unknown>> {
    const existing = await this.pool.query(
      `SELECT id FROM bindings
       WHERE catalog_kind = $1 AND catalog_id = $2
         AND scope = $3 AND scope_id = $4`,
      [catalogKind, catalogId, scope, scopeId],
    );
    const found = firstRow(existing);
    if (found === null) {
      const [orgId, guildId, agentId] = ownerRefs(scope, scopeId);
      const inserted = await this.pool.query(
        `INSERT INTO bindings (
           id, catalog_kind, catalog_id, scope, scope_id,
           org_id, guild_id, agent_id, enabled, connection_id,
           created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
         RETURNING id, catalog_kind, catalog_id, scope, scope_id, enabled,
                   connection_id, created_at, updated_at`,
        [
          bindingId,
          catalogKind,
          catalogId,
          scope,
          scopeId,
          orgId,
          guildId,
          agentId,
          enabled,
          connectionId,
          stamp(now),
        ],
      );
      const row = firstRow(inserted);
      if (!row) {
        throw new Error("binding insert failed");
      }
      return row;
    }
    const updated = await this.pool.query(
      `UPDATE bindings
       SET enabled = $2, connection_id = $3, updated_at = $4
       WHERE id = $1
       RETURNING id, catalog_kind, catalog_id, scope, scope_id, enabled,
                 connection_id, created_at, updated_at`,
      [found.id, enabled, connectionId, stamp(now)],
    );
    const row = firstRow(updated);
    if (!row) {
      throw new Error("binding update failed");
    }
    return row;
  }

  async upsertPlatformBinding(
    bindingId: string,
    catalogKind: string,
    catalogId: string,
    enabled: boolean,
    connectionId: string | null,
    now: Date,
  ): Promise<Record<string, unknown>> {
    const existing = await this.pool.query(
      `SELECT id FROM bindings
       WHERE catalog_kind = $1 AND catalog_id = $2 AND scope = 'platform'`,
      [catalogKind, catalogId],
    );
    const found = firstRow(existing);
    if (found === null) {
      const inserted = await this.pool.query(
        `INSERT INTO bindings (
           id, catalog_kind, catalog_id, scope, scope_id, enabled,
           connection_id, created_at, updated_at
         )
         VALUES ($1, $2, $3, 'platform', NULL, $4, $5, $6, $6)
         RETURNING id, catalog_kind, catalog_id, scope, scope_id, enabled,
                   connection_id, created_at, updated_at`,
        [bindingId, catalogKind, catalogId, enabled, connectionId, stamp(now)],
      );
      const row = firstRow(inserted);
      if (!row) {
        throw new Error("platform binding insert failed");
      }
      return row;
    }
    const updated = await this.pool.query(
      `UPDATE bindings
       SET enabled = $2, connection_id = $3, updated_at = $4
       WHERE id = $1
       RETURNING id, catalog_kind, catalog_id, scope, scope_id, enabled,
                 connection_id, created_at, updated_at`,
      [found.id, enabled, connectionId, stamp(now)],
    );
    const row = firstRow(updated);
    if (!row) {
      throw new Error("platform binding update failed");
    }
    return row;
  }

  async deleteBinding(
    catalogKind: string,
    catalogId: string,
    scope: string,
    scopeId: string | null,
  ): Promise<Record<string, unknown> | null> {
    const result =
      scope === "platform"
        ? await this.pool.query(
            `DELETE FROM bindings
             WHERE catalog_kind = $1 AND catalog_id = $2 AND scope = 'platform'
             RETURNING id`,
            [catalogKind, catalogId],
          )
        : await this.pool.query(
            `DELETE FROM bindings
             WHERE catalog_kind = $1 AND catalog_id = $2
               AND scope = $3 AND scope_id = $4
             RETURNING id`,
            [catalogKind, catalogId, scope, scopeId],
          );
    return firstRow(result);
  }

  async getMcpServer(serverId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT ${CONNECTOR_COLUMNS}
       FROM connectors
       WHERE id = $1`,
      [serverId],
    );
    const row = firstRow(result);
    return row === null ? null : loadConnector(row);
  }

  async getMcpConnection(connectionId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT ${MCP_CONNECTION_COLUMNS}
       FROM mcp_connections
       WHERE id = $1`,
      [connectionId],
    );
    return firstRow(result);
  }

  /** Connected GitHub logins on this organisation or on guilds the caller can see. */
  async listVisibleGithubConnections(
    serverId: string,
    orgId: string,
    guildIds: string[],
  ): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT ${MCP_CONNECTION_COLUMNS}
       FROM mcp_connections
       WHERE mcp_server_id = $1
         AND status = 'connected'
         AND (
           (owner_scope = 'org' AND owner_id = $2)
           OR (owner_scope = 'guild' AND owner_id = ANY($3::text[]))
           OR (
             owner_scope = 'agent' AND owner_id IN (
               SELECT a.id FROM agents a WHERE a.guild_id = ANY($3::text[])
             )
           )
         )
       ORDER BY created_at`,
      [serverId, orgId, guildIds],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async getMcpConnectionForOwner(
    serverId: string,
    ownerScope: string,
    ownerId: string | null,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT ${MCP_CONNECTION_COLUMNS}
       FROM mcp_connections
       WHERE mcp_server_id = $1 AND owner_scope = $2
         AND (
           ($2 = 'platform' AND owner_id IS NULL)
           OR owner_id = $3
         )`,
      [serverId, ownerScope, ownerId],
    );
    return firstRow(result);
  }

  async listBindingsForConnection(connectionId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT id, catalog_kind, catalog_id, scope, scope_id, enabled,
              connection_id, created_at, updated_at
       FROM bindings
       WHERE connection_id = $1
       ORDER BY created_at`,
      [connectionId],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async connectMcp(
    connectionId: string,
    bindingId: string,
    serverId: string,
    ownerScope: string,
    ownerId: string | null,
    ciphertext: Buffer,
    nonce: Buffer,
    now: Date,
    options: {
      oauthState?: string | null;
      bind?: boolean;
      status?: string;
      accountHint?: string;
      /** The login's settings; a login that replaces one keeps its settings without it. */
      settings?: Record<string, unknown>;
    } = {},
  ): Promise<Record<string, unknown>> {
    const oauthState = options.oauthState ?? null;
    const settings = options.settings === undefined ? null : JSON.stringify(options.settings);
    const bind = options.bind ?? true;
    const status = options.status ?? "pending";
    const accountHint = options.accountHint ?? "";
    const [orgId, guildId, agentId] = ownerRefs(ownerScope, ownerId);
    return withTransaction(this.pool, async (client) => {
      const existing = await client.query(
        `SELECT id FROM mcp_connections
         WHERE mcp_server_id = $1 AND owner_scope = $2
           AND (
             ($2 = 'platform' AND owner_id IS NULL)
             OR owner_id = $3
           )`,
        [serverId, ownerScope, ownerId],
      );
      const existingId = firstRow(existing)?.id;
      let row: Record<string, unknown> | null;
      if (existingId === undefined) {
        const inserted = await client.query(
          `INSERT INTO mcp_connections (
             id, mcp_server_id, owner_scope, owner_id,
             org_id, guild_id, agent_id,
             account_hint, status, ciphertext, nonce, oauth_state,
             created_at, updated_at, rotated_at, settings
           )
           VALUES (
             $1, $2, $3, $4, $5, $6, $7, $13, $12, $8, $9, $11, $10, $10, $10,
             COALESCE($14::jsonb, '{}'::jsonb)
           )
           RETURNING ${MCP_CONNECTION_COLUMNS}`,
          [
            connectionId,
            serverId,
            ownerScope,
            ownerId,
            orgId,
            guildId,
            agentId,
            ciphertext,
            nonce,
            stamp(now),
            oauthState,
            status,
            accountHint,
            settings,
          ],
        );
        row = firstRow(inserted);
      } else {
        const updated = await client.query(
          `UPDATE mcp_connections
           SET ciphertext = $2, nonce = $3, account_hint = $7,
               status = $6, oauth_state = $5, settings = COALESCE($8::jsonb, settings),
               updated_at = $4, rotated_at = $4
           WHERE id = $1
           RETURNING ${MCP_CONNECTION_COLUMNS}`,
          [existingId, ciphertext, nonce, stamp(now), oauthState, status, accountHint, settings],
        );
        row = firstRow(updated);
      }
      if (!row) {
        throw new Error("mcp connection write failed");
      }
      if (bind) {
        await upsertMcpBinding(client, bindingId, serverId, ownerScope, ownerId, String(row.id), now);
      }
      return row;
    });
  }

  async bindMcpConnection(
    bindingId: string,
    serverId: string,
    ownerScope: string,
    ownerId: string | null,
    connectionId: string,
    now: Date,
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await upsertMcpBinding(client, bindingId, serverId, ownerScope, ownerId, connectionId, now);
    });
  }

  async getMcpConnectionByOauthState(oauthState: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT ${MCP_CONNECTION_COLUMNS}
       FROM mcp_connections
       WHERE oauth_state = $1`,
      [oauthState],
    );
    return firstRow(result);
  }

  /** The operator's most recent pending GitHub login, when GitHub's authorize hop omitted `state`. */
  async getPendingGithubConnectionForUser(userId: string, serverId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT ${MCP_CONNECTION_COLUMNS}
       FROM mcp_connections c
       WHERE c.mcp_server_id = $2
         AND c.status = 'pending'
         AND c.oauth_state IS NOT NULL
         AND (
           (c.owner_scope = 'org' AND EXISTS (
              SELECT 1 FROM org_members m
              WHERE m.org_id = c.owner_id AND m.user_id = $1
           ))
           OR
           (c.owner_scope = 'guild' AND EXISTS (
              SELECT 1 FROM org_members m
              JOIN guilds g ON g.id = c.owner_id
              WHERE m.org_id = g.org_id AND m.user_id = $1
           ))
           OR
           (c.owner_scope = 'agent' AND EXISTS (
              SELECT 1 FROM org_members m
              JOIN agents a ON a.id = c.owner_id
              JOIN guilds g ON g.id = a.guild_id
              WHERE m.org_id = g.org_id AND m.user_id = $1
           ))
         )
       ORDER BY c.updated_at DESC
       LIMIT 1`,
      [userId, serverId],
    );
    return firstRow(result);
  }

  async saveMcpConnection(
    connectionId: string,
    options: {
      ciphertext: Buffer;
      nonce: Buffer;
      status: string;
      accountHint: string;
      oauthState: string | null;
      now: Date;
    },
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `UPDATE mcp_connections
       SET ciphertext = $2, nonce = $3, status = $4, account_hint = $5,
           oauth_state = $6, updated_at = $7, rotated_at = $7
       WHERE id = $1
       RETURNING ${MCP_CONNECTION_COLUMNS}`,
      [
        connectionId,
        options.ciphertext,
        options.nonce,
        options.status,
        options.accountHint,
        options.oauthState,
        stamp(options.now),
      ],
    );
    return firstRow(result);
  }

  /**
   * Stores a login's settings. With `connect`, a login that waited for them becomes connected
   * and takes `accountHint` when one is given.
   */
  async updateMcpConnectionSettings(
    connectionId: string,
    settings: Record<string, unknown>,
    now: Date,
    options: { connect?: boolean; accountHint?: string } = {},
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `UPDATE mcp_connections
       SET settings = $2::jsonb,
           status = CASE WHEN $4 THEN 'connected' ELSE status END,
           account_hint = COALESCE(NULLIF($5, ''), account_hint),
           updated_at = $3
       WHERE id = $1
       RETURNING ${MCP_CONNECTION_COLUMNS}`,
      [connectionId, JSON.stringify(settings), stamp(now), options.connect === true, options.accountHint ?? ""],
    );
    return firstRow(result);
  }

  /** Replaces the repositories a GitHub login's coding agents clone, in its settings. */
  async updateMcpConnectionGithubRepositories(
    connectionId: string,
    repositories: unknown,
    now: Date,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `UPDATE mcp_connections
       SET settings = jsonb_set(settings, '{repositories}', $2::jsonb), updated_at = $3
       WHERE id = $1
       RETURNING ${MCP_CONNECTION_COLUMNS}`,
      [connectionId, JSON.stringify(repositories), stamp(now)],
    );
    return firstRow(result);
  }

  /** Replaces the guild_repositories rows that use this GitHub login, leaving anonymous ones. */
  async replaceConnectionGuildRepositories(
    connectionId: string,
    guildId: string,
    repositories: Array<{ id: string; name: string; url: string; defaultBranch: string; githubId: number | null }>,
    now: Date,
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `DELETE FROM guild_repositories
         WHERE guild_id = $2 AND (connection_id = $1 OR name = ANY($3::text[]))`,
        [connectionId, guildId, repositories.map((item) => item.name)],
      );
      for (const repository of repositories) {
        await client.query(
          `INSERT INTO guild_repositories (id, guild_id, name, url, default_branch, connection_id, github_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
          [
            repository.id,
            guildId,
            repository.name,
            repository.url,
            repository.defaultBranch,
            connectionId,
            repository.githubId,
            stamp(now),
          ],
        );
      }
    });
  }

  /**
   * Records GitHub's id and current URL for the repository this login lists under `name`: on
   * the guild repositories that use the login and in the login's own selection.
   */
  async recordGithubRepository(
    connectionId: string,
    name: string,
    repository: { githubId: number; url: string },
    now: Date,
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE guild_repositories SET github_id = $3, url = $4, updated_at = $5
         WHERE connection_id = $1 AND name = $2`,
        [connectionId, name, repository.githubId, repository.url, stamp(now)],
      );
      const current = await client.query(
        "SELECT settings->'repositories' AS repositories FROM mcp_connections WHERE id = $1 FOR UPDATE",
        [connectionId],
      );
      const selected = current.rows[0]?.repositories;
      if (!Array.isArray(selected) || !selected.some((item) => item?.name === name)) {
        return;
      }
      const next = selected.map((item) =>
        item?.name === name ? { ...item, github_id: repository.githubId, url: repository.url } : item,
      );
      await client.query("UPDATE mcp_connections SET settings = jsonb_set(settings, '{repositories}', $2::jsonb) WHERE id = $1", [
        connectionId,
        JSON.stringify(next),
      ]);
    });
  }

  /** Stores the OAuth client a server's `config.oauth_client` carries: the one registered with its authorization server. */
  async updateMcpServerConfig(
    serverId: string,
    config: unknown,
    now: Date,
  ): Promise<Record<string, unknown> | null> {
    const client = (jsonObj(config) as { oauth_client?: unknown } | null)?.oauth_client ?? null;
    const result = await this.pool.query(
      `UPDATE connectors
       SET oauth_client = $2::jsonb, updated_at = $3
       WHERE id = $1
       RETURNING ${CONNECTOR_COLUMNS}`,
      [serverId, client === null ? null : JSON.stringify(client), stamp(now)],
    );
    const row = firstRow(result);
    return row === null ? null : loadConnector(row);
  }

  async deleteMcpConnection(connectionId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(`DELETE FROM mcp_connections WHERE id = $1 RETURNING id`, [connectionId]);
    return firstRow(result);
  }

  async listMcpTools(connectionId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT id, connection_id, mcp_server_id, remote_name, namespaced_name,
              description, input_schema, listed_at, read_only_hint, destructive_hint
       FROM mcp_tools
       WHERE connection_id = $1
       ORDER BY namespaced_name`,
      [connectionId],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async replaceMcpTools(
    connectionId: string,
    tools: Array<{
      remote_name: string;
      namespaced_name: string;
      description: string;
      input_schema: unknown;
      read_only_hint?: boolean | null;
      destructive_hint?: boolean | null;
    }>,
    now: Date,
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const connection = await client.query(`SELECT id, mcp_server_id FROM mcp_connections WHERE id = $1`, [
        connectionId,
      ]);
      const conn = firstRow(connection);
      if (!conn) {
        throw new Error("mcp connection not found");
      }
      await client.query(`DELETE FROM mcp_tools WHERE connection_id = $1`, [connectionId]);
      for (const tool of tools) {
        await client.query(
          `INSERT INTO mcp_tools (
             id, connection_id, mcp_server_id, remote_name, namespaced_name,
             description, input_schema, listed_at, read_only_hint, destructive_hint
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
          [
            newId("tool"),
            connectionId,
            String(conn.mcp_server_id),
            tool.remote_name,
            tool.namespaced_name,
            tool.description,
            JSON.stringify(tool.input_schema),
            stamp(now),
            tool.read_only_hint ?? null,
            tool.destructive_hint ?? null,
          ],
        );
      }
    });
  }

  async listAllAgents(): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT id, guild_id, name, avatar_shape, avatar_color FROM agents ORDER BY created_at`,
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async listUsageCounters(): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT scope, scope_id, input_tokens, output_tokens,
              cache_read_tokens, cost_usd, calls, updated_at
       FROM usage_counters`,
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async getUsage(scope: string, scopeId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT scope, scope_id, input_tokens, output_tokens,
              cache_read_tokens, cost_usd, calls, updated_at
       FROM usage_counters WHERE scope = $1 AND scope_id = $2`,
      [scope, scopeId],
    );
    return firstRow(result);
  }

  async purgeAgent(agentId: string): Promise<void> {
    await this.deleteAgent(agentId);
  }

  async purgeGuild(guildId: string): Promise<void> {
    await this.deleteGuild(guildId);
  }

  async listActiveRuns(): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT id, agent_id, status, config_snapshot, errors,
              created_at, updated_at, archived_at,
              system_prompt_hash, task_prompt_hash, memory_prompt_hash,
              metadata, kind, group_chat_through_seq
       FROM runs
       WHERE status = 'active' AND archived_at IS NULL
       ORDER BY created_at`,
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async listRuns(agentId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT id, agent_id, status, config_snapshot, errors,
              created_at, updated_at, archived_at,
              system_prompt_hash, task_prompt_hash, memory_prompt_hash,
              metadata, kind, group_chat_through_seq, schedule_id
       FROM runs WHERE agent_id = $1 ORDER BY updated_at DESC`,
      [agentId],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async getRun(runId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT id, agent_id, status, config_snapshot, errors,
              created_at, updated_at, archived_at,
              system_prompt_hash, task_prompt_hash, memory_prompt_hash,
              metadata, kind, group_chat_through_seq, schedule_id
       FROM runs WHERE id = $1`,
      [runId],
    );
    return firstRow(result);
  }

  async createRun(
    runId: string,
    agentId: string,
    configSnapshot: Record<string, unknown>,
    systemContent: string,
    taskContent: string,
    userContent: string | null,
    now: Date,
    options: {
      systemPromptHash: string;
      taskPromptHash: string;
      memoryPromptHash: string;
      extraMessages?: Array<[Record<string, unknown>, Record<string, unknown>]>;
      runMetadata?: Record<string, unknown>;
      userMetadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    const opening = [...(options.extraMessages ?? [])];
    if (userContent !== null) {
      opening.push([
        { role: "user", content: userContent },
        { generation: 1, source: "ui", ...(options.userMetadata ?? {}) },
      ]);
    }
    await this.insertRun(runId, agentId, "direct", configSnapshot, systemContent, taskContent, opening, now, {
      systemPromptHash: options.systemPromptHash,
      taskPromptHash: options.taskPromptHash,
      memoryPromptHash: options.memoryPromptHash,
      ...(options.runMetadata ? { runMetadata: options.runMetadata } : {}),
    });
  }

  async createGroupRun(
    runId: string,
    agentId: string,
    configSnapshot: Record<string, unknown>,
    systemContent: string,
    taskContent: string,
    projected: Array<[Record<string, unknown>, Record<string, unknown>]>,
    throughSeq: number,
    now: Date,
    options: { systemPromptHash: string; taskPromptHash: string; memoryPromptHash: string; runMetadata?: Record<string, unknown> },
  ): Promise<void> {
    await this.insertRun(runId, agentId, "group", configSnapshot, systemContent, taskContent, projected, now, {
      ...options,
      groupChatThroughSeq: throughSeq,
    });
  }

  async createScheduleRun(
    runId: string,
    agentId: string,
    configSnapshot: Record<string, unknown>,
    systemContent: string,
    taskContent: string,
    projected: Array<[Record<string, unknown>, Record<string, unknown>]>,
    now: Date,
    options: {
      systemPromptHash: string;
      taskPromptHash: string;
      memoryPromptHash: string;
      scheduleId?: string | null;
      runMetadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.insertRun(runId, agentId, "schedule", configSnapshot, systemContent, taskContent, projected, now, options);
  }

  async insertRun(
    runId: string,
    agentId: string,
    kind: string,
    configSnapshot: Record<string, unknown>,
    systemContent: string,
    taskContent: string,
    opening: Array<[Record<string, unknown>, Record<string, unknown>]>,
    now: Date,
    options: {
      systemPromptHash: string;
      taskPromptHash: string;
      memoryPromptHash: string;
      groupChatThroughSeq?: number | null;
      scheduleId?: string | null;
      runMetadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    const systemMetadata: Record<string, unknown> = { source: "system" };
    if (options.runMetadata?.task_source) {
      systemMetadata.task_source = options.runMetadata.task_source;
    }
    const rows: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ role: "system", content: systemContent }, systemMetadata],
      ...opening,
    ];
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO runs (
           id, agent_id, org_id, status, config_snapshot, created_at, updated_at,
           system_prompt_hash, task_prompt_hash, memory_prompt_hash,
           kind, group_chat_through_seq, metadata, schedule_id
         )
         VALUES (
           $1, $2,
           (SELECT p.org_id FROM agents a JOIN guilds p ON p.id = a.guild_id WHERE a.id = $2),
           'active', $3::jsonb, $4, $4, $5, $6, $7, $8, $9, $10::jsonb, $11
         )`,
        [
          runId,
          agentId,
          JSON.stringify(configSnapshot),
          stamp(now),
          options.systemPromptHash,
          options.taskPromptHash,
          options.memoryPromptHash,
          kind,
          options.groupChatThroughSeq ?? null,
          JSON.stringify(options.runMetadata ?? {}),
          options.scheduleId ?? null,
        ],
      );
      for (const [seq, [payload, metadata]] of rows.entries()) {
        await client.query(
          `INSERT INTO messages (run_id, seq, payload, metadata, created_at, cost_usd)
           VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)`,
          [runId, seq, JSON.stringify(payload), JSON.stringify(metadata), stamp(now), messageCostUsd(metadata)],
        );
      }
    });
  }

  async insertMessage(
    runId: string,
    seq: number,
    payload: Record<string, unknown>,
    metadata: Record<string, unknown>,
    now: Date,
  ): Promise<Record<string, unknown>> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `INSERT INTO messages (run_id, seq, payload, metadata, created_at, cost_usd)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
         RETURNING id, run_id, seq, payload, metadata, created_at, cost_usd`,
        [runId, seq, JSON.stringify(payload), JSON.stringify(metadata), stamp(now), messageCostUsd(metadata)],
      );
      const row = firstRow(result);
      if (!row) {
        throw new Error("message insert failed");
      }
      await client.query(`UPDATE runs SET updated_at = $2 WHERE id = $1`, [runId, stamp(now)]);
      await incrementUsage(client, runId, metadata, now);
      return row;
    });
  }

  async nextSeq(runId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COALESCE(MAX(seq), -1) + 1 AS value FROM messages WHERE run_id = $1`,
      [runId],
    );
    return Number(result.rows[0]?.value ?? 0);
  }

  async nextGeneration(runId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COALESCE(MAX((metadata->>'generation')::int), 0) + 1 AS value
       FROM messages WHERE run_id = $1`,
      [runId],
    );
    return Number(result.rows[0]?.value ?? 1);
  }

  async listMessages(runId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT id, run_id, seq, payload, metadata, created_at, cost_usd
       FROM messages WHERE run_id = $1 ORDER BY seq`,
      [runId],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  /** The metadata of a run's result for one tool call, or null when the call has no result. */
  async getToolResultMetadata(runId: string, toolCallId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT metadata FROM messages
       WHERE run_id = $1 AND payload->>'role' = 'tool' AND metadata->>'tool_call_id' = $2
       ORDER BY seq LIMIT 1`,
      [runId, toolCallId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? ((jsonObj(row.metadata) as Record<string, unknown> | null) ?? {}) : null;
  }

  async listPayloads(runId: string): Promise<Array<Record<string, unknown>>> {
    return (await this.listMessages(runId)).map((row) => jsonObj(row.payload) as Record<string, unknown>);
  }

  // Runs of a guild's agents active inside [since, until]. `previous_through_seq`
  // is the group snapshot of the same agent's previous run of that kind.
  async listGuildActivityRuns(guildId: string, since: Date, until: Date): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT * FROM (
         SELECT r.id, r.agent_id, r.kind, r.status, r.errors, r.metadata, r.schedule_id,
                r.group_chat_through_seq, r.created_at, r.updated_at,
                LAG(r.group_chat_through_seq) OVER (
                  PARTITION BY r.agent_id, r.kind ORDER BY r.created_at
                ) AS previous_through_seq
         FROM runs r
         JOIN agents a ON a.id = r.agent_id
         WHERE a.guild_id = $1 AND r.archived_at IS NULL AND r.created_at <= $3
       ) guild_runs
       WHERE created_at >= $2 OR updated_at >= $2
       ORDER BY created_at`,
      [guildId, stamp(since), stamp(until)],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  // Per-run step facts: the last step, the first and last step inside the
  // window, and the cost of the steps inside it.
  async listRunActivityStats(runIds: string[], since: Date): Promise<Array<Record<string, unknown>>> {
    if (!runIds.length) {
      return [];
    }
    const result = await this.pool.query(
      `SELECT run_id,
              MAX(seq) AS last_seq,
              MIN(created_at) FILTER (WHERE created_at >= $2) AS first_at,
              MAX(created_at) AS last_at,
              COALESCE(SUM(cost_usd) FILTER (WHERE created_at >= $2), 0) AS cost_usd
       FROM messages
       WHERE run_id = ANY($1::text[])
       GROUP BY run_id`,
      [runIds, stamp(since)],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  // The group delivery row each group run opened with.
  async listRunGroupDeliveries(runIds: string[]): Promise<Array<Record<string, unknown>>> {
    if (!runIds.length) {
      return [];
    }
    const result = await this.pool.query(
      `SELECT DISTINCT ON (run_id) run_id, metadata
       FROM messages
       WHERE run_id = ANY($1::text[]) AND metadata->>'source' = 'group_chat'
       ORDER BY run_id, seq`,
      [runIds],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  // `group_post` results, which carry the tool call id and the posted sequence.
  async listRunGroupPosts(runIds: string[]): Promise<Array<Record<string, unknown>>> {
    if (!runIds.length) {
      return [];
    }
    const result = await this.pool.query(
      `SELECT run_id, seq, created_at, payload->>'content' AS content, metadata->>'tool_call_id' AS call_id
       FROM messages
       WHERE run_id = ANY($1::text[])
         AND payload->>'role' = 'tool'
         AND metadata->>'tool_name' = 'group_post'
       ORDER BY run_id, seq`,
      [runIds],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  // Assistant and tool steps inside the window: each assistant step's tool
  // calls and text, and each tool result's call id, error, and duration.
  async listRunActivitySteps(runIds: string[], since: Date): Promise<Array<Record<string, unknown>>> {
    if (!runIds.length) {
      return [];
    }
    const result = await this.pool.query(
      `SELECT run_id, seq, created_at,
              payload->>'role' AS role,
              CASE WHEN payload->>'role' = 'assistant' THEN payload->'tool_calls' END AS tool_calls,
              CASE WHEN payload->>'role' = 'assistant' THEN ${STEP_TEXT} END AS text,
              metadata->>'tool_call_id' AS tool_call_id,
              metadata->>'error' AS error,
              metadata->>'duration_ms' AS duration_ms
       FROM messages
       WHERE run_id = ANY($1::text[])
         AND created_at >= $2
         AND payload->>'role' IN ('assistant', 'tool')
       ORDER BY run_id, seq`,
      [runIds, stamp(since)],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  // The first user message inside the window of each run.
  async listRunOpenings(runIds: string[], since: Date): Promise<Array<Record<string, unknown>>> {
    if (!runIds.length) {
      return [];
    }
    const result = await this.pool.query(
      `SELECT DISTINCT ON (run_id) run_id, ${STEP_TEXT} AS text
       FROM messages
       WHERE run_id = ANY($1::text[])
         AND created_at >= $2
         AND payload->>'role' = 'user'
       ORDER BY run_id, seq`,
      [runIds, stamp(since)],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async listRunFileChanges(runIds: string[]): Promise<Array<Record<string, unknown>>> {
    if (!runIds.length) {
      return [];
    }
    const result = await this.pool.query(
      `SELECT run_id, display_path, operation, tool_name, tool_call_id, created_at
       FROM file_changes
       WHERE run_id = ANY($1::text[])
       ORDER BY created_at, id`,
      [runIds],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async appendRunError(runId: string, entry: Record<string, unknown>, now: Date): Promise<unknown[]> {
    const result = await this.pool.query(
      `UPDATE runs
       SET errors = errors || $2::jsonb, updated_at = $3
       WHERE id = $1
       RETURNING errors`,
      [runId, JSON.stringify([entry]), stamp(now)],
    );
    const loaded = jsonObj(result.rows[0]?.errors);
    return Array.isArray(loaded) ? loaded : [];
  }

  async getGroupChatState(guildId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT
         p.id AS guild_id,
         p.group_chat_seq AS chat_seq,
         p.group_agent_message_count AS agent_message_count,
         p.group_agent_message_limit AS agent_message_limit,
         p.group_chat_errors AS errors,
         (
           SELECT COUNT(*)::int
           FROM agents a
           WHERE a.guild_id = p.id
             AND a.archived_at IS NULL
             AND a.group_chat_delivered_through < p.group_chat_seq
         ) AS pending_agent_count
       FROM guilds p
       WHERE p.id = $1`,
      [guildId],
    );
    return firstRow(result);
  }

  async updateGroupAgentMessageLimit(
    guildId: string,
    limit: number,
    now: Date,
  ): Promise<Record<string, unknown> | null> {
    const updated = await this.pool.query(`UPDATE guilds SET group_agent_message_limit = $2, updated_at = $3 WHERE id = $1 RETURNING id`, [
      guildId,
      limit,
      stamp(now),
    ]);
    if (!firstRow(updated)) {
      return null;
    }
    return this.getGroupChatState(guildId);
  }

  async listGroupMessages(
    guildId: string,
    options: { throughSeq?: number | null } = {},
  ): Promise<Array<Record<string, unknown>>> {
    if (options.throughSeq === undefined || options.throughSeq === null) {
      const result = await this.pool.query(
        `SELECT id, guild_id, seq, author_type, author_name,
                author_agent_id, source_run_id, content, tagged_names,
                tagged_agent_ids, tagged_user_ids, created_at
         FROM group_messages WHERE guild_id = $1 ORDER BY seq`,
        [guildId],
      );
      return result.rows as Array<Record<string, unknown>>;
    }
    const result = await this.pool.query(
      `SELECT id, guild_id, seq, author_type, author_name,
              author_agent_id, source_run_id, content, tagged_names,
              tagged_agent_ids, tagged_user_ids, created_at
       FROM group_messages WHERE guild_id = $1 AND seq <= $2 ORDER BY seq`,
      [guildId, options.throughSeq],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  // Public rows posted inside [since, until], plus every earlier row after
  // `afterSeq` so a run that woke on an older message still finds it.
  async listGroupMessagesForActivity(
    guildId: string,
    since: Date,
    until: Date,
    afterSeq: number | null,
  ): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT id, seq, author_type, author_name, author_agent_id, source_run_id,
              content, tagged_names, created_at
       FROM group_messages
       WHERE guild_id = $1
         AND created_at <= $3
         AND (created_at >= $2 OR ($4::bigint IS NOT NULL AND seq > $4::bigint))
       ORDER BY seq`,
      [guildId, stamp(since), stamp(until), afterSeq],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async listPendingGroupAgents(guildId: string, chatSeq: number): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT id, guild_id, name, created_at, group_chat_delivered_through
       FROM agents
       WHERE guild_id = $1 AND archived_at IS NULL AND group_chat_delivered_through < $2
       ORDER BY group_chat_delivered_through, created_at`,
      [guildId, chatSeq],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async advanceGroupCursor(agentId: string, seq: number): Promise<void> {
    await this.pool.query(
      `UPDATE agents
       SET group_chat_delivered_through = GREATEST(group_chat_delivered_through, $2)
       WHERE id = $1`,
      [agentId, seq],
    );
  }

  async getGroupChatSeenThrough(guildId: string, userId: string): Promise<number | null> {
    const result = await this.pool.query(
      `SELECT seen_through_seq FROM group_chat_reads WHERE guild_id = $1 AND user_id = $2`,
      [guildId, userId],
    );
    const row = firstRow(result);
    return row ? Number(row.seen_through_seq) : null;
  }

  async markGroupChatSeen(guildId: string, userId: string, seq: number, now: Date): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO group_chat_reads (guild_id, user_id, seen_through_seq, updated_at)
       VALUES ($1, $2, LEAST($3::bigint, (SELECT group_chat_seq FROM guilds WHERE id = $1)), $4)
       ON CONFLICT (guild_id, user_id) DO UPDATE
         SET seen_through_seq = GREATEST(group_chat_reads.seen_through_seq, EXCLUDED.seen_through_seq),
             updated_at = EXCLUDED.updated_at
       RETURNING seen_through_seq`,
      [guildId, userId, seq, stamp(now)],
    );
    return Number(result.rows[0].seen_through_seq);
  }

  async appendGroupChatError(guildId: string, entry: Record<string, unknown>, now: Date): Promise<unknown[]> {
    const result = await this.pool.query(
      `UPDATE guilds
       SET group_chat_errors = group_chat_errors || $2::jsonb, updated_at = $3
       WHERE id = $1
       RETURNING group_chat_errors`,
      [guildId, JSON.stringify([entry]), stamp(now)],
    );
    const loaded = jsonObj(result.rows[0]?.group_chat_errors);
    return Array.isArray(loaded) ? loaded : [];
  }

  async listDueSchedules(now: Date): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT ${scheduleColumns("s")}
       FROM schedules s
       JOIN agents a ON a.id = s.agent_id
       JOIN guilds g ON g.id = a.guild_id
       WHERE s.next_run_at <= $1 AND s.paused = false AND g.routines_enabled
       ORDER BY s.next_run_at`,
      [stamp(now)],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async markScheduleFired(scheduleId: string, now: Date, wake: PlannedWake): Promise<void> {
    await this.pool.query(
      `UPDATE schedules SET last_run_at = $2, next_run_at = $3, window_fires = $4, updated_at = $2
       WHERE id = $1`,
      [scheduleId, stamp(now), stamp(wake.at), wake.windowFires],
    );
  }

  async mergeRunMetadata(runId: string, extra: Record<string, unknown>, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE runs
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = $3
       WHERE id = $1`,
      [runId, JSON.stringify(extra), stamp(now)],
    );
  }

  async completeRun(runId: string, now: Date): Promise<void> {
    await this.pool.query(`UPDATE runs SET status = 'completed', updated_at = $2 WHERE id = $1`, [
      runId,
      stamp(now),
    ]);
  }

  async reopenRun(runId: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE runs
       SET status = 'active',
           metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
           updated_at = $3
       WHERE id = $1 AND status = 'completed' AND archived_at IS NULL`,
      [runId, JSON.stringify({ resumed_at: now.toISOString() }), stamp(now)],
    );
  }

  async completeGroupDelivery(runId: string, agentId: string, throughSeq: number, now: Date): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query(`UPDATE runs SET status = 'completed', updated_at = $2 WHERE id = $1`, [
        runId,
        stamp(now),
      ]);
      await client.query(
        `UPDATE agents
         SET group_chat_delivered_through = GREATEST(group_chat_delivered_through, $2)
         WHERE id = $1`,
        [agentId, throughSeq],
      );
    });
  }

  async postUserGroupMessage(
    guildId: string,
    content: string,
    taggedNames: string[],
    taggedAgentIds: string[],
    taggedUserIds: string[],
    now: Date,
    options: { authorName?: string } = {},
  ): Promise<Record<string, unknown> | null> {
    return withTransaction(this.pool, async (client) => {
      const guild = await client.query(`SELECT id, archived_at FROM guilds WHERE id = $1 FOR UPDATE`, [guildId]);
      const row = firstRow(guild);
      if (!row) {
        return null;
      }
      if (row.archived_at !== null) {
        throw new GuildInactive();
      }
      const seqResult = await client.query(
        `UPDATE guilds
         SET group_chat_seq = group_chat_seq + 1,
             group_agent_message_count = 0,
             updated_at = $2
         WHERE id = $1
         RETURNING group_chat_seq`,
        [guildId, stamp(now)],
      );
      const seq = Number(firstRow(seqResult)?.group_chat_seq);
      const inserted = await client.query(
        `INSERT INTO group_messages (
           guild_id, seq, author_type, author_name,
           author_agent_id, source_run_id, content, tagged_names,
           tagged_agent_ids, tagged_user_ids, created_at
         )
         VALUES ($1, $2, 'user', $7, NULL, NULL, $3, $4::jsonb, $5::jsonb, $8::jsonb, $6)
         RETURNING id, guild_id, seq, author_type, author_name,
                   author_agent_id, source_run_id, content, tagged_names,
                   tagged_agent_ids, tagged_user_ids, created_at`,
        [
          guildId,
          seq,
          content,
          JSON.stringify(taggedNames),
          JSON.stringify(taggedAgentIds),
          stamp(now),
          options.authorName ?? "user",
          JSON.stringify(taggedUserIds),
        ],
      );
      return firstRow(inserted);
    });
  }

  async postAgentGroupMessage(
    guildId: string,
    agentId: string,
    authorName: string,
    sourceRunId: string,
    content: string,
    taggedNames: string[],
    taggedAgentIds: string[],
    taggedUserIds: string[],
    now: Date,
  ): Promise<Record<string, unknown> | null> {
    return withTransaction(this.pool, async (client) => {
      const guild = await client.query(
        `SELECT id, archived_at, group_agent_message_count, group_agent_message_limit
         FROM guilds WHERE id = $1 FOR UPDATE`,
        [guildId],
      );
      const row = firstRow(guild);
      if (!row) {
        return null;
      }
      if (row.archived_at !== null) {
        throw new GuildInactive();
      }
      const limit = Number(row.group_agent_message_limit);
      if (Number(row.group_agent_message_count) >= limit) {
        throw new AgentMessageLimitReached(limit);
      }
      const seqResult = await client.query(
        `UPDATE guilds
         SET group_chat_seq = group_chat_seq + 1,
             group_agent_message_count = group_agent_message_count + 1,
             updated_at = $2
         WHERE id = $1
         RETURNING group_chat_seq`,
        [guildId, stamp(now)],
      );
      const seq = Number(firstRow(seqResult)?.group_chat_seq);
      const inserted = await client.query(
        `INSERT INTO group_messages (
           guild_id, seq, author_type, author_name,
           author_agent_id, source_run_id, content, tagged_names,
           tagged_agent_ids, tagged_user_ids, created_at
         )
         VALUES ($1, $2, 'agent', $3, $4, $5, $6, $7::jsonb, $8::jsonb, $10::jsonb, $9)
         RETURNING id, guild_id, seq, author_type, author_name,
                   author_agent_id, source_run_id, content, tagged_names,
                   tagged_agent_ids, tagged_user_ids, created_at`,
        [
          guildId,
          seq,
          authorName,
          agentId,
          sourceRunId,
          content,
          JSON.stringify(taggedNames),
          JSON.stringify(taggedAgentIds),
          stamp(now),
          JSON.stringify(taggedUserIds),
        ],
      );
      await client.query(
        `UPDATE agents
         SET group_chat_delivered_through = GREATEST(group_chat_delivered_through, $2)
         WHERE id = $1`,
        [agentId, seq],
      );
      return firstRow(inserted);
    });
  }

  async updateRunSecrets(runId: string, secrets: Array<Record<string, string>>, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE runs
       SET config_snapshot = jsonb_set(config_snapshot, '{secrets}', $2::jsonb),
           updated_at = $3
       WHERE id = $1`,
      [runId, JSON.stringify(secrets), stamp(now)],
    );
  }

  async updateRunScripts(runId: string, scripts: unknown[], now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE runs
       SET config_snapshot = jsonb_set(config_snapshot, '{scripts}', $2::jsonb),
           updated_at = $3
       WHERE id = $1`,
      [runId, JSON.stringify(scripts), stamp(now)],
    );
  }

  async listActiveRunAgentIdsForSecret(secretId: string): Promise<string[]> {
    const result = await this.pool.query(
      `SELECT DISTINCT agent_id
       FROM runs
       WHERE status = 'active'
         AND archived_at IS NULL
         AND config_snapshot->'secrets' @> $1::jsonb`,
      [JSON.stringify([{ id: secretId }])],
    );
    return result.rows.map((row) => String(row.agent_id));
  }

  async getUserByEmail(email: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT id, name, email, image, timezone, color, created_at, updated_at
       FROM users WHERE lower(email) = lower($1)`,
      [email],
    );
    return firstRow(result);
  }

  /**
   * Adds one Studio or Builder generation to this month's count. When `limit` is set, the
   * increment lands only while the count is still below it; `null` means the increment failed
   * the cap (including a limit of 0).
   */
  async claimMonthlyStudioBuilderRun(
    orgId: string,
    now: Date,
    limit: number | null,
    client?: pg.PoolClient,
  ): Promise<number | null> {
    const db = client ?? this.pool;
    if (limit === 0) {
      return null;
    }
    const result = await db.query(
      `INSERT INTO org_monthly_usage (
         org_id, month, input_tokens, output_tokens, cache_read_tokens,
         cost_usd, calls, studio_builder_runs, updated_at
       )
       VALUES ($1, $2, 0, 0, 0, 0, 0, 1, $3)
       ON CONFLICT (org_id, month) DO UPDATE SET
         studio_builder_runs = org_monthly_usage.studio_builder_runs + 1,
         updated_at = EXCLUDED.updated_at
       WHERE $4::int IS NULL OR org_monthly_usage.studio_builder_runs < $4
       RETURNING studio_builder_runs`,
      [orgId, utcMonth(now), stamp(now), limit],
    );
    const row = firstRow(result);
    return row ? Number(row.studio_builder_runs) : null;
  }

  async countGuildAgents(guildId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM agents WHERE guild_id = $1`,
      [guildId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async countOrgGuilds(orgId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM guilds WHERE org_id = $1 AND archived_at IS NULL`,
      [orgId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /** How many logins to a server are not disconnected, at every scope. */
  async countServerConnections(serverId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM mcp_connections WHERE mcp_server_id = $1 AND status <> 'disconnected'`,
      [serverId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /** Marks every login to a server disconnected, at every scope; returns how many it changed. */
  async disconnectServerConnections(serverId: string, now = new Date()): Promise<number> {
    const result = await this.pool.query(
      `UPDATE mcp_connections
          SET status = 'disconnected', oauth_state = NULL, updated_at = $2
        WHERE mcp_server_id = $1 AND status <> 'disconnected'`,
      [serverId, now.toISOString()],
    );
    return result.rowCount ?? 0;
  }

  /** Drops an integration's stored values without reading them; true when a row was there. */
  async deleteInstanceKey(integrationId: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM instance_keys WHERE integration = $1`, [integrationId]);
    return (result.rowCount ?? 0) > 0;
  }

  async countOrgAgents(orgId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count
       FROM agents a
       JOIN guilds p ON p.id = a.guild_id
       WHERE p.org_id = $1 AND a.archived_at IS NULL`,
      [orgId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async countOrgBrowserAgents(orgId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count
       FROM agents a
       JOIN guilds p ON p.id = a.guild_id
       WHERE p.org_id = $1
         AND a.archived_at IS NULL
         AND COALESCE((a.config->>'browser')::boolean, FALSE)`,
      [orgId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async countOrgCodingAgents(orgId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count
       FROM agents a
       JOIN guilds p ON p.id = a.guild_id
       WHERE p.org_id = $1
         AND a.archived_at IS NULL
         AND COALESCE((a.config->>'coding')::boolean, FALSE)`,
      [orgId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async getOrgMonthlyUsage(orgId: string, month: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT org_id, month, input_tokens, output_tokens, cache_read_tokens,
              cost_usd, calls, studio_builder_runs, updated_at
       FROM org_monthly_usage
       WHERE org_id = $1 AND month = $2`,
      [orgId, month],
    );
    return firstRow(result);
  }

  async listOrgModelProviders(orgId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT id, org_id, provider, key_hint, models, created_at, updated_at
       FROM org_model_providers
       WHERE org_id = $1
       ORDER BY provider`,
      [orgId],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async getOrgModelProvider(orgId: string, provider: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT id, org_id, provider, ciphertext, nonce, key_hint, models, created_at, updated_at
       FROM org_model_providers
       WHERE org_id = $1 AND provider = $2`,
      [orgId, provider],
    );
    return firstRow(result);
  }

  async upsertOrgModelProvider(
    providerId: string,
    orgId: string,
    provider: string,
    row: { ciphertext: Buffer | null; nonce: Buffer | null; keyHint: string | null; models: string[] },
    now: Date,
  ): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `INSERT INTO org_model_providers (
         id, org_id, provider, ciphertext, nonce, key_hint, models, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $8)
       ON CONFLICT (org_id, provider) DO UPDATE SET
         ciphertext = EXCLUDED.ciphertext,
         nonce = EXCLUDED.nonce,
         key_hint = EXCLUDED.key_hint,
         models = EXCLUDED.models,
         updated_at = EXCLUDED.updated_at
       RETURNING id, org_id, provider, key_hint, models, created_at, updated_at`,
      [providerId, orgId, provider, row.ciphertext, row.nonce, row.keyHint, row.models, stamp(now)],
    );
    const inserted = firstRow(result);
    if (!inserted) {
      throw new Error("model provider upsert failed");
    }
    return inserted;
  }

  async deleteOrgModelProvider(orgId: string, provider: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `DELETE FROM org_model_providers
       WHERE org_id = $1 AND provider = $2
       RETURNING id, org_id, provider, key_hint, models`,
      [orgId, provider],
    );
    return firstRow(result);
  }

  async getOrgDefaultModel(orgId: string): Promise<string | null> {
    const result = await this.pool.query(`SELECT default_model FROM orgs WHERE id = $1`, [orgId]);
    const value = firstRow(result)?.default_model;
    return typeof value === "string" && value ? value : null;
  }

  async setOrgDefaultModel(orgId: string, model: string | null, now: Date): Promise<void> {
    await this.pool.query(`UPDATE orgs SET default_model = $2, updated_at = $3 WHERE id = $1`, [
      orgId,
      model,
      stamp(now),
    ]);
  }

  /** The connector an organisation sees under a slug: the platform's, or with `orgId` its own. */
  async getMcpServerBySlug(slug: string, orgId: string | null = null): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT ${CONNECTOR_COLUMNS}
       FROM connectors
       WHERE slug = $1 AND (owner_org_id IS NULL OR owner_org_id = $2)
       ORDER BY owner_org_id NULLS FIRST
       LIMIT 1`,
      [slug, orgId],
    );
    const row = firstRow(result);
    return row === null ? null : loadConnector(row);
  }

  /** Who holds a slug: the platform (null) or each organisation that added a server under it. */
  async listConnectorSlugOwners(slug: string): Promise<Array<string | null>> {
    const result = await this.pool.query(`SELECT owner_org_id FROM connectors WHERE slug = $1`, [slug]);
    return result.rows.map((row) => (row.owner_org_id === null ? null : String(row.owner_org_id)));
  }

  /** Calls an organisation made on a connector's platform login in one month (`YYYY-MM`). */
  async countConnectorCalls(orgId: string, connectorId: string, month: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT calls FROM connector_calls WHERE org_id = $1 AND connector_id = $2 AND month = $3`,
      [orgId, connectorId, month],
    );
    return Number(result.rows[0]?.calls ?? 0);
  }

  async recordConnectorCall(orgId: string, connectorId: string, month: string, now: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO connector_calls (org_id, connector_id, month, calls, updated_at)
       VALUES ($1, $2, $3, 1, $4)
       ON CONFLICT (org_id, connector_id, month)
       DO UPDATE SET calls = connector_calls.calls + 1, updated_at = EXCLUDED.updated_at`,
      [orgId, connectorId, month, stamp(now)],
    );
  }

  /** An organisation's counted calls in one month, by connector slug. */
  async listConnectorCalls(orgId: string, month: string): Promise<Record<string, number>> {
    const result = await this.pool.query(
      `SELECT c.slug, k.calls
       FROM connector_calls k JOIN connectors c ON c.id = k.connector_id
       WHERE k.org_id = $1 AND k.month = $2`,
      [orgId, month],
    );
    return Object.fromEntries(result.rows.map((row) => [String(row.slug), Number(row.calls)]));
  }

  async countOrgConnectors(orgId: string): Promise<number> {
    const result = await this.pool.query(`SELECT count(*)::int AS n FROM connectors WHERE owner_org_id = $1`, [orgId]);
    return Number(result.rows[0]?.n ?? 0);
  }

  /** Removes a connector with its logins, their listed tools, and the bindings on them. */
  async deleteConnector(serverId: string): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const tools = await client.query(`SELECT namespaced_name FROM mcp_tools WHERE mcp_server_id = $1`, [serverId]);
      await client.query(
        `DELETE FROM bindings
         WHERE (catalog_kind = 'mcp' AND catalog_id = $1)
            OR (catalog_kind = 'mcp_tool' AND catalog_id = ANY($2::text[]))`,
        [serverId, tools.rows.map((row) => String(row.namespaced_name))],
      );
      const deleted = await client.query(`DELETE FROM connectors WHERE id = $1`, [serverId]);
      return (deleted.rowCount ?? 0) > 0;
    });
  }

  /** Inserts a connector row: a server created by hand, or one a registry install writes. */
  async insertConnector(
    row: {
      id: string;
      slug: string;
      toolPrefix: string;
      ownerOrgId: string | null;
      manifest: unknown;
      source: string;
      version?: string;
      verified: boolean;
      experimental?: boolean;
      publisher: string;
      enabled: boolean;
    },
    now: Date,
  ): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `INSERT INTO connectors (
         id, slug, tool_prefix, owner_org_id, manifest, source, version, verified, publisher, enabled,
         oauth_client, overrides, installed_at, updated_at, experimental
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, NULL, '{}'::jsonb, $11, $11, $12)
       RETURNING ${CONNECTOR_COLUMNS}`,
      [
        row.id,
        row.slug,
        row.toolPrefix,
        row.ownerOrgId,
        JSON.stringify(row.manifest),
        row.source,
        row.version ?? "",
        row.verified,
        row.publisher,
        row.enabled,
        stamp(now),
        row.experimental ?? false,
      ],
    );
    const inserted = firstRow(result);
    if (!inserted) {
      throw new Error("connector insert failed");
    }
    return loadConnector(inserted);
  }

  /** Updates a connector's manifest and where it came from (a folderless row), its overrides, or its switch. */
  async updateConnector(
    serverId: string,
    patch: {
      slug?: string;
      manifest?: unknown;
      overrides?: unknown;
      enabled?: boolean;
      version?: string;
      verified?: boolean;
      experimental?: boolean;
      publisher?: string;
    },
    now: Date,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `UPDATE connectors SET
         slug = COALESCE($2, slug),
         manifest = COALESCE($3::jsonb, manifest),
         overrides = COALESCE($4::jsonb, overrides),
         enabled = COALESCE($5, enabled),
         version = COALESCE($7, version),
         verified = COALESCE($8, verified),
         publisher = COALESCE($9, publisher),
         experimental = COALESCE($10, experimental),
         updated_at = $6
       WHERE id = $1
       RETURNING ${CONNECTOR_COLUMNS}`,
      [
        serverId,
        patch.slug ?? null,
        patch.manifest === undefined ? null : JSON.stringify(patch.manifest),
        patch.overrides === undefined ? null : JSON.stringify(patch.overrides),
        patch.enabled ?? null,
        stamp(now),
        patch.version ?? null,
        patch.verified ?? null,
        patch.publisher ?? null,
        patch.experimental ?? null,
      ],
    );
    const row = firstRow(result);
    return row === null ? null : loadConnector(row);
  }

  /** Marks every listing of a server's tools stale, so each login lists them again on its next use. */
  async expireMcpTools(serverId: string): Promise<void> {
    await this.pool.query(`UPDATE mcp_tools SET listed_at = 'epoch' WHERE mcp_server_id = $1`, [serverId]);
  }

  async listTakenToolPrefixes(): Promise<string[]> {
    const result = await this.pool.query(`SELECT tool_prefix FROM connectors`);
    return result.rows.map((row) => String(row.tool_prefix));
  }

  async insertAttachment(row: {
    id: string;
    orgId: string;
    uploadedBy: string;
    filename: string;
    mime: string;
    bytes: number;
    sha256: string;
    kind: string;
    createdAt: Date;
  }): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `INSERT INTO attachments (
         id, org_id, uploaded_by, filename, mime, bytes, sha256, kind, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, org_id, uploaded_by, filename, mime, bytes, sha256, kind, created_at`,
      [
        row.id,
        row.orgId,
        row.uploadedBy,
        row.filename,
        row.mime,
        row.bytes,
        row.sha256,
        row.kind,
        stamp(row.createdAt),
      ],
    );
    const created = firstRow(result);
    if (!created) {
      throw new Error("attachment insert failed");
    }
    return created;
  }

  async getAttachment(id: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT id, org_id, uploaded_by, filename, mime, bytes, sha256, kind, created_at
       FROM attachments WHERE id = $1`,
      [id],
    );
    return firstRow(result);
  }

  async listAttachmentsByIds(orgId: string, ids: string[]): Promise<Array<Record<string, unknown>>> {
    if (!ids.length) {
      return [];
    }
    const result = await this.pool.query(
      `SELECT id, org_id, uploaded_by, filename, mime, bytes, sha256, kind, created_at
       FROM attachments WHERE org_id = $1 AND id = ANY($2::text[])`,
      [orgId, ids],
    );
    return result.rows as Array<Record<string, unknown>>;
  }
}

async function upsertMcpBinding(
  client: pg.PoolClient,
  bindingId: string,
  serverId: string,
  ownerScope: string,
  ownerId: string | null,
  connectionId: string,
  now: Date,
): Promise<void> {
  const [orgId, guildId, agentId] = ownerRefs(ownerScope, ownerId);
  if (ownerScope === "platform") {
    const binding = await client.query(
      `SELECT id FROM bindings
       WHERE catalog_kind = 'mcp' AND catalog_id = $1
         AND scope = 'platform'`,
      [serverId],
    );
    const existing = firstRow(binding);
    if (existing === null) {
      await client.query(
        `INSERT INTO bindings (
           id, catalog_kind, catalog_id, scope, scope_id, enabled,
           connection_id, created_at, updated_at
         )
         VALUES ($1, 'mcp', $2, 'platform', NULL, TRUE, $3, $4, $4)`,
        [bindingId, serverId, connectionId, stamp(now)],
      );
      return;
    }
    await client.query(
      `UPDATE bindings
       SET enabled = TRUE, connection_id = $2, updated_at = $3
       WHERE id = $1`,
      [existing.id, connectionId, stamp(now)],
    );
    return;
  }
  const binding = await client.query(
    `SELECT id FROM bindings
     WHERE catalog_kind = 'mcp' AND catalog_id = $1
       AND scope = $2 AND scope_id = $3`,
    [serverId, ownerScope, ownerId],
  );
  const existing = firstRow(binding);
  if (existing === null) {
    await client.query(
      `INSERT INTO bindings (
         id, catalog_kind, catalog_id, scope, scope_id,
         org_id, guild_id, agent_id, enabled, connection_id,
         created_at, updated_at
       )
       VALUES (
         $1, 'mcp', $2, $3, $4, $5, $6, $7, TRUE, $8, $9, $9
       )`,
      [bindingId, serverId, ownerScope, ownerId, orgId, guildId, agentId, connectionId, stamp(now)],
    );
    return;
  }
  await client.query(
    `UPDATE bindings
     SET enabled = TRUE, connection_id = $2, updated_at = $3
     WHERE id = $1`,
    [existing.id, connectionId, stamp(now)],
  );
}

async function incrementUsage(
  client: pg.PoolClient,
  runId: string,
  metadata: Record<string, unknown>,
  now: Date,
): Promise<void> {
  const delta = usageDelta(metadata);
  if (delta === null) {
    return;
  }
  const owners = await client.query(
    `SELECT a.id AS agent_id, a.guild_id, p.org_id
     FROM runs r
     JOIN agents a ON a.id = r.agent_id
     JOIN guilds p ON p.id = a.guild_id
     WHERE r.id = $1`,
    [runId],
  );
  const owner = firstRow(owners);
  if (!owner) {
    return;
  }
  for (const [scope, scopeId] of [
    ["agent", owner.agent_id],
    ["guild", owner.guild_id],
    ["org", owner.org_id],
    [GLOBAL_SCOPE, GLOBAL_SCOPE_ID],
  ] as const) {
    await client.query(
      `INSERT INTO usage_counters (
         scope, scope_id, input_tokens, output_tokens, cache_read_tokens,
         cost_usd, calls, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7)
       ON CONFLICT (scope, scope_id) DO UPDATE SET
         input_tokens = usage_counters.input_tokens + EXCLUDED.input_tokens,
         output_tokens = usage_counters.output_tokens + EXCLUDED.output_tokens,
         cache_read_tokens = usage_counters.cache_read_tokens + EXCLUDED.cache_read_tokens,
         cost_usd = usage_counters.cost_usd + EXCLUDED.cost_usd,
         calls = usage_counters.calls + 1,
         updated_at = EXCLUDED.updated_at`,
      [
        scope,
        scopeId,
        delta.input_tokens,
        delta.output_tokens,
        delta.cache_read_tokens,
        delta.cost_usd,
        stamp(now),
      ],
    );
  }
  await client.query(
    `INSERT INTO org_monthly_usage (
       org_id, month, input_tokens, output_tokens, cache_read_tokens,
       cost_usd, calls, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, 1, $7)
     ON CONFLICT (org_id, month) DO UPDATE SET
       input_tokens = org_monthly_usage.input_tokens + EXCLUDED.input_tokens,
       output_tokens = org_monthly_usage.output_tokens + EXCLUDED.output_tokens,
       cache_read_tokens = org_monthly_usage.cache_read_tokens + EXCLUDED.cache_read_tokens,
       cost_usd = org_monthly_usage.cost_usd + EXCLUDED.cost_usd,
       calls = org_monthly_usage.calls + 1,
       updated_at = EXCLUDED.updated_at`,
    [
      owner.org_id,
      utcMonth(now),
      delta.input_tokens,
      delta.output_tokens,
      delta.cache_read_tokens,
      delta.cost_usd,
      stamp(now),
    ],
  );
}

async function deleteGuildUsage(client: pg.PoolClient, guildId: string): Promise<void> {
  const agents = await client.query(`SELECT id FROM agents WHERE guild_id = $1`, [guildId]);
  const ids = agents.rows.map((row) => row.id);
  await client.query(
    `DELETE FROM usage_counters
     WHERE (scope = 'guild' AND scope_id = $1)
        OR (scope = 'agent' AND scope_id = ANY($2::text[]))`,
    [guildId, ids],
  );
}
