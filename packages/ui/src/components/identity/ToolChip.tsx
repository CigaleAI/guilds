import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { Tag } from "../../primitives/Tag";

export type ToolChipProps = Omit<ComponentProps<"span">, "children"> & {
  /** Tool name as the agent calls it, such as `note_find`. */
  name: string;
  /** The ground one step off what it sits on: paper on surface, well on paper. */
  tone?: "paper" | "well";
};

/** A tool an agent can call, named inline. */
export function ToolChip({ name, tone = "paper", className, ...props }: ToolChipProps) {
  return (
    <Tag tone={tone} className={cn("align-baseline text-xs", className)} {...props}>
      {name}
    </Tag>
  );
}
