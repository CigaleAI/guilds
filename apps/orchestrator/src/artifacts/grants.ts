import { deleteAccessRow, upsertAccessRow } from "../db/artifact-access.js";
import type { Queryable } from "../db/pg.js";
import type { AccessGrant, AccessTarget, ArtifactActor } from "./types.js";

/** Writes or replaces the rows of `grants` on an item's access list. */
export async function writeGrants(
  db: Queryable,
  actor: ArtifactActor,
  target: AccessTarget,
  grants: AccessGrant[],
): Promise<void> {
  for (const grant of grants) {
    await upsertAccessRow(db, { ...target, orgId: actor.orgId }, grant, actor);
  }
}

/** Removes the rows of `grants` from an item's access list. */
export async function removeGrants(db: Queryable, target: AccessTarget, grants: AccessGrant[]): Promise<void> {
  for (const grant of grants) {
    await deleteAccessRow(db, target, grant);
  }
}
