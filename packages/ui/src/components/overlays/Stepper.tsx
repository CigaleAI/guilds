import { Check } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";

type StepState = "done" | "current" | "upcoming";

const barFill: Record<StepState, string> = {
  done: "bg-tide",
  current: "bg-signal",
  upcoming: "bg-well",
};

export type StepperProps = Omit<ComponentProps<"ol">, "children"> & {
  /** Step labels, in order. */
  steps: string[];
  /** Index of the step in progress; every step before it is done. */
  current: number;
};

/**
 * Progress through a multi-step dialog, one segment per step: done steps carry a check on tide,
 * the current one is signal, later ones wait on well. "Step 2 of 4" belongs in the dialog header.
 */
export function Stepper({ steps, current, className, ...props }: StepperProps) {
  return (
    <ol aria-label="Steps" className={cn("flex gap-2", className)} {...props}>
      {steps.map((label, index) => {
        const state: StepState = index < current ? "done" : index === current ? "current" : "upcoming";
        return (
          <li
            key={label}
            aria-current={state === "current" ? "step" : undefined}
            className="flex min-w-0 flex-1 flex-col gap-1.5"
          >
            <span aria-hidden className={cn("h-1 rounded-full", barFill[state])} />
            <span
              className={cn(
                "flex min-w-0 items-center gap-1.5 text-sm font-semibold",
                state === "upcoming" ? "text-muted" : "text-fg",
              )}
            >
              {state === "done" ? (
                <Icon icon={Check} size={14} className="text-tide-t" />
              ) : (
                <span aria-hidden className="font-mono text-2xs">
                  {index + 1}
                </span>
              )}
              <span className="truncate">{label}</span>
              {state === "done" ? <span className="sr-only">(done)</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
