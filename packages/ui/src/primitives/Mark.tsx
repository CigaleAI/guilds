import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../cn";
import type { Tone, WakeOutcome } from "../tones";

/**
 * Data-viz atoms. Each wake is shaded by its outcome: posted and wrote share one ramp, posted
 * strongest; no output is grey; a failure is warm.
 */
const outcomeFill: Record<WakeOutcome, string> = {
  posted: "bg-outcome-posted",
  wrote: "bg-outcome-wrote",
  silent: "bg-outcome-silent",
  failed: "bg-outcome-failed",
  running: "bg-outcome-running",
};

export const markSquare = cva("inline-block size-3 shrink-0 rounded-xs", {
  variants: { outcome: outcomeFill },
  defaultVariants: { outcome: "posted" },
});

/** One wake. */
export function MarkSquare({
  outcome,
  className,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof markSquare>) {
  return <span className={cn(markSquare({ outcome }), className)} {...props} />;
}

/** Wakes split by outcome, as one strip of segments sized by their counts. */
export function OutcomeStrip({
  counts,
  className,
  ...props
}: ComponentProps<"span"> & { counts: Partial<Record<WakeOutcome, number>> }) {
  const outcomes = (Object.keys(outcomeFill) as WakeOutcome[]).filter((outcome) => (counts[outcome] ?? 0) > 0);
  return (
    <span aria-hidden className={cn("flex h-1.5 gap-0.5 overflow-hidden rounded-r-xs", className)} {...props}>
      {outcomes.map((outcome) => (
        <span
          key={outcome}
          className={cn("min-w-px", outcomeFill[outcome])}
          style={{ flexGrow: counts[outcome], flexBasis: 0 }}
        />
      ))}
    </span>
  );
}

const segmentFill: Record<Tone | "mauve" | "signal-2" | "plum-soft" | "on-plum-track", string> = {
  signal: "bg-signal",
  tide: "bg-tide",
  dusk: "bg-dusk",
  ochre: "bg-ochre",
  plum: "bg-plum",
  idle: "bg-rule",
  mauve: "bg-mauve",
  "signal-2": "bg-signal-2",
  "plum-soft": "bg-plum-soft",
  "on-plum-track": "bg-on-plum-track",
};

export type Segment = {
  /** Relative width. */
  weight: number;
  tone: keyof typeof segmentFill;
  label?: string;
};

/** Steps of a run, or parts of a whole, as one strip of rounded segments. */
export function SegmentStrip({
  segments,
  className,
  ...props
}: ComponentProps<"div"> & { segments: Segment[] }) {
  return (
    <div
      role="img"
      aria-label={
        segments
          .map((segment) => segment.label)
          .filter(Boolean)
          .join(", ") || undefined
      }
      className={cn("flex h-1.5 w-full gap-0.5", className)}
      {...props}
    >
      {segments.map((segment, index) => (
        <div
          key={index}
          title={segment.label}
          className={cn("min-w-0.5 rounded-xs", segmentFill[segment.tone])}
          style={{ flexGrow: segment.weight, flexBasis: 0 }}
        />
      ))}
    </div>
  );
}
