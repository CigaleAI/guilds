// A Studio session as every Studio module reads it: its conversation, and what the sessions spent.

import {
  conversationUsageByOrg,
  listConversationMessages,
  type ConversationMessageRow,
  type ConversationUsageRow,
} from "../db/conversations.js";
import type { Queryable } from "../db/pg.js";
import type { StudioSessionRow } from "../db/studio.js";

/** The session's conversation, in order. */
export async function listSessionMessages(
  db: Queryable,
  sessionId: StudioSessionRow["id"],
): Promise<ConversationMessageRow[]> {
  return listConversationMessages(db, "studio", sessionId);
}

/** What Studio sessions spent, per organisation. */
export async function studioUsageByOrg(db: Queryable): Promise<Map<string, ConversationUsageRow>> {
  return conversationUsageByOrg(db, "studio");
}
