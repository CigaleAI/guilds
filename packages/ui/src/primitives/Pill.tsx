import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../cn";

/** Size × fill. The base of button, badge, tab item, segment, agent chip and filter. */
export const pill = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full font-semibold whitespace-nowrap select-none",
  {
    variants: {
      size: {
        xs: "h-6 px-2.5 text-xs",
        sm: "h-7 px-3 text-xs",
        md: "h-8 px-3.5 text-sm",
        lg: "h-10 px-5 text-md",
        xl: "h-12 px-6 text-lg",
      },
      fill: {
        ink: "bg-ink-fill text-on-ink",
        accent: "bg-signal text-on-signal",
        plum: "bg-plum text-on-plum",
        "signal-tint": "bg-t-sig text-t-sig-fg",
        "tide-tint": "bg-t-tide text-t-tide-fg",
        "plum-tint": "bg-t-plum text-plum-t",
        "ochre-tint": "bg-t-ochre text-t-ochre-fg",
        sand: "bg-well text-fg",
        paper: "bg-paper text-fg",
        outline: "text-fg inset-ring-[1.5px] inset-ring-fg",
        "outline-on-plum": "text-on-plum inset-ring-[1.5px] inset-ring-on-plum",
        danger: "text-plum-t inset-ring-[1.5px] inset-ring-plum-t",
        ghost: "text-fg",
        disabled: "bg-well text-muted",
      },
    },
    defaultVariants: { size: "sm", fill: "ink" },
  },
);

export type PillProps = ComponentProps<"span"> & VariantProps<typeof pill>;

/** A static pill. Interactive pills are Button, tab items and segments. */
export function Pill({ size, fill, className, ...props }: PillProps) {
  return <span className={cn(pill({ size, fill }), className)} {...props} />;
}

export const pillCount = cva("inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1.5 text-2xs font-bold", {
  variants: {
    tone: {
      plum: "bg-plum text-on-plum",
      accent: "bg-signal text-on-signal",
      ink: "bg-ink-fill text-on-ink",
      sand: "bg-well text-fg",
      "on-ink": "bg-on-ink text-ink-fill",
    },
  },
  defaultVariants: { tone: "plum" },
});

/** A count carried inside a pill, such as a tab's open issues. */
export function PillCount({
  tone,
  className,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof pillCount>) {
  return <span className={cn(pillCount({ tone }), className)} {...props} />;
}
