import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps, ElementType } from "react";
import { cn } from "../cn";

/**
 * The nine text styles. Manrope is for people; JetBrains Mono (label, code, meta) is for anything
 * a machine wrote. Each style carries its default colour; `tone` overrides it.
 */
export const text = cva("", {
  variants: {
    variant: {
      display: "type-display",
      hero: "type-hero",
      h1: "type-h1",
      h2: "type-h2",
      title: "type-title",
      body: "type-body",
      caption: "type-caption",
      label: "type-label",
      code: "type-code",
      meta: "type-meta",
    },
    tone: {
      default: "",
      inherit: "text-inherit",
      fg: "text-fg",
      secondary: "text-fg-2",
      muted: "text-muted",
      faint: "text-faint",
      accent: "text-signal-t",
      success: "text-tide-t",
      danger: "text-plum-t",
    },
    truncate: {
      true: "truncate",
      false: "",
    },
  },
  compoundVariants: [
    { variant: "body", tone: "default", className: "text-fg-2" },
    { variant: "caption", tone: "default", className: "text-muted" },
    { variant: "meta", tone: "default", className: "text-muted" },
    { variant: "label", tone: "default", className: "text-plum-t" },
  ],
  defaultVariants: { variant: "body", tone: "default", truncate: false },
});

const defaultElement: Record<NonNullable<VariantProps<typeof text>["variant"]>, ElementType> = {
  display: "p",
  hero: "p",
  h1: "h1",
  h2: "h2",
  title: "h3",
  body: "p",
  caption: "p",
  label: "span",
  code: "code",
  meta: "span",
};

export type TextProps = ComponentProps<"p"> &
  VariantProps<typeof text> & {
    /** Element to render; defaults to the style's natural element (h1 for h1, code for code). */
    as?: ElementType;
  };

export function Text({ variant, tone, truncate, as, className, ...props }: TextProps) {
  const Comp = as ?? defaultElement[variant ?? "body"];
  return <Comp className={cn(text({ variant, tone, truncate }), className)} {...props} />;
}
