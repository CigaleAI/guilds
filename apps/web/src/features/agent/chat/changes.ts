import type { RunRepositoryChange } from "../../../api/types/runs";

/** A repository's change in a few words: "3 files · +40 −2", or "no file changes". */
export function diffstat(
  change: Pick<RunRepositoryChange, "files_changed" | "insertions" | "deletions">,
): string {
  if (!change.files_changed) return "no file changes";
  const files = `${change.files_changed} file${change.files_changed === 1 ? "" : "s"}`;
  return `${files} · +${change.insertions} −${change.deletions}`;
}

/** A commit's short form, as git abbreviates it; "none" for a repository with no commit. */
function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "none";
}

/**
 * How a turn moved a repository's history, in a few words: the branch it switched, as
 * "main → topic", and the head commit it moved, as "1a2b3c4 → 5d6e7f8", as a commit or a rewrite
 * of history moves it; null when it moved neither.
 */
export function headChange(
  change: Pick<RunRepositoryChange, "branch" | "head_sha" | "start_branch" | "start_head_sha">,
): string | null {
  const parts = [
    change.start_branch !== change.branch
      ? `${change.start_branch ?? "no branch"} → ${change.branch ?? "no branch"}`
      : "",
    change.start_head_sha !== change.head_sha
      ? `${shortSha(change.start_head_sha)} → ${shortSha(change.head_sha)}`
      : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
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
