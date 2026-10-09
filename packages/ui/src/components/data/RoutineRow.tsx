import { Repeat, Shuffle } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";
import { Tag } from "../../primitives/Tag";
import { Tile } from "../../primitives/Tile";
import { OnOffSwitch } from "../controls/OnOffSwitch";

/** Whether a routine fires: on its next slot, paused by its owner, or held because the guild's routines are off. */
export type RoutineState =
  | {
      kind: "active";
      /** When it fires next, such as "14:00" or "Mon 00:00". */
      next: string;
    }
  | { kind: "paused" }
  | { kind: "held" };

export type RoutineRowProps = Omit<ComponentProps<"div">, "children" | "onSelect"> & {
  /** The routine's one-line description. */
  description: string;
  /** The agent it wakes; left out where the agent is already known, such as its own inspector. */
  agentName?: string;
  /** A UTC cron expression, or a random wake window. */
  mode: "cron" | "window";
  /** Mono schedule: the cron expression, or the window such as "08:00–20:00 · 10× · Europe/Paris". */
  schedule: string;
  /** Human reading of the schedule, such as "Weekdays at 00:00 UTC". */
  scheduleLabel?: string;
  state: RoutineState;
  selected?: boolean;
  onSelect?: () => void;
  onPausedChange: (paused: boolean) => void;
  disabled?: boolean;
};

/** A routine in a list: what it does, when and whom it wakes, when it fires next, and its On/Off. */
export function RoutineRow({
  description,
  agentName,
  mode,
  schedule,
  scheduleLabel,
  state,
  selected = false,
  onSelect,
  onPausedChange,
  disabled,
  className,
  ...props
}: RoutineRowProps) {
  const status =
    state.kind === "active" ? (
      <span className="font-mono text-2xs whitespace-nowrap text-muted group-data-[selected=true]/routine:text-on-plum-muted">
        Next {state.next}
      </span>
    ) : (
      <Tag
        tone={state.kind === "held" ? "ochre" : "well"}
        className="group-data-[selected=true]/routine:bg-on-plum-hover group-data-[selected=true]/routine:text-on-plum"
      >
        {state.kind}
      </Tag>
    );

  return (
    <div
      data-selected={selected ? "true" : undefined}
      className={cn(
        "group/routine @container flex min-w-0 items-center gap-3 rounded-lg bg-paper p-3 text-fg",
        "data-[selected=true]:bg-plum data-[selected=true]:text-on-plum",
        className,
      )}
      {...props}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md text-left"
      >
        <Tile
          size={36}
          tone="surface"
          className="group-data-[selected=true]/routine:bg-on-plum-hover group-data-[selected=true]/routine:text-on-plum"
        >
          <Icon
            icon={mode === "cron" ? Repeat : Shuffle}
            label={mode === "cron" ? "Cron" : "Random window"}
          />
        </Tile>
        <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          <span className="max-w-full truncate text-md font-semibold">{description}</span>
          <span
            className="max-w-full truncate font-mono text-2xs text-muted group-data-[selected=true]/routine:text-on-plum-muted"
            title={scheduleLabel}
          >
            {schedule}
            {agentName ? ` · ${agentName}` : null}
            {scheduleLabel ? <span className="sr-only">, {scheduleLabel}</span> : null}
          </span>
          <span className="flex @md:hidden">{status}</span>
        </span>
        <span className="hidden shrink-0 @md:flex">{status}</span>
      </button>
      <OnOffSwitch
        label={`${description} routine`}
        value={state.kind !== "paused"}
        onValueChange={(on) => onPausedChange(!on)}
        disabled={disabled ?? false}
      />
    </div>
  );
}
