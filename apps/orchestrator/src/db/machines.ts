import type { InferSelectModel } from "drizzle-orm";
import { maxWorkspaceMibOf } from "../agents/validation.js";
import { newId } from "../lib/ids.js";
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
import { pickColumns } from "./columns.js";
import { RowMissing } from "./errors.js";
import { isUniqueViolation, type Queryable, stamp, withTransaction } from "./pg.js";
import { machines } from "./schema/index.js";

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

type MachineQueryRow = Pick<InferSelectModel<typeof machines>, (typeof MACHINE_KEYS)[number]>;

type MachineAgentQueryRow = Omit<MachineAgent, "max_workspace_mib"> & {
  max_workspace_mib: unknown;
};

type MachineWithAgentsQueryRow = MachineQueryRow & {
  agents: MachineAgentQueryRow[] | null;
};

export type MoveAgentResult = {
  from: { machineId: string; slot: number };
  to: { machineId: string; slot: number };
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

function machineWithAgents(row: MachineWithAgentsQueryRow): MachineWithAgents {
  const agents = row.agents ?? [];
  return {
    ...machineFromRow(row),
    agents: agents.map((agent) => ({
      ...agent,
      max_workspace_mib: maxWorkspaceMibOf(agent),
    })),
  };
}

/** What an agent with these needs is called in a refusal. */
function needsLabel(needs: AgentNeeds): string {
  if (needs.coding) {
    return "a coding agent";
  }
  return needs.browser ? "a browser agent" : "an agent";
}

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

/**
 * The machine an agent goes on, locked with the organisation's other machines: the one named, or
 * the organisation's only machine when none is. Refuses a machine below the agent's minimum.
 */
export async function placementMachine(
  client: Queryable,
  orgId: string,
  machineId: string | null | undefined,
  needs: AgentNeeds,
): Promise<MachineRow> {
  const rows = (
    await client.query<MachineQueryRow>(
      `SELECT ${MACHINE_COLUMNS} FROM machines WHERE org_id = $1 ORDER BY created_at, name FOR UPDATE`,
      [orgId],
    )
  ).rows;
  let row: MachineQueryRow | undefined;
  if (machineId) {
    row = rows.find((item) => item.id === machineId);
    if (!row) {
      throw new MachineError(422, "machine_id names no machine of this organisation");
    }
  } else if (rows.length === 1) {
    row = rows[0];
  }
  if (!row) {
    throw new MachineError(
      422,
      rows.length
        ? "machine_id is required: the organisation has more than one machine"
        : "the organisation has no machine",
    );
  }
  const machine = machineFromRow(row);
  if (!sizeMeets(machineSize(machine), agentMinimum(needs))) {
    throw new MachineError(
      422,
      `${belowMinimumMessage(needsLabel(needs), needs, machine)}. Pick a larger machine, or resize ${machine.name} under Settings, Machines`,
    );
  }
  return machine;
}

/** The lowest slot free on a machine, under `ceiling` agents; a full machine is refused. */
export async function freeSlot(
  client: Queryable,
  machine: MachineRow,
  ceiling: number | undefined,
): Promise<number> {
  const taken = (
    await client.query<{ machine_slot: number }>(
      `SELECT machine_slot FROM agents WHERE machine_id = $1`,
      [machine.id],
    )
  ).rows.map((row) => row.machine_slot);
  const slot = lowestFreeSlot(taken, ceiling);
  if (slot === null) {
    throw new MachineError(409, `machine ${machine.name} is full`);
  }
  return slot;
}

/** One machine of the organisation, locked for the rest of the transaction; null when it has none such. */
async function lockMachine(
  client: Queryable,
  orgId: string,
  machineId: string,
): Promise<MachineRow | null> {
  const row =
    (
      await client.query<MachineQueryRow>(
        `SELECT ${MACHINE_COLUMNS} FROM machines WHERE org_id = $1 AND id = $2 FOR UPDATE`,
        [orgId, machineId],
      )
    ).rows[0] ?? null;
  return row ? machineFromRow(row) : null;
}

/** The organisation's machines, oldest first, each with the agents on it. */
export async function listMachines(pool: Queryable, orgId: string): Promise<MachineWithAgents[]> {
  const result = await pool.query<MachineWithAgentsQueryRow>(
    `${MACHINES_WITH_AGENTS} WHERE m.org_id = $1 ORDER BY m.created_at, m.name`,
    [orgId],
  );
  return result.rows.map(machineWithAgents);
}

/** One machine of the organisation with the agents on it. */
export async function getMachineWithAgents(
  pool: Queryable,
  orgId: string,
  machineId: string,
): Promise<MachineWithAgents | null> {
  const row =
    (
      await pool.query<MachineWithAgentsQueryRow>(
        `${MACHINES_WITH_AGENTS} WHERE m.org_id = $1 AND m.id = $2`,
        [orgId, machineId],
      )
    ).rows[0] ?? null;
  return row ? machineWithAgents(row) : null;
}

export async function getMachine(
  pool: Queryable,
  orgId: string,
  machineId: string,
): Promise<MachineRow | null> {
  const row =
    (
      await pool.query<MachineQueryRow>(
        `SELECT ${MACHINE_COLUMNS} FROM machines WHERE org_id = $1 AND id = $2`,
        [orgId, machineId],
      )
    ).rows[0] ?? null;
  return row ? machineFromRow(row) : null;
}

export async function countMachineAgents(pool: Queryable, machineId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM agents WHERE machine_id = $1`,
    [machineId],
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * Adds a machine to the organisation. With a `cap`, the machines are counted under the
 * organisation's lock and a full organisation is refused with the cap's error.
 */
export async function insertMachine(
  pool: Queryable,
  orgId: string,
  machine: MachineInput,
  now: Date,
  cap: HeldCap | null = null,
): Promise<MachineRow> {
  try {
    return await withTransaction(pool, async (client) => {
      await client.query(`SELECT 1 FROM orgs WHERE id = $1 FOR UPDATE`, [orgId]);
      if (cap !== null) {
        const count = await client.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM machines WHERE org_id = $1`,
          [orgId],
        );
        if ((count.rows[0]?.count ?? 0) >= cap.max) {
          throw cap.refuse();
        }
      }
      const row =
        (
          await client.query<MachineQueryRow>(
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
          )
        ).rows[0] ?? null;
      if (!row) {
        throw new RowMissing("machine insert failed");
      }
      return machineFromRow(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new MachineError(409, `${machine.name} is already a machine of this organisation`);
    }
    throw error;
  }
}

