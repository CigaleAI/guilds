import { hiddenGuildsFor } from "../db/guilds.js";
import type { Queryable } from "../db/pg.js";
import { NO_HIDDEN_GUILDS, type ArtifactActor, type HiddenGuilds } from "./types.js";
import type { UserRow } from "../db/users.js";

/**
 * The operator an actor stands for: their organisation, their id and name, the guild and agent the
 * action names, and the private guilds hidden from them.
 */
export type OperatorIdentity = {
  orgId: string;
  actorId: string;
  actorName: string;
  guildId?: string | null;
  agentId?: string | null;
  hidden?: HiddenGuilds;
};

export function operatorActor(args: OperatorIdentity): ArtifactActor {
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

/** The agent an actor stands for: its organisation, guild, id and name, and the run it acts in, when one does. */
export type AgentIdentity = {
  orgId: string;
  guildId: string;
  agentId: string;
  agentName: string;
  runId?: string;
};

export function agentActor(args: AgentIdentity): ArtifactActor {
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

/** The scope an operator acts in: their organisation, and the guild and agent the action names. */
export type OperatorScope = { orgId: string; guildId?: string | null; agentId?: string | null };

/** The user as an artifact actor in `scope`, with the private guilds they do not operate hidden from them. */
export async function loadOperatorActor(
  db: Queryable,
  user: UserRow,
  scope: OperatorScope,
): Promise<ArtifactActor> {
  return operatorActor({
    orgId: scope.orgId,
    actorId: user.id,
    actorName: user.name,
    guildId: scope.guildId ?? null,
    agentId: scope.agentId ?? null,
    hidden: await hiddenGuildsFor(db, scope.orgId, user.id),
  });
}
