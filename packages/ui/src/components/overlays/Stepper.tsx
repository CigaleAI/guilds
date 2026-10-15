import { Check, TriangleAlert } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";

type StepState = "done" | "current" | "upcoming";

const barFill: Record<StepState, string> = {
  done: "bg-tide",
  current: "bg-signal",
  upcoming: "bg-well",
};

export type StepperProps = Omit<ComponentProps<"ol">, "children" | "onSelect"> & {
  /** Step labels, in order. */
  steps: string[];
  /** Index of the step in progress; every step before it is done, unless `onSelect` is set. */
  current: number;
  /**
   * Makes every step a button that opens it, for steps that are sections to visit in any order
   * rather than progress: no step is marked done then.
   */
  onSelect?: (index: number) => void;
  /** Indexes of the steps that need attention; each carries a warning in place of its number. */
  flagged?: readonly number[];
};

/**
 * Progress through a multi-step dialog, one segment per step: done steps carry a check on tide,
 * the current one is signal, later ones wait on well. "Step 2 of 4" belongs in the dialog header.
 * With `onSelect`, the steps are sections opened in any order.
 */
export function Stepper({
  steps,
  current,
  onSelect,
  flagged = [],
  className,
  ...props
}: StepperProps) {
  return (
    <ol aria-label="Steps" className={cn("flex gap-2", className)} {...props}>
      {steps.map((label, index) => {
        const state: StepState =
          index === current ? "current" : index < current && !onSelect ? "done" : "upcoming";
        const warn = flagged.includes(index);
        const content = (
          <>
            <span aria-hidden className={cn("h-1 rounded-full", barFill[state])} />
            <span
              className={cn(
                "flex min-w-0 items-center gap-1.5 text-sm font-semibold",
                state === "upcoming" ? "text-muted group-hover:text-fg" : "text-fg",
              )}
            >
              {warn ? (
                <Icon icon={TriangleAlert} size={14} className="text-t-ochre-fg" />
              ) : state === "done" ? (
                <Icon icon={Check} size={14} className="text-tide-t" />
              ) : (
                <span aria-hidden className="font-mono text-2xs">
                  {index + 1}
                </span>
              )}
              <span className="truncate">{label}</span>
              {state === "done" ? <span className="sr-only">(done)</span> : null}
              {warn ? <span className="sr-only">(needs attention)</span> : null}
            </span>
          </>
        );
        return (
          <li
            key={label}
            aria-current={state === "current" ? "step" : undefined}
            className="flex min-w-0 flex-1 flex-col gap-1.5"
          >
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(index)}
                className="group flex min-w-0 cursor-pointer flex-col gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                {content}
              </button>
            ) : (
              content
            )}
          </li>
        );
      })}
    </ol>
  );
}
