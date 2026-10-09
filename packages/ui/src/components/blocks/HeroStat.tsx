import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import { SegmentStrip, type Segment } from "../../primitives/Mark";
import { Pill } from "../../primitives/Pill";
import { StatBand, type Stat } from "./StatBand";

/** A strip segment in one of the fills that read on plum. */
export type HeroSegment = Segment & { tone: "signal" | "signal-2" | "on-plum-track" | "plum-soft" };

export type HeroStatProps = Omit<ComponentProps<"section">, "children"> & {
  /** Mono caps eyebrow, such as the period and guild. */
  label?: ReactNode;
  value: ReactNode;
  /** What the number counts, beside it: "wakes · last 24h", "of $60 budget". */
  unit?: ReactNode;
  /** A cyan pill on the right, such as "$2.59 spent" or "68% used". */
  accent?: ReactNode;
  /** Parts of the whole as one strip, such as wakes by outcome. */
  segments?: HeroSegment[];
  /** Share of a limit used, 0–1, as a bar. */
  progress?: number;
  /** The breakdown in the cyan band underneath. */
  stats?: Stat[];
};

/** The one headline number of a view on plum, with its breakdown in a cyan band tucked under it. */
export function HeroStat({
  label,
  value,
  unit,
  accent,
  segments,
  progress,
  stats,
  className,
  ...props
}: HeroStatProps) {
  const share = progress === undefined ? undefined : Math.min(1, Math.max(0, progress));
  return (
    <section className={cn("flex flex-col overflow-hidden rounded-xl", className)} {...props}>
      <div className="flex flex-col gap-3 bg-plum px-5 pt-5 pb-4 text-on-plum">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-2">
            {label !== undefined ? (
              <span className="type-label text-on-plum-muted">{label}</span>
            ) : null}
            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
              <span className="type-hero">{value}</span>
              {unit !== undefined ? <span className="text-xl font-medium">{unit}</span> : null}
            </div>
          </div>
          {accent !== undefined ? (
            <Pill size="xs" fill="accent" className="font-bold">
              {accent}
            </Pill>
          ) : null}
        </div>
        {segments && segments.length > 0 ? <SegmentStrip segments={segments} className="h-2" /> : null}
        {share !== undefined ? (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(share * 100)}
            className="h-2 overflow-hidden rounded-full bg-on-plum-track"
          >
            <div className="h-full bg-signal" style={{ width: `${share * 100}%` }} />
          </div>
        ) : null}
      </div>
      {stats && stats.length > 0 ? <StatBand stats={stats} /> : null}
    </section>
  );
}
