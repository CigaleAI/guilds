import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useFileChanges, useLatestChange } from "../../api/queries/notes";
import type { FileChange } from "../../api/types";
import { relativeTime } from "../../app/format";
import { Button, VersionBar, SkeletonRows, Tag, cn } from "@guildsrun/ui";
import { changeActor } from "../agent/prompt/taskContext";

/** Opens the run step that made a change. */
export type OpenChangeStep = (change: FileChange & { run: NonNullable<FileChange["run"]> }) => void;

/** A run step: the run, in its agent's chat, and the tool call in it when known. */
export type RunStep = { guildId: string; agentId: string; runId: string; call?: string | null };

/** Opens a run in its agent's chat, at the tool call when one is given. */
export function useOpenRunStep(): (step: RunStep) => void {
  const navigate = useNavigate();
  return ({ guildId, agentId, runId, call }) =>
    void navigate({
      to: "/guilds/$guildId/agents/$agentId",
      params: { guildId, agentId },
      search: { run: runId, ...(call ? { call } : {}) },
    });
}

/** Opens a change's step in the chat of the agent that ran it, at the tool call that wrote it. */
export function useOpenStepInAgent(fallbackGuildId: string | undefined): OpenChangeStep {
  const openRunStep = useOpenRunStep();
  return (change) =>
    openRunStep({
      guildId: change.run.guild_id ?? fallbackGuildId ?? "",
      agentId: change.run.agent_id,
      runId: change.run.id,
      call: change.tool?.call_id ?? null,
    });
}

function actorText(change: FileChange): string {
  const actor = changeActor(change);
  if (actor.kind === "run") {
    return `run ${actor.runId}${actor.trigger ? ` (${actor.trigger})` : ""}${actor.tool ? ` via ${actor.tool}` : ""}`;
  }
  return actor.kind === "agent" ? `agent ${actor.name}` : actor.name;
}

type ChangeHistoryProps = {
  displayPath: string;
  /** Where "Open step" goes; by default the agent's chat at that step. */
  onOpenStep?: OpenChangeStep | undefined;
  /** The guild to open a run in when the change does not name one. */
  guildId?: string | undefined;
  className?: string;
};

/** Every recorded change to a file, newest first, each with the run step that made it. */
export function ChangeHistory({ displayPath, onOpenStep, guildId, className }: ChangeHistoryProps) {
  const history = useFileChanges(displayPath);
  const openInAgent = useOpenStepInAgent(guildId);
  const openStep = onOpenStep ?? openInAgent;
  return (
    <div
      className={cn(
        "flex max-h-72 flex-col gap-1 overflow-y-auto rounded-lg bg-paper p-2",
        className,
      )}
    >
      {history.isPending ? (
        <SkeletonRows rows={3} label="Loading the history" />
      ) : history.isError ? (
        <p className="px-1 text-sm text-plum-t">{history.error.message}</p>
      ) : history.data.length === 0 ? (
        <p className="px-1 text-sm text-muted">No recorded changes.</p>
      ) : (
        history.data.map((item) => {
          const run = item.run;
          return (
            <div key={item.id} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-xs">
              <Tag tone="well">v{item.version}</Tag>
              <span className="shrink-0 text-muted">{relativeTime(item.created_at)}</span>
              <span className="min-w-0 flex-1 truncate text-fg-2" title={actorText(item)}>
                {item.operation} · {actorText(item)}
              </span>
              {run ? (
                <Button variant="ghost" size="xs" onClick={() => openStep({ ...item, run })}>
                  Open step
                </Button>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}

type LatestChangeProps = {
  displayPath: string;
  /** Where "Open step" goes; by default the agent's chat at that step. */
  onOpenStep?: OpenChangeStep | undefined;
  /** The guild to open a run in when the change does not name one. */
  guildId?: string | undefined;
  className?: string;
};

/**
 * Who changed a file last and when, with the run step that did it, and every earlier change on
 * demand.
 */
export function LatestChange({ displayPath, onOpenStep, guildId, className }: LatestChangeProps) {
  const latest = useLatestChange(displayPath);
  const [open, setOpen] = useState(false);
  const openInAgent = useOpenStepInAgent(guildId);
  const openStep = onOpenStep ?? openInAgent;

  if (!latest.data) return null;
  const change = latest.data;
  const run = change.run;

  return (
    <div className={className}>
      <VersionBar
        version={change.version}
        when={relativeTime(change.created_at)}
        actor={changeActor(change)}
        {...(run ? { onOpenStep: () => openStep({ ...change, run }) } : {})}
        onHistory={() => setOpen(!open)}
      />
      {open ? (
        <ChangeHistory
          displayPath={displayPath}
          onOpenStep={openStep}
          guildId={guildId}
          className="mt-1.5"
        />
      ) : null}
    </div>
  );
}
