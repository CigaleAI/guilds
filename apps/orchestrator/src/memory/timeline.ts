import { createHash } from "node:crypto";
import { compareColumnTimestamps } from "../db/codecs.js";

// A memory timeline is the ordered list of versions an agent's memory has
// held. Revision rows archive the outgoing body and record who replaced it,
// so revision k holds version k-1 and names the author and time of version
// k. The live row is the newest version. The oldest archived version has no
// recorded author.

export type MemoryTimelineActor = {
  type: "user" | "agent" | "run" | "unknown";
  id: string | null;
  name: string | null;
  detail: string | null;
};

export type MemoryTimelineRevision = {
  id: string;
  content: string;
  display_path: string;
  replaced_at: string;
  replaced_by: { type: "user" | "agent" | "run"; id: string; name: string; detail: string };
};

export type MemoryTimelineEntry = {
  index: number;
  revision_id: string | null;
  archive_display_path: string | null;
  written_at: string | null;
  actor: MemoryTimelineActor;
  run_id: string | null;
  content: string;
  content_hash: string;
  previous_content: string | null;
  stats: { added: number; removed: number };
};

const UNKNOWN_ACTOR: MemoryTimelineActor = { type: "unknown", id: null, name: null, detail: null };

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function nonBlankMemoryLines(text: string): string[] {
  return text
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
}

function lineMultisetDelta(before: string, after: string): { added: number; removed: number } {
  const counts = new Map<string, number>();
  for (const line of nonBlankMemoryLines(before)) counts.set(line, (counts.get(line) ?? 0) - 1);
  for (const line of nonBlankMemoryLines(after)) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  let removed = 0;
  for (const delta of counts.values()) {
    if (delta > 0) added += delta;
    else if (delta < 0) removed -= delta;
  }
  return { added, removed };
}

export function lineChangeStats(before: string, after: string): { added: number; removed: number } {
  return lineMultisetDelta(before, after);
}

function chronologicalRevisions(revisions: MemoryTimelineRevision[]): MemoryTimelineRevision[] {
  return [...revisions].sort((left, right) => {
    const byTime = compareColumnTimestamps(left.replaced_at, right.replaced_at);
    return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
  });
}

function actorWhoWroteVersion(writer: MemoryTimelineRevision | null): MemoryTimelineActor {
  if (!writer) {
    return UNKNOWN_ACTOR;
  }
  return {
    type: writer.replaced_by.type,
    id: writer.replaced_by.id,
    name: writer.replaced_by.name,
    detail: writer.replaced_by.detail,
  };
}

function runIdOfActor(actor: MemoryTimelineActor): string | null {
  return actor.type === "run" ? actor.id : null;
}

function changeStatsFromPrevious(previous: string | null, content: string): { added: number; removed: number } {
  if (previous === null) {
    return { added: 0, removed: 0 };
  }
  return lineChangeStats(previous, content);
}

function timelineEntryAt(args: {
  index: number;
  content: string;
  revision: MemoryTimelineRevision | null;
  previous: { content: string } | null;
  writer: MemoryTimelineRevision | null;
}): MemoryTimelineEntry {
  const actor = actorWhoWroteVersion(args.writer);
  const previous = args.previous?.content ?? null;
  return {
    index: args.index,
    revision_id: args.revision?.id ?? null,
    archive_display_path: args.revision?.display_path ?? null,
    written_at: args.writer?.replaced_at ?? null,
    actor,
    run_id: runIdOfActor(actor),
    content: args.content,
    content_hash: hashText(args.content),
    previous_content: previous,
    stats: changeStatsFromPrevious(previous, args.content),
  };
}

export function buildMemoryTimeline(args: {
  live: { content: string };
  revisions: MemoryTimelineRevision[];
}): MemoryTimelineEntry[] {
  const chronological = chronologicalRevisions(args.revisions);
  const versions: Array<{ content: string; revision: MemoryTimelineRevision | null }> = [
    ...chronological.map((revision) => ({ content: revision.content, revision })),
    { content: args.live.content, revision: null },
  ];
  const entries = versions.map((version, index) =>
    timelineEntryAt({
      index,
      content: version.content,
      revision: version.revision,
      previous: index > 0 ? versions[index - 1]! : null,
      writer: index > 0 ? chronological[index - 1]! : null,
    }),
  );
  return entries.reverse();
}

// A compact account of what a version changed: removed lines prefixed with
// "-", added lines with "+".
export function memoryDiffText(before: string, after: string): string {
  const prev = nonBlankMemoryLines(before);
  const next = nonBlankMemoryLines(after);
  const removed = prev.filter((line) => !next.includes(line));
  const added = next.filter((line) => !prev.includes(line));
  return [...removed.map((line) => `- ${line}`), ...added.map((line) => `+ ${line}`)].join("\n");
}
