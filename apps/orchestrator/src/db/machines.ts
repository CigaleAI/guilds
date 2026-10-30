import type { InferSelectModel } from "drizzle-orm";
import { newId } from "../lib/ids.js";
import { pickColumns } from "./columns.js";
import { RowMissing } from "./errors.js";
import { type Queryable, stamp } from "./pg.js";
import {
  DEFAULT_MACHINE_BOX,
  DEFAULT_MACHINE_MAX_WORKSPACE_MIB,
  DEFAULT_MACHINE_NAME,
  type AgentConfig,
  machines,
} from "./schema/index.js";

type Machine = InferSelectModel<typeof machines>;

const MACHINE_KEYS = [
  "id",
  "org_id",
  "name",
  "box",
  "cpu",
  "memory_mib",
  "max_workspace_mib",
  "workspace_mib",
  "harnesses",
] as const;

/** A machine as stored: its numeric `cpu` is the text the driver reads it as. */
export type MachineQueryRow = Pick<Machine, (typeof MACHINE_KEYS)[number]>;

/** An agent on a machine, as the machine listing reads it from the agent and its config. */
export type MachineAgentQueryRow = {
  id: string;
  name: string;
  guild_id: string;
  guild_name: string;
  slot: number;
  browser: boolean;
  coding: boolean;
  max_workspace_mib: AgentConfig["max_workspace_mib"];
};

export type MachineWithAgentsQueryRow = MachineQueryRow & {
  agents: MachineAgentQueryRow[] | null;
};

/** What a machine is written with: its name, its tier, a custom tier's size, and its disk cap. */
export type MachineSpec = Pick<Machine, "name" | "box" | "memory_mib" | "max_workspace_mib"> & {
  cpu: number | null;
};

/** A machine, by its organisation and its id. */
export type MachineKey = Pick<Machine, "org_id" | "id">;

/** What an agent on a machine has on, as its config says. */
export type HostedNeeds = { browser: boolean; coding: boolean };

/** Where an agent sits, with its organisation and config, locked for the rest of the transaction. */
export type AgentPlacementRow = {
  org_id: string;
  config: Record<string, unknown>;
  machine_id: string;
  machine_slot: number;
};

const MACHINE_COLUMNS = pickColumns(machines, MACHINE_KEYS);

const MACHINES_WITH_AGENTS = `
  SELECT ${pickColumns(machines, MACHINE_KEYS, "m")},
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

/** The machine every organisation starts with, created in the transaction that creates it. */
export async function insertDefaultMachine(
  client: Queryable,
  orgId: string,
  now: Date,
): Promise<string> {
  const machineId = newId("mach");
  await client.query(
    `INSERT INTO machines (id, org_id, name, box, max_workspace_mib, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [
      machineId,
      orgId,
      DEFAULT_MACHINE_NAME,
      DEFAULT_MACHINE_BOX,
      DEFAULT_MACHINE_MAX_WORKSPACE_MIB,
      stamp(now),
    ],
  );
  return machineId;
}

/** The organisation's machines, oldest first, locked for the rest of the transaction `db` runs. */
export async function lockOrgMachines(db: Queryable, orgId: string): Promise<MachineQueryRow[]> {
  const result = await db.query<MachineQueryRow>(
    `SELECT ${MACHINE_COLUMNS} FROM machines WHERE org_id = $1 ORDER BY created_at, name FOR UPDATE`,
    [orgId],
  );
  return result.rows;
}

/** One machine of the organisation, locked for the rest of the transaction; null when it has none such. */
export async function lockMachine(
  db: Queryable,
  orgId: string,
  machineId: string,
): Promise<MachineQueryRow | null> {
  const result = await db.query<MachineQueryRow>(
    `SELECT ${MACHINE_COLUMNS} FROM machines WHERE org_id = $1 AND id = $2 FOR UPDATE`,
    [orgId, machineId],
  );
  return result.rows[0] ?? null;
}

/** The slots the agents on a machine sit in. */
export async function listMachineSlots(db: Queryable, machineId: string): Promise<number[]> {
  const result = await db.query<{ machine_slot: number }>(
    `SELECT machine_slot FROM agents WHERE machine_id = $1`,
    [machineId],
  );
  return result.rows.map((row) => row.machine_slot);
}

/** What each agent on a machine has on. */
export async function listHostedNeeds(db: Queryable, machineId: string): Promise<HostedNeeds[]> {
  const result = await db.query<HostedNeeds>(
    `SELECT COALESCE((config->>'browser')::boolean, FALSE) AS browser,
            COALESCE((config->>'coding')::boolean, FALSE) AS coding
       FROM agents WHERE machine_id = $1`,
    [machineId],
  );
  return result.rows;
}

/** The organisation's machines, oldest first, each with the agents on it. */
export async function listMachines(
  pool: Queryable,
  orgId: string,
): Promise<MachineWithAgentsQueryRow[]> {
  const result = await pool.query<MachineWithAgentsQueryRow>(
    `${MACHINES_WITH_AGENTS} WHERE m.org_id = $1 ORDER BY m.created_at, m.name`,
    [orgId],
  );
  return result.rows;
}

/** One machine of the organisation with the agents on it. */
export async function getMachineWithAgents(
  pool: Queryable,
  orgId: string,
  machineId: string,
): Promise<MachineWithAgentsQueryRow | null> {
  const result = await pool.query<MachineWithAgentsQueryRow>(
    `${MACHINES_WITH_AGENTS} WHERE m.org_id = $1 AND m.id = $2`,
    [orgId, machineId],
  );
  return result.rows[0] ?? null;
}

