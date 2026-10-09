import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { DashedGroup } from "../../primitives/Divider";

export type CallBatchProps = ComponentProps<"div"> & {
  /** How many calls the model requested in this step. */
  count: number;
  /** Their summed run time, formatted ("35ms"). */
  duration?: string;
  /** How many of them failed. */
  failed?: number;
};

/** The calls one step requested together, run in order; lays its ToolCalls two abreast when there is room. An expanded call stacks the batch so that call's detail stays in its own card. */
export function CallBatch({
  count,
  duration,
  failed = 0,
  className,
  children,
  ...props
}: CallBatchProps) {
  const order = [`ran 1 → ${count} in order`, duration, failed ? `${failed} failed` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <DashedGroup
      className={cn("@container flex min-w-0 flex-col gap-2.5 p-3", className)}
      {...props}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-2.5 gap-y-1">
        <span className="type-label text-fg">{count} calls requested together</span>
        <span className={cn("type-meta", failed ? "text-plum-t" : "text-muted")}>{order}</span>
      </div>
      <div className="grid grid-cols-1 gap-2 @2xl:grid-cols-2 @2xl:has-[[data-expanded=true]]:grid-cols-1">
        {children}
      </div>
    </DashedGroup>
  );
}
