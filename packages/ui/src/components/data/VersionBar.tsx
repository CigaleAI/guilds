import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { Tag } from "../../primitives/Tag";
import { Button } from "../actions/Button";

/** Who made a file change: a run (through a tool call), an agent, or a person. */
export type ChangeActor =
  | {
      kind: "run";
      runId: string;
      /** What started the run, such as "schedule wake-up" or "group delivery". */
      trigger?: string;
      /** Tool the run wrote through, such as memory_write. */
      tool?: string;
    }
  | { kind: "agent"; name: string }
  | { kind: "user"; name: string };

export type VersionBarProps = Omit<ComponentProps<"div">, "children"> & {
  version: number;
  /** Relative time of the change, such as "31m ago". */
  when: string;
  actor: ChangeActor;
  /** Opens the run at the tool call that made the change; offered for run changes. */
  onOpenStep?: () => void;
  onHistory?: () => void;
};

/** A file's provenance strip: its version, when and by whom it last changed, and the way back to that step. */
export function VersionBar({ version, when, actor, onOpenStep, onHistory, className, ...props }: VersionBarProps) {
  return (
    <div
      className={cn("flex min-w-0 flex-wrap items-center gap-2.5 rounded-lg bg-paper px-3 py-2.5 text-fg", className)}
      {...props}
    >
      <Tag tone="ink">v{version}</Tag>
      <p className="min-w-36 flex-1 text-sm text-fg-2">
        updated {when} by{" "}
        {actor.kind === "run" ? (
          <>
            run <span className="font-mono text-xs wrap-anywhere text-fg">{actor.runId}</span>
            {actor.trigger ? ` (${actor.trigger})` : null}
            {actor.tool ? (
              <>
                {" "}
                via <span className="font-mono text-xs text-fg">{actor.tool}</span>
              </>
            ) : null}
          </>
        ) : actor.kind === "agent" ? (
          <>
            agent <span className="font-mono text-xs text-fg">{actor.name}</span>
          </>
        ) : (
          actor.name
        )}
      </p>
      {(actor.kind === "run" && onOpenStep) || onHistory ? (
        <div className="flex shrink-0 items-center gap-1.5">
          {actor.kind === "run" && onOpenStep ? (
            <Button variant="outline" size="xs" onClick={onOpenStep}>
              Open step
            </Button>
          ) : null}
          {onHistory ? (
            <Button variant="outline" size="xs" onClick={onHistory}>
              History
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