export async function getMachine(
  pool: Queryable,
  orgId: string,
  machineId: string,
): Promise<MachineQueryRow | null> {
  const result = await pool.query<MachineQueryRow>(
    `SELECT ${MACHINE_COLUMNS} FROM machines WHERE org_id = $1 AND id = $2`,
    [orgId, machineId],
  );
  return result.rows[0] ?? null;
}

export async function countMachineAgents(pool: Queryable, machineId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM agents WHERE machine_id = $1`,
    [machineId],
  );
  return result.rows[0]?.count ?? 0;
}

export async function countOrgMachines(db: Queryable, orgId: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM machines WHERE org_id = $1`,
    [orgId],
  );
  return result.rows[0]?.count ?? 0;
}

/** Whether any agent sits on the machine. */
export async function machineHostsAgents(db: Queryable, machineId: string): Promise<boolean> {
  const result = await db.query(`SELECT 1 FROM agents WHERE machine_id = $1 LIMIT 1`, [machineId]);
  return Boolean(result.rowCount);
}

/** Whether the organisation has a machine other than `machineId`. */
export async function orgHasOtherMachines(
  db: Queryable,
  orgId: string,
  machineId: string,
): Promise<boolean> {
  const result = await db.query(`SELECT 1 FROM machines WHERE org_id = $1 AND id <> $2 LIMIT 1`, [
    orgId,
    machineId,
  ]);
  return Boolean(result.rowCount);
}

export async function insertMachine(
  db: Queryable,
  orgId: string,
  machine: MachineSpec,
  now: Date,
): Promise<MachineQueryRow> {
  const result = await db.query<MachineQueryRow>(
    `INSERT INTO machines (id, org_id, name, box, cpu, memory_mib, max_workspace_mib, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     RETURNING ${MACHINE_COLUMNS}`,
    [
      newId("mach"),
      orgId,
      machine.name,
      machine.box,
      machine.cpu,
      machine.memory_mib,
      machine.max_workspace_mib,
      stamp(now),
    ],
  );
  const row = result.rows[0] ?? null;
  if (!row) {
    throw new RowMissing("machine insert failed");
  }
  return row;
}

/** Writes a machine's name, tier, size, and disk cap. */
export async function updateMachine(
  db: Queryable,
  key: MachineKey,
  machine: MachineSpec,
  now: Date,
): Promise<MachineQueryRow> {
  const result = await db.query<MachineQueryRow>(
    `UPDATE machines
        SET name = $3, box = $4, cpu = $5, memory_mib = $6, max_workspace_mib = $7, updated_at = $8
      WHERE org_id = $1 AND id = $2
      RETURNING ${MACHINE_COLUMNS}`,
    [
      key.org_id,
      key.id,
      machine.name,
      machine.box,
      machine.cpu,
      machine.memory_mib,
      machine.max_workspace_mib,
      stamp(now),
    ],
  );
  const row = result.rows[0] ?? null;
  if (!row) {
    throw new RowMissing("machine update failed");
  }
  return row;
}

export async function deleteMachine(db: Queryable, machineId: string): Promise<void> {
  await db.query(`DELETE FROM machines WHERE id = $1`, [machineId]);
}

/** Where an agent sits, locked for the rest of the transaction `db` runs; null when there is no such agent. */
export async function lockAgentPlacement(
  db: Queryable,
  agentId: string,
): Promise<AgentPlacementRow | null> {
  const result = await db.query<AgentPlacementRow>(
    `SELECT org_id, config, machine_id, machine_slot FROM agents WHERE id = $1 FOR UPDATE`,
    [agentId],
  );
  return result.rows[0] ?? null;
}

/** Seats an agent on a machine, in `slot`. */
export async function setAgentMachine(
  db: Queryable,
  agentId: string,
  machineId: string,
  slot: number,
): Promise<void> {
  await db.query(`UPDATE agents SET machine_id = $2, machine_slot = $3 WHERE id = $1`, [
    agentId,
    machineId,
    slot,
  ]);
}

/** The coding harness CLIs the machine's image carries, as its container reported them. */
export async function setMachineHarnesses(
  pool: Queryable,
  machineId: string,
  harnesses: string[],
): Promise<void> {
  await pool.query(`UPDATE machines SET harnesses = $2 WHERE id = $1`, [machineId, harnesses]);
}

export async function setMachineWorkspaceMib(
  pool: Queryable,
  machineId: string,
  mib: number,
): Promise<void> {
  await pool.query(`UPDATE machines SET workspace_mib = $2 WHERE id = $1`, [machineId, mib]);
}

export async function listMachineIds(pool: Queryable): Promise<string[]> {
  const result = await pool.query<{ id: string }>(`SELECT id FROM machines ORDER BY id`);
  return result.rows.map((row) => row.id);
}

/** Every agent with the machine it sits on, for laying out and sweeping their directories. */
export async function listMachinePlacements(
  pool: Queryable,
): Promise<Array<{ machineId: string; agentId: string }>> {
  const result = await pool.query<{ machine_id: string; id: string }>(
    `SELECT machine_id, id FROM agents ORDER BY machine_id, machine_slot`,
  );
  return result.rows.map((row) => ({
    machineId: row.machine_id,
    agentId: row.id,
  }));
}
