import type { GroupMessageRow } from "../db/group-chat.js";
import type { RunMessage } from "../db/runs.js";
import type { UserMessage } from "../db/schema/index.js";
import { groupChatHistory, storedTags } from "./history.js";
import { recipientNamesAfter } from "./recipients.js";
import { storedTagAgentIds } from "./tags.js";

function tagsAgent(row: Record<string, unknown>, agentId: string): boolean {
  const selfTag = row.author_type === "agent" && row.author_agent_id === agentId;
  return !selfTag && storedTagAgentIds(row).includes(agentId);
}

/**
 * The public row that woke an agent's group run: the latest row after its
 * cursor that tags it, else the latest operator row that tags no agent, else
 * the latest row after its cursor. Null when no row is after the cursor.
 */
export function wakeMessage(
  rows: Array<Record<string, unknown>>,
  agentId: string,
  deliveredThrough: number,
): Record<string, unknown> | null {
  const unseen = rows.filter((row) => Number(row.seq) > deliveredThrough);
  const tagging = unseen.filter((row) => tagsAgent(row, agentId));
  const broadcast = unseen.filter((row) => row.author_type === "user" && !storedTagAgentIds(row).length);
  return tagging.at(-1) ?? broadcast.at(-1) ?? unseen.at(-1) ?? null;
}

function viewerWasTagged(
  rows: Array<Record<string, unknown>>,
  viewerName: string,
  deliveredThrough: number,
): boolean {
  if (!viewerName) {
    return false;
  }
  for (const row of rows) {
    if (Number(row.seq) <= deliveredThrough) {
      continue;
    }
    if (storedTags(row).includes(viewerName)) {
      return true;
    }
  }
  return false;
}

export function groupChatUserMessage(args: {
  members: Array<Record<string, unknown>>;
  rows: GroupMessageRow[];
  viewerName?: string;
  deliveredThrough?: number;
}): RunMessage {
  const viewerName = args.viewerName ?? "";
  const deliveredThrough = args.deliveredThrough ?? 0;
  const history = groupChatHistory(args.rows);
  const latest = history.length ? history[history.length - 1] : null;
  const info = {
    latestMessage: latest,
    youWereTagged: viewerWasTagged(args.rows, viewerName, deliveredThrough),
  };
  const payload: UserMessage = {
    role: "user",
    content: `Group Chat info: ${JSON.stringify(info, null, 2)}`,
  };
  const last = args.rows.at(-1);
  if (last === undefined) {
    return [payload, { source: "group_chat" }];
  }
  return [
    payload,
    {
      source: "group_chat",
      group_message_id: last.id,
      group_seq: last.seq,
      author_type: last.author_type,
      author_name: last.author_name,
      tagged: latest ? latest.tagged : [],
      you_were_tagged: info.youWereTagged,
      recipients: [...recipientNamesAfter(args.rows, args.members, deliveredThrough)].sort(),
    },
  ];
}
