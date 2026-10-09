import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../cn";

/**
 * Pill buttons: ink for primary, cyan for the one live action in a view, outline for secondary,
 * ghost for dismissive actions, plum for destructive ones. Primary darkens to plum on hover.
 * `on-plum` and `on-panel` sit on the plum and ink bands that open a guild or a Studio session.
 */
export const button = cva(
  [
    "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-full font-semibold whitespace-nowrap select-none transition-colors",
    "disabled:cursor-not-allowed disabled:bg-well disabled:text-faint disabled:shadow-none",
    "aria-disabled:cursor-not-allowed aria-disabled:bg-well aria-disabled:text-faint aria-disabled:shadow-none",
  ],
  {
    variants: {
      variant: {
        primary: "bg-ink-fill text-on-ink hover:bg-plum hover:text-on-plum",
        accent: "bg-signal text-on-signal hover:bg-signal-soft",
        outline: "text-fg inset-ring-[1.5px] inset-ring-fg hover:bg-paper",
        secondary: "bg-paper text-fg hover:bg-paper-hi",
        ghost: "text-fg hover:bg-well",
        danger: "text-plum-t inset-ring-[1.5px] inset-ring-plum-t hover:bg-t-plum",
        destructive: "bg-plum text-on-plum hover:opacity-90",
        "on-plum": "text-on-plum inset-ring-[1.5px] inset-ring-on-plum hover:bg-on-plum-hover",
        "on-panel": [
          "text-on-panel-muted hover:bg-on-panel/10 hover:text-on-panel",
          "disabled:bg-transparent disabled:text-on-panel-muted/50 aria-disabled:bg-transparent aria-disabled:text-on-panel-muted/50",
        ],
      },
      size: {
        xs: "h-6 px-2.5 text-xs",
        sm: "h-7 px-3 text-xs",
        md: "h-8 px-3.5 text-sm",
        lg: "h-9 px-4 text-sm",
        xl: "h-10 px-5 text-md",
        "2xl": "h-11 px-6 text-md",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof button> & {
    /** Render the child element (a link) with button styles. */
    asChild?: boolean;
  };

export function Button({ variant, size, asChild, className, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      type={asChild ? undefined : (type ?? "button")}
      className={cn(button({ variant, size }), className)}
      {...props}
    />
  );
}
