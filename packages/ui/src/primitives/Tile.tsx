import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../cn";

/**
 * A square that holds initials, mascot art, a logo or an icon. Radius steps with size:
 * 24–28 → 8 · 32–36 → 12 · 44 → 16 · 64 → 24. The base of avatars, icon buttons, logos and rail items.
 */
export const tile = cva(
  "inline-flex shrink-0 items-center justify-center overflow-hidden font-bold select-none",
  {
    variants: {
      size: {
        24: "size-6 rounded-sm text-2xs",
        28: "size-7 rounded-sm text-2xs",
        32: "size-8 rounded-md text-2xs",
        36: "size-9 rounded-md text-2xs",
        44: "size-11 rounded-lg text-md",
        64: "size-16 rounded-xl text-2xl",
      },
      tone: {
        signal: "bg-signal text-on-signal",
        "signal-2": "bg-signal-2 text-on-signal",
        tide: "bg-tide text-on-plum",
        dusk: "bg-dusk text-on-plum",
        plum: "bg-plum text-on-plum",
        mauve: "bg-mauve text-on-signal",
        ochre: "bg-ochre text-on-ochre",
        ink: "bg-ink-fill text-on-ink",
        paper: "bg-paper text-fg",
        well: "bg-well text-fg",
        surface: "bg-surface text-fg",
        "signal-tint": "bg-t-sig text-t-sig-fg",
        "tide-tint": "bg-t-tide text-t-tide-fg",
        "plum-tint": "bg-t-plum text-plum-t",
        outline: "text-fg inset-ring-[1.5px] inset-ring-rule-2",
        dashed: "border-[1.5px] border-dashed border-rule-2 text-fg",
        "on-plum": "bg-on-plum-hover text-on-plum",
      },
    },
    defaultVariants: { size: 36, tone: "well" },
  },
);

export type TileProps = Omit<ComponentProps<"span">, "children"> &
  VariantProps<typeof tile> & {
    children?: ComponentProps<"span">["children"];
    asChild?: boolean;
  };

export function Tile({ size, tone, asChild, className, ...props }: TileProps) {
  const Comp = asChild ? Slot.Root : "span";
  return <Comp className={cn(tile({ size, tone }), className)} {...props} />;
}
