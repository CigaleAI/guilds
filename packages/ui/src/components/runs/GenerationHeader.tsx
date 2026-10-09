import { Check, ChevronDown } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";
import { SegmentStrip } from "../../primitives/Mark";
import { Pill } from "../../primitives/Pill";
import { Tag } from "../../primitives/Tag";
import { GenerationFilters, type GenerationFilter } from "./GenerationFilters";
import { stepSegments, stepToneOnPaper, type StepSegment } from "./stepOutcome";

/** Where a generation stands: its error count, still running, or completed cleanly. */
export type GenerationStatus =
  { kind: "errors"; count: number } | { kind: "running" } | { kind: "completed" };

export type GenerationStat = {
  /** Formatted value with its unit, such as "24 steps" or "399k tok". */
  label: string;
  /** Breakdown on hover, such as "391,204 in · 8,113 out". */
  title?: string;
};

export type GenerationHeaderProps = Omit<ComponentProps<"div">, "title"> & {
  /** "Generation 1", or "Tool trace" for calls outside any generation. */
  title: ReactNode;
  stats: GenerationStat[];
  status: GenerationStatus;
  /** One segment per step, in order. */
  steps?: StepSegment[];
  filters?: GenerationFilter[];
  /** Offers the Mutations filter, and Errors when there are errors. */
  onFiltersChange?: (filters: GenerationFilter[]) => void;
  /** With `onOpenChange`, a chevron folds the generation's steps. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** `sm` for narrow columns such as the Studio coach. */
  size?: "md" | "sm";
};

function StatusPill({ status }: { status: GenerationStatus }) {
  if (status.kind === "errors") {
    return (
      <Pill fill="plum" size="xs" className="h-5 text-2xs font-bold">
        {status.count === 1 ? "1 error" : `${status.count} errors`}
      </Pill>
    );
  }
  if (status.kind === "running") {
    return (
      <Pill fill="signal-tint" size="xs" className="h-5 text-2xs font-bold">
        <span className="size-1.5 rounded-full bg-signal motion-safe:animate-pulse" aria-hidden />
        running…
      </Pill>
    );
  }
  return (
    <Pill fill="tide-tint" size="xs" className="h-5 gap-1 text-2xs font-bold">
      <Icon icon={Check} size={14} />
      completed
    </Pill>
  );
}

/** The summary card over one generation of a run: its totals, how it ended, and a strip of its steps. */
export function GenerationHeader({
  title,
  stats,
  status,
  steps,
  filters = [],
  onFiltersChange,
  open,
  onOpenChange,
  size = "md",
  className,
  ...props
}: GenerationHeaderProps) {
  const available: GenerationFilter[] =
    status.kind === "errors" ? ["mutations", "errors"] : ["mutations"];
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-2.5 rounded-lg bg-paper text-fg",
        size === "md" ? "px-3.5 py-3" : "px-3.5 py-2.5",
        className,
      )}
      {...props}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className={cn("font-bold", size === "md" ? "text-md" : "text-sm")}>{title}</span>
        {stats.map((stat) => (
          <Tag
            key={stat.label}
            tone="surface"
            className={size === "md" ? "text-xs" : "px-1.5"}
            title={stat.title}
          >
            {stat.label}
          </Tag>
        ))}
        <span className="ml-auto flex items-center gap-2">
          <StatusPill status={status} />
          {onFiltersChange ? (
            <GenerationFilters
              available={available}
              value={filters}
              onValueChange={onFiltersChange}
            />
          ) : null}
          {onOpenChange ? (
            <button
              type="button"
              aria-expanded={open ?? false}
              aria-label={open ? "Fold steps" : "Unfold steps"}
              onClick={() => onOpenChange(!open)}
              className="inline-flex size-6 cursor-pointer items-center justify-center rounded-sm text-fg transition-colors hover:bg-surface"
            >
              <Icon
                icon={ChevronDown}
                size={14}
                className={cn("transition-transform", !open && "-rotate-90")}
              />
            </button>
          ) : null}
        </span>
      </div>
      {steps && steps.length ? (
        <SegmentStrip segments={stepSegments(steps, stepToneOnPaper)} />
      ) : null}
    </div>
  );
}
