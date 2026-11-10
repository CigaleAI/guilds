// An edit request as the operator reads and answers it from a Studio session's log: its view, and
// the apply or decline that resolves it.

import { hiddenGuildsFor } from "../db/guilds.js";
import type { Queryable } from "../db/pg.js";
import { updateStudioSession, type StudioSessionRow } from "../db/studio.js";
import type { UserRow } from "../db/users.js";
import type { RoutineChange } from "../schedules/operator.js";
import { isAccessTool } from "./access.js";
import {
  applyEdit,
  editStatus,
  findEditRecord,
  markEdit,
  viewEdit,
  type AppliedEdit,
  type EditDeps,
  type EditRecord,
  type EditScope,
  type StudioEditView,
} from "./edits.js";
import { StudioConflictError, StudioUnprocessableError } from "./errors.js";
import { withLockedSession } from "./session-lock.js";
import { assertLive, listSessionMessages, sourceGuildSnapshot, type LiveStudioSession } from "./session.js";

/** What applying an edit request writes through, and the source guild's channels its change is announced on. */
export type EditAnswerDeps = EditDeps & {
  publishFilesChanged?: ((guildId: string) => Promise<void>) | undefined;
  publishRoutinesChanged?: ((guildId: string, change: RoutineChange) => Promise<void>) | undefined;
};

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

/**
 * The edit request at `seq` of the session's log, read while the caller holds the session's lock,
 * which serialises answers so a request is answered once; StudioConflictError when it is already
 * answered.
 */
async function loadPendingEdit(db: Queryable, sessionId: string, seq: number): Promise<EditRecord> {
  const record = await loadEditRecord(db, sessionId, seq);
  if (editStatus(record) !== "pending") {
    throw new StudioConflictError(`edit request is already ${editStatus(record)}`);
  }
  return record;
}

/**
 * Carries an applied edit past its target: a guild edit into the session's record of its guild, a
 * routine edit onto the guild's routine channel, and any other edit but an access one onto its
 * files channel.
 */
export async function propagateAppliedEdit(
  deps: EditAnswerDeps,
  session: LiveStudioSession,
  record: EditRecord,
  applied: AppliedEdit,
): Promise<void> {
  if (applied.guild) {
    await updateStudioSession(
      deps.db,
      session.id,
      { source_guild_snapshot: sourceGuildSnapshot(applied.guild) },
      new Date(),
    );
  } else if (applied.routine) {
    await deps.publishRoutinesChanged?.(session.source_guild_id, applied.routine);
  } else if (!isAccessTool(record.toolName) && deps.publishFilesChanged) {
    await deps.publishFilesChanged(session.source_guild_id);
  }
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

/** Applies the pending edit request at `seq` of a live session's log as `user`, and announces it; the request as it stands after. */
export async function applyEditRequest(
  deps: EditAnswerDeps,
  session: StudioSessionRow,
  user: UserRow,
  seq: number,
): Promise<StudioEditView> {
  assertLive(session);
  const scope = await editScope(deps.db, session, user);
  const outcome = await withLockedSession(deps.db, session.id, async () => {
    const record = await loadPendingEdit(deps.db, session.id, seq);
    const applied = await applyEdit(deps, scope, record);
    await markEdit(deps.db, session.id, record, { status: "applied", version: applied.version, userId: user.id });
    return { record, applied };
  });
  await propagateAppliedEdit(deps, session, outcome.record, outcome.applied);
  return viewEdit(deps, scope, await loadEditRecord(deps.db, session.id, seq));
}

/** Declines the pending edit request at `seq` of a live session's log as `user`; the request as it stands after. */
export async function declineEditRequest(
  deps: EditDeps,
  session: StudioSessionRow,
  user: UserRow,
  seq: number,
): Promise<StudioEditView> {
  assertLive(session);
  const scope = await editScope(deps.db, session, user);
  await withLockedSession(deps.db, session.id, async () => {
    const record = await loadPendingEdit(deps.db, session.id, seq);
    await markEdit(deps.db, session.id, record, { status: "declined", version: null, userId: user.id });
  });
  return viewEdit(deps, scope, await loadEditRecord(deps.db, session.id, seq));
}
