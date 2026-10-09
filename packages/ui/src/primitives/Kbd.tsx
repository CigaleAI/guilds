import type { ComponentProps } from "react";
import { cn } from "../cn";

/** A key cap, such as ↵ Enter or ⌘K. */
export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center gap-1 rounded-sm bg-paper px-1.5 py-0.5 font-mono text-2xs text-fg shadow-[inset_0_-1.5px_0_var(--line-3)]",
        className,
      )}
      {...props}
    />
  );
}
