import type { GuildAgentRow } from "../db/agents.js";
import type { GroupMessageRow } from "../db/group-chat.js";
import {
  recipientNamesAfter,
  taggedRecipientNamesAfter,
  type RecipientMessage,
} from "../groupchat/recipients.js";
import { serializeRecipientDecision } from "../groupchat/router.js";
import { AGENT_TASK_PREVIEW_CHARS, createGroupRouter } from "./group.js";
import type { TypeSafeClient } from "./client.js";

export type RecipientReplay = {
  seq: number;
  author: string;
  content: string;
  offered: Array<{ name: string; focus: string; task_chars: number }>;
  rule_names: string[];
  decision: Record<string, unknown>;
  would_wake: string[];
};

/** A public message as the replay offers it: what the recipient rules read, its author, its text. */
type ReplayMessage = RecipientMessage &
  Pick<GroupMessageRow, "author_name" | "content" | "tagged_names">;

/** A guild member as the replay offers it to the Choice. */
type ReplayMember = Pick<GuildAgentRow, "id" | "name" | "focus" | "task">;

// Re-run the recipient Choice for one public message as the dispatcher would
// have seen it: every member except the author is offered (a user post
// makes everyone pending; an agent post everyone but the author), and the tag
// rules for just that message stand in for the low-confidence fallback.
export async function replayRecipients(args: {
  rows: GroupMessageRow[];
  members: ReplayMember[];
  client: TypeSafeClient;
  seq?: number;
  message?: string;
  confidenceMin?: number;
}): Promise<RecipientReplay> {
  const ordered = [...args.rows].sort((left, right) => left.seq - right.seq);
  const targetSeq = args.seq ?? ordered[ordered.length - 1]?.seq ?? 0;
  const through: ReplayMessage[] = ordered.filter((row) => row.seq <= targetSeq);
  // A hypothetical user post after the chosen point in the transcript.
  const row: ReplayMessage | undefined =
    args.message === undefined
      ? through[through.length - 1]
      : {
          seq: targetSeq + 1,
          author_type: "user",
          author_name: "user",
          author_agent_id: null,
          content: args.message,
          tagged_names: [],
          tagged_agent_ids: [],
        };
  if (row === undefined) {
    throw new Error(`no public message with seq ${targetSeq}`);
  }
  if (args.message !== undefined) {
    through.push(row);
  }
  const pending = args.members.filter(
    (member) => !(row.author_type === "agent" && member.id === row.author_agent_id),
  );
  const deliveredThrough = row.seq - 1;
  const ruleNames = recipientNamesAfter(through, args.members, deliveredThrough);
  const tagged = taggedRecipientNamesAfter(through, args.members, deliveredThrough);
  const router = createGroupRouter({
    client: args.client,
    ...(args.confidenceMin !== undefined ? { confidenceMin: args.confidenceMin } : {}),
  });
  const decision = await router.recipients({
    rows: through,
    members: args.members,
    pending,
    taggedNames: tagged,
    ruleNames,
  });
  const offered = pending.map((member) => ({
    name: member.name,
    focus: member.focus.trim(),
    task_chars: Math.min(member.task.trim().length, AGENT_TASK_PREVIEW_CHARS),
  }));
  const pendingNames = new Set(offered.map((member) => member.name));
  return {
    seq: row.seq,
    author: row.author_name || row.author_type,
    content: row.content,
    offered,
    rule_names: [...ruleNames].sort(),
    decision: serializeRecipientDecision(decision),
    would_wake: [...decision.names].filter((name) => pendingNames.has(name)).sort(),
  };
}

export function formatRecipientReplay(report: RecipientReplay): string {
  const lines: string[] = [];
  const preview = report.content.replace(/\s+/g, " ").trim();
  lines.push(`message seq ${report.seq} from ${report.author}:`);
  lines.push(`  ${preview.length > 200 ? `${preview.slice(0, 200)}…` : preview}`);
  lines.push("offered to Jev:");
  for (const member of report.offered) {
    const focus = member.focus ? ` — ${member.focus}` : "";
    lines.push(`  ${member.name}${focus} (task preview ${member.task_chars} chars)`);
  }
  const decision = report.decision;
  lines.push(
    `decision: source=${String(decision.source)} choice=${String(decision.choice ?? "-")}`,
  );
  if (decision.confidence !== undefined) {
    lines.push(
      `  confidence ${Number(decision.confidence).toFixed(3)} (model ${String(decision.model ?? "?")})`,
    );
  }
  const probabilities = decision.probabilities as Record<string, number> | undefined;
  if (probabilities) {
    const ranked = Object.entries(probabilities).sort((left, right) => right[1] - left[1]);
    lines.push("  probabilities:");
    for (const [name, value] of ranked) {
      lines.push(`    ${name.padEnd(24)} ${value.toFixed(3)}`);
    }
  }
  if (decision.reason) {
    lines.push(`  reason: ${String(decision.reason)}`);
  }
  lines.push(`tag rules alone would wake: ${report.rule_names.join(", ") || "(nobody)"}`);
  lines.push(`with this decision, wakes: ${report.would_wake.join(", ") || "(nobody)"}`);
  return `${lines.join("\n")}\n`;
}
