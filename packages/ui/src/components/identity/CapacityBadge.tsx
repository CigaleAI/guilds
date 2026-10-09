import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../cn";

/**
 * `dusk` on the plum guild header, `sand` on a sidebar guild row, `accent` on the selected one.
 * `sm` is the compact "2/15" of a row; `md` the spaced "4 / 15" of a header.
 */
export const capacityBadge = cva(
  "inline-flex shrink-0 items-center rounded-full font-mono whitespace-nowrap tabular-nums select-none",
  {
    variants: {
      tone: {
        dusk: "bg-dusk text-on-plum",
        sand: "bg-well text-fg",
        accent: "bg-signal text-on-signal",
      },
      size: {
        sm: "h-5 px-2 text-2xs font-medium",
        md: "h-6 px-2.5 text-xs font-bold",
      },
    },
    defaultVariants: { tone: "dusk", size: "md" },
  },
);

export type CapacityBadgeProps = Omit<ComponentProps<"span">, "children"> &
  VariantProps<typeof capacityBadge> & {
    /** Agents in the guild. */
    count: number;
    /** The guild's agent limit (`max_agents`). */
    max: number;
  };

/** How many of a guild's agent seats are taken. */
export function CapacityBadge({ count, max, tone, size, className, ...props }: CapacityBadgeProps) {
  const label = `${count} of ${max} agents`;
  return (
    <span title={label} className={cn(capacityBadge({ tone, size }), className)} {...props}>
      <span aria-hidden>{size === "sm" ? `${count}/${max}` : `${count} / ${max}`}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
