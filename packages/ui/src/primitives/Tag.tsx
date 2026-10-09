import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../cn";

/**
 * Radius 8, never full. Mono for machine values, sans for people.
 * The base of file refs, tool chips, prompt tags, stat chips, terms and counts.
 */
export const tag = cva(
  "inline-flex max-w-full shrink-0 items-center gap-1 rounded-sm px-2 py-0.5 text-2xs whitespace-nowrap",
  {
    variants: {
      tone: {
        paper: "bg-paper text-fg",
        surface: "bg-surface text-fg",
        well: "bg-well text-fg",
        term: "bg-paper text-fg inset-ring inset-ring-line-3",
        ink: "bg-panel text-on-panel",
        signal: "bg-t-sig text-t-sig-fg",
        tide: "bg-t-tide text-t-tide-fg",
        plum: "bg-t-plum text-plum-t",
        ochre: "bg-t-ochre text-t-ochre-fg",
        "on-plum": "bg-on-plum-hover text-on-plum",
        tinted: "bg-fg/10 text-fg",
      },
      font: {
        mono: "font-mono",
        sans: "font-sans text-xs font-bold",
      },
    },
    defaultVariants: { tone: "paper", font: "mono" },
  },
);

export type TagProps = ComponentProps<"span"> & VariantProps<typeof tag>;

export function Tag({ tone, font, className, ...props }: TagProps) {
  return <span className={cn(tag({ tone, font }), className)} {...props} />;
}
