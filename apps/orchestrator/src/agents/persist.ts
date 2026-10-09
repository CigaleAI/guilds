import {
  DEFAULT_AVATAR_COLOR,
  DEFAULT_AVATAR_SHAPE,
  type AgentConfig,
} from "./validation.js";
import type { ArtifactActor, ArtifactStore } from "../artifacts/index.js";
import { operatorActor } from "../artifacts/grants.js";
import { hashTaskContent, resolveTaskContent } from "./task.js";

export type AgentNotes = {
  createAgent(
    orgSlug: string,
    guildName: string,
    name: string,
    task?: string,
  ): Promise<void>;
};

export type AgentDatabase = {
  insertAgent(
    agentId: string,
    guildId: string,
    name: string,
    config: AgentConfig | Record<string, unknown>,
    now: Date,
    focus: string,
    wakeTriggers: string,
    avatarShape: string,
    avatarColor: string,
    task?: string,
    taskHash?: string,
    actor?: ArtifactActor,
  ): Promise<void>;
  deleteAgent(agentId: string): Promise<void>;
};

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
    args.agentId,
    args.guildId,
    args.name,
    args.config,
    args.now,
    args.focus ?? "",
    args.wakeTriggers ?? "",
    args.avatarShape ?? DEFAULT_AVATAR_SHAPE,
    args.avatarColor ?? DEFAULT_AVATAR_COLOR,
    task,
    taskHash,
    actor ?? undefined,
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
