import { ArrowDown, CircleX, List, PenLine } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";
import { Button } from "../actions/Button";
import { Segmented } from "../controls/Segmented";
import type { GenerationFilter } from "./GenerationFilters";

/** Where a generation stands: its error count, still running, or completed cleanly. */
export type GenerationStatus =
  { kind: "errors"; count: number } | { kind: "running" } | { kind: "completed" };

export type GenerationStat = {
  /** Formatted value with its unit, such as "24 steps" or "399k tok". */
  label: string;
  /** Breakdown on hover, such as "391,204 in · 8,113 out". */
  title?: string;
  /** `failed` reads in plum, such as "1 failed". */
  tone?: "failed";
};

/** How many calls each filter keeps. */
export type GenerationCounts = { all: number; mutations: number; errors: number };

export type GenerationHeaderProps = Omit<ComponentProps<"header">, "title"> & {
  /** "Generation 1", or "Tool trace" for calls outside any generation. */
  title: ReactNode;
  stats: GenerationStat[];
  status: GenerationStatus;
  /** With `onFilterChange`, the toolbar offers All, Writes and Errors with these counts. */
  counts?: GenerationCounts;
  /** The calls kept in focus; null keeps every call. */
  filter?: GenerationFilter | null;
  onFilterChange?: (filter: GenerationFilter | null) => void;
  /** With `onThinkingHiddenChange`, a toggle hides the reasoning lines. */
  thinkingHidden?: boolean;
  onThinkingHiddenChange?: (hidden: boolean) => void;
  /** With `onExpandedChange`, **Expand all** unfolds every thought and group of calls and **Collapse all** folds them. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** Scrolls to the generation's last answer; without it there is no answer to jump to. */
  onJumpToAnswer?: () => void;
  /** `sm` for narrow columns such as the Studio coach. */
  size?: "md" | "sm";
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const statusLook = {
  errors: { pill: "bg-t-plum text-plum-t", dot: "bg-plum" },
  running: { pill: "bg-t-sig text-t-sig-fg", dot: "bg-signal motion-safe:animate-pulse" },
  completed: { pill: "bg-t-tide text-t-tide-fg", dot: "bg-tide" },
} as const;

function StatusPill({ status }: { status: GenerationStatus }) {
  const look = statusLook[status.kind];
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold",
        look.pill,
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", look.dot)} />
      {status.kind === "errors"
        ? plural(status.count, "error")
        : status.kind === "running"
          ? "Running…"
          : "Done"}
    </span>
  );
}

type FilterValue = "all" | GenerationFilter;

/** The header over one generation of a run: what it is, how it ended, its totals, and how to read it. */
export function GenerationHeader({
  title,
  stats,
  status,
  counts,
  filter = null,
  onFilterChange,
  thinkingHidden = false,
  onThinkingHiddenChange,
  expanded = false,
  onExpandedChange,
  onJumpToAnswer,
  size = "md",
  className,
  ...props
}: GenerationHeaderProps) {
  const filters = counts && onFilterChange ? onFilterChange : null;
  const toolbar = filters || onThinkingHiddenChange || onExpandedChange || onJumpToAnswer;
  return (
    <header
      className={cn(
        "flex min-w-0 flex-col text-fg",
        size === "md" ? "gap-2 px-4 pt-3.5 pb-3" : "gap-1.5 px-3.5 pt-3 pb-2.5",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span
          className={cn(
            "min-w-0 flex-1 font-semibold",
            size === "md" ? "text-lg leading-snug" : "text-md",
          )}
        >
          {title}
        </span>
        <StatusPill status={status} />
      </div>
      {stats.length ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-fg-2">
          {stats.map((stat) => (
            <span
              key={stat.label}
              title={stat.title}
              className={cn(stat.tone === "failed" && "text-plum-t")}
            >
              {stat.label}
            </span>
          ))}
        </div>
      ) : null}
      {toolbar ? (
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2 pt-1">
          {filters && counts ? (
            <Segmented<FilterValue>
              size="sm"
              fill="paper"
              label="Calls in focus"
              value={filter ?? "all"}
              onValueChange={(next) => filters(next === "all" ? null : next)}
              options={[
                {
                  value: "all",
                  label: (
                    <>
                      <Icon icon={List} size={14} />
                      All
                    </>
                  ),
                  count: counts.all,
                },
                {
                  value: "mutations",
                  label: (
                    <>
                      <Icon icon={PenLine} size={14} />
                      Writes
                    </>
                  ),
                  count: counts.mutations,
                  disabled: counts.mutations === 0,
                },
                {
                  value: "errors",
                  label: (
                    <>
                      <Icon icon={CircleX} size={14} />
                      Errors
                    </>
                  ),
                  count: counts.errors,
                  disabled: counts.errors === 0,
                },
              ]}
            />
          ) : null}
          {onThinkingHiddenChange ? (
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={thinkingHidden}
              className="bg-well hover:bg-line-2"
              onClick={() => onThinkingHiddenChange(!thinkingHidden)}
            >
              {thinkingHidden ? "Show thinking" : "Hide thinking"}
            </Button>
          ) : null}
          {onExpandedChange ? (
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={expanded}
              onClick={() => onExpandedChange(!expanded)}
            >
              {expanded ? "Collapse all" : "Expand all"}
            </Button>
          ) : null}
          {onJumpToAnswer ? (
            <Button size="sm" variant="ghost" className="text-tide-t" onClick={onJumpToAnswer}>
              Jump to answer
              <Icon icon={ArrowDown} size={14} />
            </Button>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
