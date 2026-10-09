import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../cn";

/**
 * A well track holding pill items. The base of segmented controls, tabs, scope tabs and On/Off.
 * Items use the `selected:` variant, so the same recipe styles ToggleGroup items, Tabs triggers and
 * plain buttons with `aria-pressed`.
 */
export const track = cva("inline-flex w-fit max-w-full items-center rounded-full whitespace-nowrap", {
  variants: {
    size: {
      sm: "p-0.5",
      md: "gap-0.5 p-1",
    },
    tone: {
      well: "bg-well text-fg",
      "on-plum": "bg-on-plum-track text-on-plum",
    },
  },
  defaultVariants: { size: "md", tone: "well" },
});

export type TrackProps = ComponentProps<"div"> & VariantProps<typeof track>;

export function Track({ size, tone, className, ...props }: TrackProps) {
  return <div className={cn(track({ size, tone }), className)} {...props} />;
}

export const trackItem = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full font-semibold whitespace-nowrap select-none",
    "cursor-pointer transition-colors disabled:cursor-default disabled:text-faint",
  ],
  {
    variants: {
      size: {
        sm: "h-6 px-2.5 text-xs",
        md: "h-7 px-3 text-sm",
        lg: "h-8 px-3.5 text-sm",
      },
      /** Fill of the selected item: ink for navigation, accent for On, plum for Off or overrides. */
      selectedFill: {
        ink: "selected:bg-ink-fill selected:text-on-ink",
        accent: "selected:bg-signal selected:text-on-signal",
        plum: "selected:bg-plum selected:text-on-plum",
        paper: "selected:bg-paper selected:text-fg",
      },
      /** Unselected items read quieter on On/Off switches. */
      quiet: {
        true: "text-muted",
        false: "",
      },
    },
    defaultVariants: { size: "md", selectedFill: "ink", quiet: false },
  },
);

export type TrackItemProps = ComponentProps<"button"> & VariantProps<typeof trackItem>;

/** A plain track item button; pass `aria-pressed` for its selected state. */
export function TrackItem({ size, selectedFill, quiet, className, type = "button", ...props }: TrackItemProps) {
  return <button type={type} className={cn(trackItem({ size, selectedFill, quiet }), className)} {...props} />;
}
