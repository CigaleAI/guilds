import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../cn";

/**
 * Grounds nest one step lighter: page › well › surface › paper. Panel (ink) carries emphasis and
 * machine output; plum carries selection and people. Inner radius = outer radius − padding.
 */
export const surface = cva("min-w-0", {
  variants: {
    tone: {
      page: "bg-page text-fg",
      well: "bg-well text-fg",
      surface: "bg-surface text-fg",
      paper: "bg-paper text-fg",
      panel: "bg-panel text-on-panel",
      plum: "bg-plum text-on-plum",
    },
    radius: {
      none: "rounded-none",
      md: "rounded-md",
      lg: "rounded-lg",
      xl: "rounded-xl",
      "2xl": "rounded-2xl",
      "3xl": "rounded-3xl",
    },
  },
  defaultVariants: { tone: "surface", radius: "xl" },
});

export type SurfaceProps = ComponentProps<"div"> &
  VariantProps<typeof surface> & {
    /** Render the child element with the surface styles instead of a div. */
    asChild?: boolean;
  };

export function Surface({ tone, radius, asChild, className, ...props }: SurfaceProps) {
  const Comp = asChild ? Slot.Root : "div";
  return <Comp className={cn(surface({ tone, radius }), className)} {...props} />;
}
