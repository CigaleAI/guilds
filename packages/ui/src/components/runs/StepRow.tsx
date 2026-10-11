import { ChevronDown } from "lucide-react";
import { Collapsible } from "radix-ui";
import { Fragment, useState, type MouseEvent, type ReactNode } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";
import { Tag } from "../../primitives/Tag";
import { FilterChip, toggleFilter, type GenerationFilter } from "./GenerationFilters";
import type { StepOutcome } from "./stepOutcome";

const dotFill: Record<StepOutcome, string> = {
  ok: "bg-signal",
  wrote: "bg-tide",
  failed: "bg-plum",
  running: "bg-mauve motion-safe:animate-pulse",
};

const outcomeLabel: Record<StepOutcome, string> = {
  ok: "succeeded",
  wrote: "succeeded with changes",
  failed: "failed",
  running: "running",
};

/** One figure on a step's row, with its breakdown on hover. */
export type StepFact = { label: string; title?: string };

export type StepRowProps = {
  outcome: StepOutcome;
  /** How many of the step's calls failed, for the chip. */
  failed?: number;
  /** The step's lead sentence: what the model said or thought first. */
  title?: ReactNode;
  /** Mono figures right of the title, such as "2 calls", "8.8s", "7.4k tok", "$0.0012". */
  facts?: StepFact[];
  /** Why the model stopped, when that deserves a tag, such as "max tokens". */
  stop?: string;
  /** Faded out by an active generation filter. */
  dimmed?: boolean;
  /** The generation's filters; the step's outcome chip toggles the one it stands for. */
  filters?: GenerationFilter[];
  onFiltersChange?: (filters: GenerationFilter[]) => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** What unfolds under the step: its reasoning, its text, then the calls it requested. */
  children?: ReactNode;
  className?: string;
};

function OutcomeChip({
  outcome,
  failed = 0,
  filters = [],
  onFiltersChange,
}: Pick<StepRowProps, "outcome" | "failed" | "filters" | "onFiltersChange">) {
  if (outcome === "ok") return null;
  if (outcome === "running") return <Tag tone="well">running</Tag>;
  const filter: GenerationFilter = outcome === "wrote" ? "mutations" : "errors";
  const label = outcome === "wrote" ? "wrote" : failed > 1 ? `${failed} failed` : "failed";
  if (!onFiltersChange) {
    return <Tag tone={outcome === "wrote" ? "tide" : "plum"}>{label}</Tag>;
  }
  return (
    <FilterChip
      filter={filter}
      pressed={filters.includes(filter)}
      onPressedChange={() => onFiltersChange(toggleFilter(filters, filter))}
    >
      {label}
    </FilterChip>
  );
}

/** One model step of a generation, folding open onto its reasoning and the calls it requested. */
export function StepRow({
  outcome,
  failed,
  title,
  facts,
  stop,
  dimmed,
  filters,
  onFiltersChange,
  open,
  defaultOpen,
  onOpenChange,
  children,
  className,
}: StepRowProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen ?? false);
  const isOpen = open ?? uncontrolled;
  const setOpen = (next: boolean) => {
    if (open === undefined) setUncontrolled(next);
    onOpenChange?.(next);
  };
  const expandable = children !== undefined && children !== null;
  const row = (
    <>
      <span className={cn("size-2 shrink-0 rounded-full", dotFill[outcome])} aria-hidden />
      <span className="sr-only">{outcomeLabel[outcome]}</span>
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{title}</span>
      {facts?.length ? (
        <span className="flex shrink-0 items-center type-meta text-muted">
          {facts.map((fact, index) => (
            <Fragment key={fact.label}>
              {index > 0 ? (
                <span aria-hidden className="mx-1.5">
                  ·
                </span>
              ) : null}
              <span title={fact.title}>{fact.label}</span>
            </Fragment>
          ))}
        </span>
      ) : null}
      {stop ? (
        <Tag tone="ochre" font="sans">
          {stop}
        </Tag>
      ) : null}
      <OutcomeChip
        outcome={outcome}
        {...(failed !== undefined ? { failed } : {})}
        {...(filters ? { filters } : {})}
        {...(onFiltersChange ? { onFiltersChange } : {})}
      />
    </>
  );
  const rowClass = "flex w-full min-w-0 items-center gap-2.5 rounded-lg bg-paper py-2 pr-2 pl-3.5";

  if (!expandable) {
    return <div className={cn(rowClass, "pr-3.5", dimmed && "opacity-40", className)}>{row}</div>;
  }

  /** Clicks on the row fold it, unless they land on something that acts on its own. */
  const onRowClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest("a, button")) return;
    setOpen(!isOpen);
  };

  return (
    <Collapsible.Root
      open={isOpen}
      onOpenChange={setOpen}
      className={cn("group/step flex min-w-0 flex-col gap-2.5", dimmed && "opacity-40", className)}
    >
      <div
        onClick={onRowClick}
        className={cn(rowClass, "cursor-pointer transition-colors hover:bg-paper-hi")}
      >
        {row}
        <Collapsible.Trigger
          aria-label={isOpen ? "Fold the step" : "Unfold the step"}
          className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-fg transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Icon
            icon={ChevronDown}
            size={14}
            className="transition-transform group-data-[state=closed]/step:-rotate-90"
          />
        </Collapsible.Trigger>
      </div>
      <Collapsible.Content className="pl-5">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}
