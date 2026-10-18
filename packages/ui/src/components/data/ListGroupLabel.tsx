import type { ComponentProps } from "react";
import { cn } from "../../cn";

/** A mono caps heading over a group of list items, such as the guild a set of tables belongs to. */
export function ListGroupLabel({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("px-3 pt-4 pb-1.5 type-label text-muted", className)} {...props} />;
}
