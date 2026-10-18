import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../cn";

/** A standalone count, such as unread items on a link. Counts inside a pill use PillCount. */
export const countBadge = cva(
  "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-2 text-xs font-bold whitespace-nowrap tabular-nums select-none",
  {
    variants: {
      tone: {
        plum: "bg-plum text-on-plum",
        accent: "bg-signal text-on-signal",
        sand: "bg-well text-fg",
        ink: "bg-ink-fill text-on-ink",
        "on-plum": "bg-on-plum text-plum",
      },
    },
    defaultVariants: { tone: "plum" },
  },
);

/** A count as a badge shows it: as it is up to 99, then "99+". */
export function cappedCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export type CountBadgeProps = ComponentProps<"span"> & VariantProps<typeof countBadge>;

/** A count of things waiting, such as unread items in the inbox. */
export function CountBadge({ tone, className, ...props }: CountBadgeProps) {
  return <span className={cn(countBadge({ tone }), className)} {...props} />;
}
