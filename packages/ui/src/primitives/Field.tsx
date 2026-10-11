import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";

/**
 * A field's frame: lead icon · value · trail action. The frame shows focus (2px ring) and
 * invalid (plum stroke and tint); the control inside stays unstyled.
 */
export const field = cva(
  [
    "flex min-w-0 items-center gap-2 text-fg transition-shadow",
    "focus-within:ring-2 focus-within:ring-focus",
    "has-disabled:text-muted",
  ],
  {
    variants: {
      shape: {
        pill: "h-9 rounded-full px-3.5 text-sm",
        rounded: "min-h-12 rounded-lg py-1.5 pr-1.5 pl-4 text-sm",
        area: "min-h-14 items-start rounded-lg px-3 py-2.5 font-mono text-sm leading-relaxed",
        compact: "rounded-md px-2.5 py-1.5 text-xs",
        box: "h-10 rounded-md px-3 text-md",
      },
      tone: {
        paper: "bg-paper",
        well: "bg-well",
        surface: "bg-surface",
      },
      invalid: {
        true: "inset-ring-2 inset-ring-plum-t bg-t-plum",
        false: "",
      },
    },
    defaultVariants: { shape: "pill", tone: "paper", invalid: false },
  },
);

export type FieldProps = ComponentProps<"div"> &
  VariantProps<typeof field> & {
    lead?: ReactNode;
    trail?: ReactNode;
  };

export function Field({ shape, tone, invalid, lead, trail, className, children, ...props }: FieldProps) {
  return (
    <div className={cn(field({ shape, tone, invalid }), className)} {...props}>
      {lead ? <span className="flex shrink-0 items-center text-muted">{lead}</span> : null}
      {children}
      {trail ? <span className="flex shrink-0 items-center">{trail}</span> : null}
    </div>
  );
}

const control =
  "min-w-0 flex-1 bg-transparent text-inherit outline-none placeholder:text-muted focus-visible:outline-none disabled:cursor-not-allowed";

/** The bare input that sits inside a Field. */
export function FieldInput({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(control, className)} {...props} />;
}

/** The bare textarea that sits inside a Field. */
export function FieldTextarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(control, "resize-none self-stretch", className)} {...props} />;
}
