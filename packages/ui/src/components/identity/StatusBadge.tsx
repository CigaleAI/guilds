import { Check } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import { Dot } from "../../primitives/Dot";
import { Icon } from "../../primitives/Icon";
import { statusTone, type Status, type Tone } from "../../tones";

/** A run or state status, or `live` for a session streaming right now. */
export type StatusBadgeStatus = Status | "live";

const toneFill: Record<Tone, string> = {
  signal: "bg-t-sig text-t-sig-fg",
  tide: "bg-t-tide text-t-tide-fg",
  dusk: "bg-t-plum text-t-dusk-fg",
  ochre: "bg-t-ochre text-t-ochre-fg",
  plum: "bg-plum text-on-plum",
  idle: "bg-well text-muted",
};

const defaultLabel: Record<StatusBadgeStatus, string> = {
  running: "Running",
  ok: "Succeeded",
  queued: "Queued",
  warning: "Warning",
  failed: "Failed",
  idle: "Idle",
  live: "Live",
};

export type StatusBadgeProps = ComponentProps<"span"> & {
  status: StatusBadgeStatus;
  /** Overrides the default label, such as "completed" for a finished generation. */
  children?: ReactNode;
};

/** The state of a run, generation or session as a pill: tint for progress, plum fill for failure. */
export function StatusBadge({ status, className, children, ...props }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-bold whitespace-nowrap select-none",
        status === "live" ? "bg-signal text-on-signal uppercase" : toneFill[statusTone[status]],
        className,
      )}
      {...props}
    >
      {status === "running" ? <Dot size="sm" tone="signal" className="animate-pulse" /> : null}
      {status === "ok" ? <Icon icon={Check} size={14} className="-mx-0.5" /> : null}
      {children ?? defaultLabel[status]}
    </span>
  );
}
