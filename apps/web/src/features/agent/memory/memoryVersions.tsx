import { Play } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { MemoryVersion } from "../../../api/types/notes";
import { relativeTime } from "../../../app/format";
import { Button, DiffView, diffLines, Segmented, Icon, Row, Tag } from "@guildsrun/ui";
import { DetailHeader } from "../../studio/MasterDetail";
import { runKindLabel } from "../runState";

/** A version's id in a list: its revision, or `live` for the live version. */
export const memoryVersionId = (entry: MemoryVersion) => entry.revision_id ?? "live";

/** A version's name, such as `v7 · live`. */
export const memoryVersionName = (entry: MemoryVersion) =>
  `v${entry.index}${entry.revision_id === null ? " · live" : ""}`;

function memoryRunAuthorLabel(entry: MemoryVersion): string {
  return entry.run?.kind ? runKindLabel[entry.run.kind].toLowerCase() : "a run";
}

/** Who wrote a version: a run of the agent, a person, another agent, or nobody on record. */
export function memoryAuthorLabel(entry: MemoryVersion): string {
  if (entry.actor.type === "run") {
    return memoryRunAuthorLabel(entry);
  }
  if (entry.actor.type === "user" || entry.actor.type === "agent") {
    return entry.actor.name ?? entry.actor.type;
  }
  return "unknown author";
}

/** How a version differs from the one before. */
export function memoryChangeLabel(entry: MemoryVersion): string {
  if (entry.previous_content === null) return "oldest on record";
  if (!entry.stats.added && !entry.stats.removed) return "unchanged";
  return `+${entry.stats.added} −${entry.stats.removed}`;
}

type MemoryVersionRowProps = {
  entry: MemoryVersion;
  selected: boolean;
  /** The caption under the version's name. */
  meta: string;
  onSelect: () => void;
};

/** One version in a list: its name, a caption, and the lines it added and removed. */
export function MemoryVersionRow({ entry, selected, meta, onSelect }: MemoryVersionRowProps) {
  return (
    <Row
      asChild
      density="compact"
      interactive
      selected={selected}
      mono
      title={memoryVersionName(entry)}
      meta={meta}
      trail={
        entry.previous_content !== null ? (
          <Tag tone={selected ? "on-plum" : "well"}>
            +{entry.stats.added} −{entry.stats.removed}
          </Tag>
        ) : null
      }
    >
      <button type="button" aria-current={selected ? "true" : undefined} onClick={onSelect} />
    </Row>
  );
}

/** The run step that wrote a version: the run, and the memory write in it when known. */
export type MemoryStep = { runId: string; call: string | null };

/** Opens the run step that wrote a version; disabled once that run is gone. */
export function MemoryStepButton({
  entry,
  onOpen,
}: {
  entry: MemoryVersion;
  onOpen: (step: MemoryStep) => void;
}) {
  const run = entry.run;
  if (!run) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={!run.exists}
      title={run.exists ? "Open the step that wrote this version" : "That run is gone"}
      onClick={() => onOpen({ runId: run.id, call: run.memory_write?.call_id ?? null })}
    >
      <Icon icon={Play} size={14} />
      Open step
    </Button>
  );
}

/**
 * One version, read-only: who wrote it and when, and either what it changed against the version
 * before or its whole text.
 */
export function MemoryVersionView({
  entry,
  actions,
}: {
  entry: MemoryVersion;
  actions?: ReactNode;
}) {
  const [mode, setMode] = useState<"diff" | "full">(
    entry.previous_content === null ? "full" : "diff",
  );
  const archive = entry.archive_display_path?.split("/").pop();

  return (
    <>
      <DetailHeader
        title={`Memory ${memoryVersionName(entry)}`}
        meta={
          <span className="flex flex-wrap gap-x-2">
            <span title={entry.actor.detail ?? undefined}>{memoryAuthorLabel(entry)}</span>
            {entry.written_at ? <span>{relativeTime(entry.written_at)}</span> : null}
            {archive ? <span className="font-mono">{archive}</span> : null}
          </span>
        }
        actions={actions}
      />
      {entry.previous_content !== null ? (
        <Segmented
          size="sm"
          label="Show"
          className="self-start"
          value={mode}
          onValueChange={setMode}
          options={[
            { value: "diff", label: "Change" },
            { value: "full", label: "Whole version" },
          ]}
        />
      ) : null}
      {mode === "diff" && entry.previous_content !== null ? (
        <DiffView
          lines={diffLines(entry.previous_content, entry.content)}
          title={`memory · v${entry.index - 1} → v${entry.index}`}
        />
      ) : (
        <pre className="rounded-lg bg-surface px-4 py-3 font-mono text-xs whitespace-pre-wrap">
          {entry.content || "(Empty)"}
        </pre>
      )}
    </>
  );
}
