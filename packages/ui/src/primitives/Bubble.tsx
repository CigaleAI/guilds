import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../cn";

/** Agents speak on paper, people on a soft plum ground with a tail corner, traces are ink and mono. */
export const bubble = cva("min-w-0", {
  variants: {
    variant: {
      agent: "max-w-[85%] rounded-xl bg-paper px-4 py-3 text-sm text-fg",
      human: "max-w-[85%] self-end rounded-xl rounded-br-sm bg-t-plum px-4 py-3 text-sm text-fg",
      trace: "rounded-lg bg-panel px-4 py-3 font-mono text-xs text-on-panel",
    },
  },
  defaultVariants: { variant: "agent" },
});

export type BubbleProps = ComponentProps<"div"> & VariantProps<typeof bubble>;

export function Bubble({ variant, className, ...props }: BubbleProps) {
  return <div className={cn(bubble({ variant }), className)} {...props} />;
}
