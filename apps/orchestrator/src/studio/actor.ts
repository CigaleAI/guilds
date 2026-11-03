import type { ArtifactActor, HiddenGuilds } from "../artifacts/types.js";
import type { UserRow } from "../db/users.js";
import type { EditScope } from "./edits.js";
import { operatorActor, type OperatorIdentity } from "../artifacts/actors.js";

/**
 * The operator a Studio session reads and writes as: the session's user, in its organisation and
 * source guild, with the private guilds of the organisation they do not operate hidden from them.
 */
export type StudioOperator = {
  orgId: string;
  sourceGuildId: string;
  user: UserRow;
  hidden: HiddenGuilds;
};

/** The guild and agent a Studio read or edit acts in; left out, the source guild and no agent. */
export type StudioPlacement = Pick<OperatorIdentity, "guildId" | "agentId">;

/**
 * The artifact actor of a Studio read or edit: the session's user with their hidden guilds. While
 * an edit is applied, `scope.origin` names the coach message it came from, and every change the
 * write records links there.
 */
export function studioActor(
  scope: StudioOperator & Pick<EditScope, "origin">,
  placement: StudioPlacement = {},
): ArtifactActor {
  const actor = operatorActor({
    orgId: scope.orgId,
    actorId: scope.user.id,
    actorName: scope.user.name ?? "operator",
    guildId: placement.guildId ?? scope.sourceGuildId,
    agentId: placement.agentId ?? null,
    hidden: scope.hidden,
  });
  return scope.origin ? { ...actor, studio: scope.origin } : actor;
}
