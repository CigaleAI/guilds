import type { ComponentProps } from "react";
import { cn } from "../../cn";

export type HighlightBadgeProps = ComponentProps<"span"> & {
  size?: "sm" | "md";
};

/** The one figure worth noticing in a row, in cyan: "54 available". */
export function HighlightBadge({ size = "md", className, ...props }: HighlightBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full bg-signal font-bold whitespace-nowrap text-on-signal select-none",
        size === "md" ? "h-6 px-2.5 text-xs" : "h-5 px-2 text-2xs",
        className,
      )}
      {...props}
    />
  );
}
