import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { MarkSquare } from "../../primitives/Mark";
import { wakeOutcomeLabel, type WakeOutcome } from "../../tones";

const allOutcomes: WakeOutcome[] = ["posted", "wrote", "silent", "failed", "running"];

export type OutcomeLegendProps = Omit<ComponentProps<"ul">, "children"> & {
  /** Caption before the swatches, such as "Each wake:". */
  lead?: string;
  outcomes?: WakeOutcome[];
};

/** The key to wake shading in Studio's activity views. */
export function OutcomeLegend({
  lead,
  outcomes = allOutcomes,
  className,
  ...props
}: OutcomeLegendProps) {
  return (
    <ul
      aria-label={lead ?? "Wake outcomes"}
      className={cn("flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-xs text-fg-2", className)}
      {...props}
    >
      {lead ? (
        <li aria-hidden className="text-muted">
          {lead}
        </li>
      ) : null}
      {outcomes.map((outcome) => (
        <li key={outcome} className="flex items-center gap-1.5">
          <MarkSquare outcome={outcome} className="size-2.5" />
          {wakeOutcomeLabel[outcome]}
        </li>
      ))}
    </ul>
  );
}
