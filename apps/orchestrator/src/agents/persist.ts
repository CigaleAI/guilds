import {
  DEFAULT_AVATAR_COLOR,
  DEFAULT_AVATAR_SHAPE,
  type AgentConfig,
} from "./validation.js";
import type { ArtifactActor, ArtifactStore } from "../artifacts/index.js";
import { operatorActor } from "../artifacts/actors.js";
import { hashTaskContent, resolveTaskContent } from "./task.js";
import { deleteAgent, insertAgent } from "../db/agents.js";
import { bindQuery, type Queryable } from "../db/pg.js";

export type AgentNotes = {
  createAgent(
    orgSlug: string,
    guildName: string,
    name: string,
    task?: string,
  ): Promise<void>;
};

/** The db/ functions a new agent is written through, on `db`. */
export function agentDatabase(db: Queryable) {
  return {
    insertAgent: bindQuery(db, insertAgent),
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
    config: AgentConfig | Record<string, unknown>;
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
  await db.insertAgent(
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
      await args.artifacts.ensureAgentRows({
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
