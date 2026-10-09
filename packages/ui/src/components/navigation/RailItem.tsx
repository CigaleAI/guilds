import { cva, type VariantProps } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";
import { Slot } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import { CornerBadge } from "../../primitives/Dot";
import { Icon } from "../../primitives/Icon";

/**
 * A 44 tile on the collapsed rail. Guild tiles are sand and turn plum when selected; tool tiles
 * keep their colour and take an ink ring when open; `add` is the dashed create tile.
 */
export const railItem = cva(
  "inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg text-sm font-bold transition-colors select-none",
  {
    variants: {
      tone: {
        guild: "bg-well text-fg hover:bg-paper selected:bg-plum selected:text-on-plum",
        well: "bg-well text-fg hover:bg-paper",
        plum: "bg-plum text-on-plum hover:opacity-90",
        signal: "bg-signal text-on-signal hover:bg-signal-soft",
        "plum-tint": "bg-t-plum text-plum-t hover:opacity-80",
        "signal-tint": "bg-t-sig text-t-sig-fg hover:opacity-80",
        "tide-tint": "bg-t-tide text-t-tide-fg hover:opacity-80",
        add: "border-[1.5px] border-dashed border-rule-2 text-fg hover:bg-paper",
      },
    },
    compoundVariants: [
      {
        tone: ["well", "plum", "signal", "plum-tint", "signal-tint", "tide-tint"],
        className: "selected:inset-ring-[1.5px] selected:inset-ring-fg",
      },
    ],
    defaultVariants: { tone: "guild" },
  },
);

export type RailItemProps = Omit<ComponentProps<"button">, "children"> &
  VariantProps<typeof railItem> & {
    /** Accessible name: the guild or tool this tile opens. */
    label: string;
    /** Glyph for a tool tile; guild tiles show their initials as children instead. */
    icon?: LucideIcon;
    children?: ReactNode;
    /** A RingDot (activity) or RingCount (waiting items) pinned to the corner. */
    badge?: ReactNode;
    badgeOffset?: "dot" | "count";
    selected?: boolean;
    asChild?: boolean;
  };

/** One guild or workspace tool on the collapsed rail. */
export function RailItem({
  tone,
  label,
  icon,
  children,
  badge,
  badgeOffset = "dot",
  selected,
  asChild,
  className,
  type,
  ...props
}: RailItemProps) {
  const Comp = asChild ? Slot.Root : "button";
  const item = (
    <Comp
      type={asChild ? undefined : (type ?? "button")}
      aria-label={label}
      aria-current={selected ? "page" : undefined}
      className={cn(railItem({ tone }), className)}
      {...props}
    >
      {icon ? <Icon icon={icon} size={18} /> : null}
      <Slot.Slottable>{children}</Slot.Slottable>
    </Comp>
  );
  return badge ? (
    <CornerBadge badge={badge} offset={badgeOffset}>
      {item}
    </CornerBadge>
  ) : (
    item
  );
}
