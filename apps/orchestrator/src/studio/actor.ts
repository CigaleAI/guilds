import type { ArtifactActor } from "../artifacts/types.js";
import type { EditScope } from "./edits.js";
import { operatorContext } from "../artifacts/store.js";

/**
 * The operator a Studio edit reads and writes as. While an edit is applied,
 * `scope.origin` names the coach message it came from, and every change the
 * write records links there.
 */
export function editActor(
  scope: EditScope,
  extra: { guildId?: string | null; agentId?: string | null } = {},
): ArtifactActor {
  const actor = operatorContext(
    scope.orgId,
    String(scope.user.id),
    String(scope.user.name ?? "operator"),
    {
      guildId: extra.guildId ?? scope.sourceGuildId,
      agentId: extra.agentId ?? null,
    },
  );
  return scope.origin ? { ...actor, studio: scope.origin } : actor;
}
