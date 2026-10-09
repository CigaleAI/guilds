import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { Tag } from "../../primitives/Tag";

export type StatChipProps = ComponentProps<"span"> & {
  /** The ground one step lighter than what it sits on: paper on surface, well on paper. */
  tone?: "paper" | "well";
  size?: "sm" | "md";
};

/** A machine-measured figure of a run: steps, tokens, cost, calls. */
export function StatChip({ tone = "paper", size = "md", className, ...props }: StatChipProps) {
  return (
    <Tag
      tone={tone}
      className={cn("tabular-nums", size === "md" && "text-xs", className)}
      {...props}
    />
  );
}
