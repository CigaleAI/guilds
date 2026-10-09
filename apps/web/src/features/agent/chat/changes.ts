import type { RunRepositoryChange } from "../../../api/types";

/** A repository's change in a few words: "3 files · +40 −2", or "no changes". */
export function diffstat(
  change: Pick<RunRepositoryChange, "files_changed" | "insertions" | "deletions">,
): string {
  if (!change.files_changed) return "no changes";
  const files = `${change.files_changed} file${change.files_changed === 1 ? "" : "s"}`;
  return `${files} · +${change.insertions} −${change.deletions}`;
}

/** How a unified diff line reads: an added or removed line, a hunk header, file metadata, or context. */
export function diffLineTone(line: string): "added" | "removed" | "hunk" | "meta" | "context" {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    /^(new|deleted) file mode/.test(line)
  )
    return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
}
