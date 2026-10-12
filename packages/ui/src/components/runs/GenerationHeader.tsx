import { Check, ChevronDown } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";
import { SegmentStrip } from "../../primitives/Mark";
import { Pill } from "../../primitives/Pill";
import { Tag } from "../../primitives/Tag";
import { FilterChip, toggleFilter, type GenerationFilter } from "./GenerationFilters";
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
  /** Calls that changed state; shown as a chip that toggles the Mutations filter. */
  mutations?: number;
  /** Calls that failed; with any, the errors chip toggles the Errors filter. */
  failed?: number;
  /** One segment per step, in order. */
  steps?: StepSegment[];
  filters?: GenerationFilter[];
  /** Makes the mutation and error chips toggles that dim the other calls. */
  onFiltersChange?: (filters: GenerationFilter[]) => void;
  /** With `onOpenChange`, a chevron folds the generation's steps. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** `sm` for narrow columns such as the Studio coach. */
  size?: "md" | "sm";
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function StatusPill({ status }: { status: GenerationStatus }) {
  if (status.kind === "errors") {
    return (
      <Pill fill="plum" size="xs" className="h-5 text-2xs font-bold">
        {plural(status.count, "error")}
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
  mutations = 0,
  failed = 0,
  steps,
  filters = [],
  onFiltersChange,
  open,
  onOpenChange,
  size = "md",
  className,
  ...props
}: GenerationHeaderProps) {
  const toggle = (filter: GenerationFilter) => () =>
    onFiltersChange?.(toggleFilter(filters, filter));
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
          {status.kind === "errors" && failed > 0 && onFiltersChange ? (
            <FilterChip
              filter="errors"
              pressed={filters.includes("errors")}
              onPressedChange={toggle("errors")}
            >
              {plural(status.count, "error")}
            </FilterChip>
          ) : (
            <StatusPill status={status} />
          )}
          {mutations > 0 ? (
            onFiltersChange ? (
              <FilterChip
                filter="mutations"
                pressed={filters.includes("mutations")}
                onPressedChange={toggle("mutations")}
              >
                {plural(mutations, "mutation")}
              </FilterChip>
            ) : (
              <Pill fill="tide-tint" size="xs" className="h-5 text-2xs font-bold">
                {plural(mutations, "mutation")}
              </Pill>
            )
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
