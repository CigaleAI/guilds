import { recipientNamesAfter, taggedRecipientNamesAfter } from "../groupchat/index.js";
import {
  AGENT_TASK_PREVIEW_CHARS,
  createGroupRouter,
  serializeRecipientDecision,
} from "./group.js";
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

// Re-run the recipient Choice for one public message as the dispatcher would
// have seen it: every member except the author is offered (a user post
// makes everyone pending; an agent post everyone but the author), and the tag
// rules for just that message stand in for the low-confidence fallback.
export async function replayRecipients(args: {
  rows: Array<Record<string, unknown>>;
  members: Array<Record<string, unknown>>;
  client: TypeSafeClient;
  seq?: number;
  message?: string;
  confidenceMin?: number;
}): Promise<RecipientReplay> {
  const ordered = [...args.rows].sort((left, right) => Number(left.seq) - Number(right.seq));
  const targetSeq = args.seq ?? Number(ordered[ordered.length - 1]?.seq ?? 0);
  const through = ordered.filter((row) => Number(row.seq) <= targetSeq);
  let latest = through[through.length - 1];
  if (!latest && args.message === undefined) {
    throw new Error(`no public message with seq ${targetSeq}`);
  }
  if (args.message !== undefined) {
    // A hypothetical user post after the chosen point in the transcript.
    latest = {
      seq: targetSeq + 1,
      author_type: "user",
      author_name: "user",
      author_agent_id: null,
      content: args.message,
      tagged_names: [],
      tagged_agent_ids: [],
    };
    through.push(latest);
  }
  const row = latest as Record<string, unknown>;
  const pending = args.members.filter(
    (member) => !(row.author_type === "agent" && String(member.id) === String(row.author_agent_id)),
  );
  const deliveredThrough = Number(row.seq) - 1;
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
    name: String(member.name),
    focus: String(member.focus ?? "").trim(),
    task_chars: Math.min(String(member.task ?? "").trim().length, AGENT_TASK_PREVIEW_CHARS),
  }));
  const pendingNames = new Set(offered.map((member) => member.name));
  return {
    seq: Number(row.seq),
    author: String(row.author_name || row.author_type),
    content: String(row.content ?? ""),
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
