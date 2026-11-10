// An edit request as the operator reads it from a Studio session's log.

import { hiddenGuildsFor } from "../db/guilds.js";
import type { Queryable } from "../db/pg.js";
import type { StudioSessionRow } from "../db/studio.js";
import type { UserRow } from "../db/users.js";
import { findEditRecord, viewEdit, type EditDeps, type EditRecord, type EditScope, type StudioEditView } from "./edits.js";
import { StudioUnprocessableError } from "./errors.js";
import { listSessionMessages, type LiveStudioSession } from "./session.js";

/** The session's operator `user`, with the private guilds hidden from them now, as an edit is read and applied. */
async function editScope(db: Queryable, session: LiveStudioSession, user: UserRow): Promise<EditScope> {
  return {
    orgId: session.org_id,
    sourceGuildId: session.source_guild_id,
    sessionId: session.id,
    user,
    hidden: await hiddenGuildsFor(db, session.org_id, user.id),
  };
}

/** The edit request at `seq` of the session's log as it stands now. */
async function loadEditRecord(db: Queryable, sessionId: string, seq: number): Promise<EditRecord> {
  return findEditRecord(await listSessionMessages(db, sessionId), seq);
}

/** The edit request at `seq` of the session's log as `user` reviews it; StudioUnprocessableError when its source guild is gone. */
export async function viewEditRequest(
  deps: EditDeps,
  session: StudioSessionRow,
  user: UserRow,
  seq: number,
): Promise<StudioEditView> {
  const sourceGuildId = session.source_guild_id;
  if (!sourceGuildId) {
    throw new StudioUnprocessableError("source guild is gone");
  }
  const record = await loadEditRecord(deps.db, session.id, seq);
  const scope = await editScope(deps.db, { ...session, source_guild_id: sourceGuildId }, user);
  return viewEdit(deps, scope, record);
}
