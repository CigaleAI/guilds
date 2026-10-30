import type { ArtifactActor } from "../artifacts/types.js";
import type { EditScope } from "./edits.js";
import { operatorActor, type OperatorIdentity } from "../artifacts/actors.js";

/** The guild and agent a Studio edit acts in; left out, the source guild and no agent. */
export type EditPlacement = Pick<OperatorIdentity, "guildId" | "agentId">;

/**
 * The operator a Studio edit reads and writes as. While an edit is applied,
 * `scope.origin` names the coach message it came from, and every change the
 * write records links there.
 */
export function editActor(scope: EditScope, placement: EditPlacement = {}): ArtifactActor {
  const actor = operatorActor({
    orgId: scope.orgId,
    actorId: scope.user.id,
    actorName: scope.user.name ?? "operator",
    guildId: placement.guildId ?? scope.sourceGuildId,
    agentId: placement.agentId ?? null,
  });
  return scope.origin ? { ...actor, studio: scope.origin } : actor;
}
