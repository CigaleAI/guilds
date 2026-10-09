import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";

export type Stat = {
  value: ReactNode;
  /** What the value counts, under it. */
  label: ReactNode;
};

export type StatBandProps = Omit<ComponentProps<"dl">, "children"> & {
  stats: Stat[];
};

/** The cyan band under a feature block: the breakdown or the facts behind the headline, 2–4 cells. */
export function StatBand({ stats, className, ...props }: StatBandProps) {
  return (
    <dl
      className={cn("grid auto-cols-fr grid-flow-col bg-signal text-on-signal", className)}
      {...props}
    >
      {stats.map((stat, index) => (
        <div
          key={index}
          className="flex min-w-0 flex-col-reverse px-5 py-3.5 not-first:border-l not-first:border-on-signal-line"
        >
          <dt className="truncate text-xs">{stat.label}</dt>
          <dd className="truncate text-xl font-semibold">{stat.value}</dd>
        </div>
      ))}
    </dl>
  );
}