/**
 * Changes a machine's name, tier, size, or disk cap. A size below the minimum of an agent on the
 * machine is refused. Returns the machine before and after the change.
 */
export async function updateMachine(
  pool: Queryable,
  orgId: string,
  machineId: string,
  machine: MachineInput,
  now: Date,
): Promise<{ before: MachineRow; after: MachineRow } | null> {
  try {
    return await withTransaction(pool, async (client) => {
      const current = await lockMachine(client, orgId, machineId);
      if (current === null) {
        return null;
      }
      const hosted = (
        await client.query<AgentNeeds>(
          `SELECT COALESCE((config->>'browser')::boolean, FALSE) AS browser,
                  COALESCE((config->>'coding')::boolean, FALSE) AS coding
             FROM agents WHERE machine_id = $1`,
          [machineId],
        )
      ).rows;
      const minimum = agentsMinimum(hosted);
      if (hosted.length && !sizeMeets(machineSize(machine), minimum)) {
        throw new MachineError(
          409,
          `this machine's agents need at least ${sizeLabel(minimum)}; move them or turn their browser or coding off first`,
        );
      }
      const row =
        (
          await client.query<MachineQueryRow>(
            `UPDATE machines
                SET name = $3, box = $4, cpu = $5, memory_mib = $6, max_workspace_mib = $7, updated_at = $8
              WHERE org_id = $1 AND id = $2
              RETURNING ${MACHINE_COLUMNS}`,
            [
              orgId,
              machineId,
              machine.name,
              machine.box,
              machine.cpu,
              machine.memory_mib,
              machine.max_workspace_mib,
              stamp(now),
            ],
          )
        ).rows[0] ?? null;
      if (!row) {
        throw new RowMissing("machine update failed");
      }
      return { before: current, after: machineFromRow(row) };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new MachineError(409, `${machine.name} is already a machine of this organisation`);
    }
    throw error;
  }
}

/**
 * Deletes a machine no agent sits on. One that still hosts agents is refused, and so is the
 * organisation's last machine.
 */
export async function deleteMachine(
  pool: Queryable,
  orgId: string,
  machineId: string,
): Promise<MachineRow | null> {
  return withTransaction(pool, async (client) => {
    await client.query(`SELECT 1 FROM orgs WHERE id = $1 FOR UPDATE`, [orgId]);
    const current = await lockMachine(client, orgId, machineId);
    if (current === null) {
      return null;
    }
    const hosted = await client.query(`SELECT 1 FROM agents WHERE machine_id = $1 LIMIT 1`, [
      machineId,
    ]);
    if (hosted.rowCount) {
      throw new MachineError(409, "agents are on this machine; move or delete them first");
    }
    const others = await client.query(
      `SELECT 1 FROM machines WHERE org_id = $1 AND id <> $2 LIMIT 1`,
      [orgId, machineId],
    );
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
export async function moveAgent(
  pool: Queryable,
  agentId: string,
  machineId: string,
  options: { maxAgentsPerMachine?: number | null; needs?: AgentNeeds } = {},
): Promise<MoveAgentResult | null> {
  return withTransaction(pool, async (client) => {
    const agent =
      (
        await client.query<{
          org_id: string;
          config: Record<string, unknown>;
          machine_id: string;
          machine_slot: number;
        }>(`SELECT org_id, config, machine_id, machine_slot FROM agents WHERE id = $1 FOR UPDATE`, [
          agentId,
        ])
      ).rows[0] ?? null;
    if (!agent) {
      return null;
    }
    const from = { machineId: agent.machine_id, slot: agent.machine_slot };
    if (from.machineId === machineId) {
      return { from, to: from };
    }
    const needs = options.needs ?? {
      browser: agent.config.browser === true,
      coding: agent.config.coding === true,
    };
    const machine = await placementMachine(client, agent.org_id, machineId, needs);
    const slot = await freeSlot(client, machine, options.maxAgentsPerMachine ?? undefined);
    await client.query(`UPDATE agents SET machine_id = $2, machine_slot = $3 WHERE id = $1`, [
      agentId,
      machine.id,
      slot,
    ]);
    return { from, to: { machineId: machine.id, slot } };
  });
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
