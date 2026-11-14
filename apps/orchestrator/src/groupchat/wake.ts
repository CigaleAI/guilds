import type { GroupMessageRow } from "../db/group-chat.js";
import type { RunMessage } from "../db/runs.js";
import type { RunInputMetadata, UserMessage } from "../db/schema/index.js";
import { groupChatHistory, historyItem, replyTargetSeqs, type GroupHistoryItem } from "./history.js";
import {
  recipientNamesAfter,
  type RecipientMember,
  type RecipientMessage,
  type ReplyAuthorRow,
} from "./recipients.js";

function directlyWakesAgent(
  row: RecipientMessage,
  rowsBySeq: ReadonlyMap<number, ReplyAuthorRow>,
  agentId: string,
): boolean {
  if (row.author_type === "agent") {
    return row.author_agent_id !== agentId && row.tagged_agent_ids.includes(agentId);
  }
  if (row.tagged_agent_ids.length > 0) {
    return row.tagged_agent_ids.includes(agentId);
  }
  if (row.reply_to_seq === null || row.reply_to_seq === undefined) {
    return false;
  }
  const target = rowsBySeq.get(Number(row.reply_to_seq));
  return target?.author_type === "agent" && target.author_agent_id === agentId;
}

function isBroadcastRow(row: RecipientMessage, rowsBySeq: ReadonlyMap<number, ReplyAuthorRow>): boolean {
  if (row.author_type !== "user" || row.tagged_agent_ids.length > 0) {
    return false;
  }
  if (row.reply_to_seq === null || row.reply_to_seq === undefined) {
    return true;
  }
  const target = rowsBySeq.get(Number(row.reply_to_seq));
  return !(target?.author_type === "agent" && target.author_agent_id !== null);
}

/**
 * The public row that woke an agent's group run: the latest row after its cursor that directly
 * addresses it (by `@` tag or untagged reply to its post), else the latest broadcast operator row,
 * else the latest row after its cursor. Null when no row is after the cursor.
 */
export function wakeMessage<Row extends RecipientMessage>(
  rows: Row[],
  agentId: string,
  deliveredThrough: number,
): Row | null {
  const bySeq = new Map<number, Row>();
  for (const row of rows) {
    bySeq.set(Number(row.seq), row);
  }
  const unseen = rows.filter((row) => row.seq > deliveredThrough);
  const direct = unseen.filter((row) => directlyWakesAgent(row, bySeq, agentId));
  const broadcast = unseen.filter((row) => isBroadcastRow(row, bySeq));
  return direct.at(-1) ?? broadcast.at(-1) ?? unseen.at(-1) ?? null;
}

function viewerWasTagged(
  rows: Array<Pick<GroupMessageRow, "seq" | "tagged_names">>,
  viewerName: string,
  deliveredThrough: number,
): boolean {
  if (!viewerName) {
    return false;
  }
  for (const row of rows) {
    if (row.seq <= deliveredThrough) {
      continue;
    }
    if (row.tagged_names.includes(viewerName)) {
      return true;
    }
  }
  return false;
}

/** What `Group Chat info` tells a woken group run about the delivery that started it. */
export type GroupChatWakeInfo = {
  latestMessage: GroupHistoryItem | null;
  youWereTagged: boolean;
  replyTo?: GroupHistoryItem;
};

export function groupChatUserMessage(args: {
  members: RecipientMember[];
  rows: GroupMessageRow[];
  viewerName?: string;
  deliveredThrough?: number;
}): RunMessage {
  const viewerName = args.viewerName ?? "";
  const deliveredThrough = args.deliveredThrough ?? 0;
  const history = groupChatHistory(args.rows);
  const latest = history.length ? (history[history.length - 1] ?? null) : null;
  const targetSeq = replyTargetSeqs(args.rows, deliveredThrough)[0];
  const targetRow =
    targetSeq === undefined ? undefined : args.rows.find((row) => Number(row.seq) === targetSeq);
  const info: GroupChatWakeInfo = {
    latestMessage: latest,
    youWereTagged: viewerWasTagged(args.rows, viewerName, deliveredThrough),
    ...(targetRow ? { replyTo: historyItem(targetRow) } : {}),
  };
  const payload: UserMessage = {
    role: "user",
    content: `Group Chat info: ${JSON.stringify(info, null, 2)}`,
  };
  const last = args.rows.at(-1);
  if (last === undefined) {
    return [payload, { source: "group_chat" }];
  }
  const metadata: RunInputMetadata = {
    source: "group_chat",
    group_message_id: last.id,
    group_seq: last.seq,
    ...(targetSeq !== undefined ? { reply_to_seq: targetSeq } : {}),
    author_type: last.author_type,
    author_name: last.author_name,
    tagged: latest ? latest.tagged : [],
    you_were_tagged: info.youWereTagged,
    recipients: [...recipientNamesAfter(args.rows, args.members, deliveredThrough)].sort(),
  };
  return [payload, metadata];
}
