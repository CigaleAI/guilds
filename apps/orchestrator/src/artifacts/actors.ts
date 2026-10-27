import { hiddenGuildsFor } from "../db/guilds.js";
import type { Queryable } from "../db/pg.js";
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

/** The scope an operator acts in: their organisation, and the guild and agent the action names. */
export type OperatorScope = { orgId: string; guildId?: string | null; agentId?: string | null };

/** The user as an artifact actor in `scope`, with the private guilds they do not operate hidden from them. */
export async function loadOperatorActor(
  db: Queryable,
  user: Record<string, unknown>,
  scope: OperatorScope,
): Promise<ArtifactActor> {
  return operatorActor({
    orgId: scope.orgId,
    actorId: String(user.id),
    actorName: String(user.name ?? "operator"),
    guildId: scope.guildId ?? null,
    agentId: scope.agentId ?? null,
    hidden: await hiddenGuildsFor(db, scope.orgId, String(user.id)),
  });
}
