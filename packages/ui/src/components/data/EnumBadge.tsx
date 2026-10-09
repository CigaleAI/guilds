import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../cn";

export const enumBadge = cva(
  "inline-flex h-5 max-w-full shrink-0 items-center rounded-full px-2.5 text-xs font-bold whitespace-nowrap",
  {
    variants: {
      tone: {
        signal: "bg-signal text-on-signal",
        "signal-tint": "bg-t-sig text-t-sig-fg group-data-[selected=true]/tr:bg-paper",
        tide: "bg-t-tide text-t-tide-fg",
        plum: "bg-t-plum text-plum-t",
        ochre: "bg-t-ochre text-t-ochre-fg",
        sand: "bg-well text-fg",
        ink: "bg-ink-fill text-on-ink",
      },
    },
    defaultVariants: { tone: "sand" },
  },
);

export type EnumBadgeTone = NonNullable<VariantProps<typeof enumBadge>["tone"]>;

export type EnumBadgeProps = ComponentProps<"span"> & VariantProps<typeof enumBadge>;

/**
 * A column's enumerated value, such as a stage, as a pill. The caller picks the tone per value; the
 * cyan tint turns paper inside a selected table row, which is itself cyan.
 */
export function EnumBadge({ tone, className, ...props }: EnumBadgeProps) {
  return <span className={cn(enumBadge({ tone }), className)} {...props} />;
}
