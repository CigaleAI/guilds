import type { ComponentProps } from "react";
import { cn } from "../../cn";

export type IdCellProps = Omit<ComponentProps<"span">, "children"> & { value: string | number };

/** A record id in its table column: mono, "#1". */
export function IdCell({ value, className, ...props }: IdCellProps) {
  return (
    <span className={cn("font-mono text-xs font-medium whitespace-nowrap text-fg", className)} {...props}>
      #{value}
    </span>
  );
}
