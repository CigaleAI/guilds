import type { GuildAgentRow } from "../db/agents.js";
import type { GroupMessageRow } from "../db/group-chat.js";
import type { RecipientRouting } from "../db/schema/index.js";
import {
  recipientNamesAfter,
  taggedRecipientNamesAfter,
  type RecipientMessage,
} from "../groupchat/recipients.js";
import { serializeRecipientDecision } from "../groupchat/router.js";
import { AGENT_TASK_PREVIEW_CHARS, createGroupRouter, type GroupRouterOptions } from "./group.js";

export class ReplayMessageNotFoundError extends Error {
  constructor(seq: number) {
    super(`no public message with seq ${seq}`);
    this.name = "ReplayMessageNotFoundError";
  }
}

export type RecipientReplay = {
  seq: number;
  author: string;
  content: string;
  offered: Array<{ name: string; focus: string; task_chars: number }>;
  rule_names: string[];
  decision: RecipientRouting;
  would_wake: string[];
};

/** A public message as the replay offers it: what the recipient rules read, its author, its text. */
type ReplayMessage = RecipientMessage &
  Pick<GroupMessageRow, "author_name" | "content" | "tagged_names">;

/** A guild member as the replay offers it to the Choice. */
type ReplayMember = Pick<GuildAgentRow, "id" | "name" | "focus" | "task">;

/** A guild's group chat as the replay reads it: its public messages and its members. */
export type ReplayTranscript = {
  rows: GroupMessageRow[];
  members: ReplayMember[];
};

/**
 * The message a replay re-runs: the public message at `seq` (the last one when unset), or, given
 * `message`, a hypothetical user post of that text right after it.
 */
export type ReplayTarget = {
  seq?: number;
  message?: string;
};

// Re-run the recipient Choice for one public message as the dispatcher would
// have seen it: every member except the author is offered (a user post
// makes everyone pending; an agent post everyone but the author), and the tag
// rules for just that message stand in for the low-confidence fallback.
export async function replayRecipients(
  transcript: ReplayTranscript,
  router: GroupRouterOptions,
  target: ReplayTarget = {},
): Promise<RecipientReplay> {
  const ordered = [...transcript.rows].sort((left, right) => left.seq - right.seq);
  const targetSeq = target.seq ?? ordered[ordered.length - 1]?.seq ?? 0;
  const through: ReplayMessage[] = ordered.filter((row) => row.seq <= targetSeq);
  // A hypothetical user post after the chosen point in the transcript.
  const row: ReplayMessage | undefined =
    target.message === undefined
      ? through[through.length - 1]
      : {
          seq: targetSeq + 1,
          author_type: "user",
          author_name: "user",
          author_agent_id: null,
          content: target.message,
          tagged_names: [],
          tagged_agent_ids: [],
        };
  if (row === undefined) {
    throw new ReplayMessageNotFoundError(targetSeq);
  }
  if (target.message !== undefined) {
    through.push(row);
  }
  const pending = transcript.members.filter(
    (member) => !(row.author_type === "agent" && member.id === row.author_agent_id),
  );
  const deliveredThrough = row.seq - 1;
  const ruleNames = recipientNamesAfter(through, transcript.members, deliveredThrough);
  const tagged = taggedRecipientNamesAfter(through, transcript.members, deliveredThrough);
  const decision = await createGroupRouter(router).recipients({
    rows: through,
    members: transcript.members,
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
  lines.push(`decision: source=${decision.source} choice=${decision.choice ?? "-"}`);
  if (decision.confidence !== undefined) {
    lines.push(`  confidence ${decision.confidence.toFixed(3)} (model ${decision.model ?? "?"})`);
  }
  if (decision.probabilities) {
    const ranked = Object.entries(decision.probabilities).sort((left, right) => right[1] - left[1]);
    lines.push("  probabilities:");
    for (const [name, value] of ranked) {
      lines.push(`    ${name.padEnd(24)} ${value.toFixed(3)}`);
    }
  }
  if (decision.reason) {
    lines.push(`  reason: ${decision.reason}`);
  }
  lines.push(`tag rules alone would wake: ${report.rule_names.join(", ") || "(nobody)"}`);
  lines.push(`with this decision, wakes: ${report.would_wake.join(", ") || "(nobody)"}`);
  return `${lines.join("\n")}\n`;
}
