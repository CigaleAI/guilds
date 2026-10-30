import type { UseQueryResult } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";
import { useState } from "react";
import { useRunDiff } from "../../../api/queries/runs";
import type { Run, RunDiff, RunRepositoryChange } from "../../../api/types/runs";
import { Button, CopyButton, Banner, cn, Icon } from "@guildsrun/ui";
import { diffLineTone, diffstat } from "./changes";

const toneClass = {
  added: "text-tide-t",
  removed: "text-outcome-failed",
  hunk: "text-plum-t",
  meta: "text-muted",
  context: "text-fg-2",
} as const;

/** A diff fetched from the agent's machine: its lines toned, with a copy button and the cut noted. */
export function DiffView({
  diff,
  className,
}: {
  diff: UseQueryResult<RunDiff>;
  className?: string;
}) {
  if (diff.isError) {
    return <Banner tone="error" title="Couldn't load the diff" meta={diff.error.message} />;
  }
  if (!diff.data) {
    return <p className="text-xs text-muted">Loading the diff from the agent&apos;s machine…</p>;
  }
  return (
    <div className={cn("relative overflow-hidden rounded-lg bg-paper", className)}>
      <CopyButton text={diff.data.diff} what="diff" className="absolute top-1 right-1" />
      <pre className="max-h-120 overflow-auto p-3 font-mono text-xs leading-5">
        {diff.data.diff.split("\n").map((line, index) => (
          <div key={index} className={cn("whitespace-pre", toneClass[diffLineTone(line)])}>
            {line || " "}
          </div>
        ))}
      </pre>
      {diff.data.truncated ? (
        <p className="border-t border-line px-3 py-1.5 text-xs text-muted">
          The diff is cut at 256 KiB.
        </p>
      ) : null}
    </div>
  );
}

function RepositoryChange({ runId, change }: { runId: string; change: RunRepositoryChange }) {
  const [open, setOpen] = useState(false);
  const diff = useRunDiff(runId, open ? change.name : null);
  return (
    <div className="flex flex-col gap-2 border-b border-line px-3.5 py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-sm font-medium">{change.name}</span>
        {change.branch ? (
          <span className="flex items-center gap-1 font-mono text-xs text-muted">
            <Icon icon={GitBranch} size={14} />
            {change.branch}
          </span>
        ) : null}
        <span className="text-xs text-fg-2">{diffstat(change)}</span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => setOpen((value) => !value)}
          disabled={change.files_changed === 0}
        >
          {open ? "Hide diff" : "Show diff"}
        </Button>
      </div>
      {open ? <DiffView diff={diff} /> : null}
    </div>
  );
}

/**
 * What a coding run changed in each repository, between the working tree at its first
 * generation and at its last: a diffstat per repository, and the diff on demand.
 */
export function ChangesPanel({ run }: { run: Run }) {
  const repos = run.repos ?? [];
  if (!repos.length) return null;
  return (
    <section aria-label="Changes" className="flex flex-col gap-2">
      <h3 className="type-label text-muted">Changes</h3>
      <div className="flex flex-col overflow-hidden rounded-xl bg-surface">
        {repos.map((change) => (
          <RepositoryChange key={change.name} runId={run.id} change={change} />
        ))}
      </div>
    </section>
  );
}
