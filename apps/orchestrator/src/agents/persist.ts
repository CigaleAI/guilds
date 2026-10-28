import type { AgentConfig } from "../db/schema/index.js";
import { DEFAULT_AVATAR_COLOR, DEFAULT_AVATAR_SHAPE } from "./validation.js";
import type { ArtifactActor, ArtifactStore } from "../artifacts/index.js";
import { operatorActor } from "../artifacts/actors.js";
import { FALLBACK_TASK, FALLBACK_TASK_HASH, hashTaskContent, resolveTaskContent, taskDisplayPath } from "./task.js";
import {
  deleteAgent,
  guildHasOperatorNamed,
  insertAgent,
  type AgentPlacement,
  type NewAgent,
} from "../db/agents.js";
import { GuildNameTaken, RowMissing } from "../db/errors.js";
import { recordFileChange } from "../db/file-changes.js";
import { getGuild } from "../db/guilds.js";
import { bindQuery, type Queryable, withTransaction } from "../db/pg.js";
import { freeSlot, placementMachine } from "../machines/placement.js";
import { ensureAgentRows } from "../artifacts/memory.js";

export type AgentNotes = {
  createAgent(
    orgSlug: string,
    guildName: string,
    name: string,
    task?: string,
  ): Promise<void>;
};

/**
 * Adds an agent to its guild, on the machine `placement` names or else the organisation's only
 * one, in the lowest free slot there. With `actor`, its task's creation is logged against it.
 */
export async function addAgent(
  db: Queryable,
  agent: NewAgent,
  now: Date,
  actor?: ArtifactActor,
  placement: AgentPlacement = {},
): Promise<void> {
  await withTransaction(db, async (client) => {
    if (await guildHasOperatorNamed(client, agent.guildId, agent.name)) {
      throw new GuildNameTaken(agent.name, "operator");
    }
    const guild = await getGuild(client, agent.guildId);
    if (!guild) {
      throw new RowMissing("agent insert failed: guild not found");
    }
    const machine = await placementMachine(client, guild.org_id, placement.machineId, {
      browser: agent.config.browser === true,
      coding: agent.config.coding === true,
    });
    const slot = await freeSlot(client, machine, placement.maxAgentsPerMachine ?? undefined);
    const inserted = await insertAgent(
      client,
      {
        ...agent,
        task: agent.task ?? FALLBACK_TASK,
        taskHash: agent.taskHash ?? FALLBACK_TASK_HASH,
        machineId: machine.id,
        machineSlot: slot,
      },
      now,
    );
    if (actor) {
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

/** The db/ functions a new agent is written through, on `db`. */
export function agentDatabase(db: Queryable) {
  return {
    addAgent: bindQuery(db, addAgent),
    deleteAgent: bindQuery(db, deleteAgent),
  };
}

export type AgentDatabase = ReturnType<typeof agentDatabase>;

export async function persistAgent(
  db: AgentDatabase,
  notes: AgentNotes,
  args: {
    agentId: string;
    guildId: string;
    guildName: string;
    orgSlug: string;
    name: string;
    config: AgentConfig;
    now: Date;
    focus?: string;
    wakeTriggers?: string;
    task?: string;
    avatarShape?: string;
    avatarColor?: string;
    orgId?: string;
    artifacts?: ArtifactStore | null;
    actor?: ArtifactActor | null;
    /** The machine the agent goes on; the organisation's only one when absent. */
    machineId?: string | null;
    /** The policy's cap on agents per machine; core's ceiling alone when absent. */
    maxAgentsPerMachine?: number | null;
  },
): Promise<void> {
  const task = resolveTaskContent(args.task ?? args.focus ?? "", args.artifacts?.templatesRoot ?? "");
  const taskHash = hashTaskContent(task);
  const actor = args.orgId
    ? (args.actor ??
      operatorActor({
        orgId: args.orgId,
        actorId: "system",
        actorName: "system",
        guildId: args.guildId,
        agentId: args.agentId,
      }))
    : null;
  await db.addAgent(
    {
      agentId: args.agentId,
      guildId: args.guildId,
      name: args.name,
      config: args.config,
      focus: args.focus ?? "",
      wakeTriggers: args.wakeTriggers ?? "",
      avatarShape: args.avatarShape ?? DEFAULT_AVATAR_SHAPE,
      avatarColor: args.avatarColor ?? DEFAULT_AVATAR_COLOR,
      task,
      taskHash,
    },
    args.now,
    actor ?? undefined,
    {
      machineId: args.machineId ?? null,
      maxAgentsPerMachine: args.maxAgentsPerMachine ?? null,
    },
  );
  try {
    if (args.artifacts && actor) {
      await ensureAgentRows(args.artifacts, {
        orgId: actor.orgId,
        guildId: args.guildId,
        agentId: args.agentId,
        actor,
      });
    } else {
      await notes.createAgent(args.orgSlug, args.guildName, args.name, args.focus ?? "");
    }
  } catch (error) {
    await db.deleteAgent(args.agentId);
    throw error;
  }
}
