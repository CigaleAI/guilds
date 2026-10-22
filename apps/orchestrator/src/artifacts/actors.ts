import { NO_HIDDEN_GUILDS, type ArtifactActor, type HiddenGuilds } from "./types.js";

export function operatorActor(args: {
  orgId: string;
  actorId: string;
  actorName: string;
  guildId?: string | null;
  agentId?: string | null;
  hidden?: HiddenGuilds;
}): ArtifactActor {
  return {
    orgId: args.orgId,
    guildId: args.guildId ?? null,
    agentId: args.agentId ?? null,
    operator: true,
    hidden: args.hidden ?? NO_HIDDEN_GUILDS,
    actorType: "user",
    actorId: args.actorId,
    actorName: args.actorName,
    toolCall: null,
  };
}

export function agentActor(args: {
  orgId: string;
  guildId: string;
  agentId: string;
  agentName: string;
  runId?: string;
}): ArtifactActor {
  return {
    orgId: args.orgId,
    guildId: args.guildId,
    agentId: args.agentId,
    operator: false,
    hidden: NO_HIDDEN_GUILDS,
    actorType: args.runId ? "run" : "agent",
    actorId: args.runId ?? args.agentId,
    actorName: args.agentName,
    toolCall: null,
  };
}
