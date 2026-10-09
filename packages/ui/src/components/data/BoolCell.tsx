import type { ComponentProps } from "react";
import { cn } from "../../cn";

export type BoolCellProps = Omit<ComponentProps<"span">, "children"> & { value: boolean };

/** A boolean record value: true on a cyan tint (paper inside a selected table row), false outlined. */
export function BoolCell({ value, className, ...props }: BoolCellProps) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full px-2.5 font-mono text-2xs font-bold whitespace-nowrap",
        value ? "bg-t-sig text-t-sig-fg group-data-[selected=true]/tr:bg-paper" : "text-muted inset-ring inset-ring-rule",
        className,
      )}
      {...props}
    >
      {value ? "true" : "false"}
    </span>
  );
}
