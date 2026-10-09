import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { Tag } from "../../primitives/Tag";

/** A machine term quoted in prose: an identifier, a status code, a key name. */
export function Term({ className, ...props }: ComponentProps<"span">) {
  return <Tag tone="term" className={cn("align-baseline text-xs", className)} {...props} />;
}
