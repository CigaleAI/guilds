// A Studio session as every Studio module reads it: its conversation.

import { listConversationMessages, type ConversationMessageRow } from "../db/conversations.js";
import type { Queryable } from "../db/pg.js";
import type { StudioSessionRow } from "../db/studio.js";

/** The session's conversation, in order. */
export async function listSessionMessages(
  db: Queryable,
  sessionId: StudioSessionRow["id"],
): Promise<ConversationMessageRow[]> {
  return listConversationMessages(db, "studio", sessionId);
}
