import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import { SegmentStrip } from "../../primitives/Mark";
import { GenerationFilters, type GenerationFilter } from "./GenerationFilters";
import { stepSegments, stepToneOnPlum, type StepSegment } from "./stepOutcome";

export type GenerationHeroStat = {
  value: ReactNode;
  /** Caption under the value, such as "tool calls" or "model · 87ms tools". */
  label: ReactNode;
};

export type GenerationHeroProps = Omit<ComponentProps<"section">, "title"> & {
  /** Mono caps line over the headline, such as "Generation 1 · 24 steps". */
  eyebrow: ReactNode;
  /** The headline number, such as the error count. */
  value: ReactNode;
  /** Its unit, such as "errors". */
  unit?: ReactNode;
  steps?: StepSegment[];
  /** Totals in the cyan band: tool calls, model and tool time, tokens, cost. */
  stats: GenerationHeroStat[];
  /** Filters on offer, in order. */
  availableFilters?: GenerationFilter[];
  filters?: GenerationFilter[];
  onFiltersChange?: (filters: GenerationFilter[]) => void;
  /** The generation's steps, laid out on the card's surface below the band. */
  children?: ReactNode;
};

const bandColumns: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
  5: "grid-cols-5",
};

/** The inspector's full generation card: plum headline, cyan totals band, then its steps. */
export function GenerationHero({
  eyebrow,
  value,
  unit,
  steps,
  stats,
  availableFilters = ["mutations", "errors"],
  filters = [],
  onFiltersChange,
  children,
  className,
  ...props
}: GenerationHeroProps) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-xl bg-surface text-fg",
        className,
      )}
      {...props}
    >
      <div className="flex flex-col gap-3.5 bg-plum px-5 pt-5 pb-4 text-on-plum">
        <div className="flex flex-wrap items-end gap-3.5">
          <div className="flex min-w-50 flex-1 flex-col gap-0.5">
            <span className="type-label text-on-plum-muted">{eyebrow}</span>
            <div className="flex items-baseline gap-2.5">
              <span className="type-hero">{value}</span>
              {unit !== undefined ? <span className="text-xl font-medium">{unit}</span> : null}
            </div>
          </div>
          {onFiltersChange ? (
            <GenerationFilters
              surface="plum"
              available={availableFilters}
              value={filters}
              onValueChange={onFiltersChange}
            />
          ) : null}
        </div>
        {steps && steps.length ? (
          <SegmentStrip className="h-2" segments={stepSegments(steps, stepToneOnPlum)} />
        ) : null}
      </div>
      {stats.length ? (
        <dl className={cn("grid bg-signal text-on-signal", bandColumns[Math.min(stats.length, 5)])}>
          {stats.map((stat, index) => (
            <div
              key={index}
              className={cn(
                "flex min-w-0 flex-col-reverse px-5 py-3.5",
                index > 0 && "border-l border-on-signal-line",
              )}
            >
              <dt className="truncate text-xs">{stat.label}</dt>
              <dd className="truncate text-xl font-semibold tracking-tight">{stat.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {children !== undefined ? (
        <div className="flex flex-col gap-2.5 px-4 pt-3.5 pb-4">{children}</div>
      ) : null}
    </section>
  );
}
