import { cva, type VariantProps } from "class-variance-authority";
import { Check, X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";
import { Icon } from "./Icon";

const toneFill = {
  signal: "bg-signal",
  tide: "bg-tide",
  dusk: "bg-dusk",
  ochre: "bg-ochre",
  plum: "bg-plum",
  idle: "bg-rule",
} as const;

/** A 6–8px status dot. */
export const dot = cva("inline-block shrink-0 rounded-full", {
  variants: {
    size: { sm: "size-1.5", md: "size-2" },
    tone: toneFill,
  },
  defaultVariants: { size: "md", tone: "signal" },
});

export type DotProps = ComponentProps<"span"> & VariantProps<typeof dot>;

export function Dot({ size, tone, className, ...props }: DotProps) {
  return <span className={cn(dot({ size, tone }), className)} {...props} />;
}

export type CornerBadgeProps = ComponentProps<"span"> & {
  /** A dot or count, pinned to the top-right corner. */
  badge: ReactNode;
  /** Pixels the badge overhangs the corner. */
  offset?: "dot" | "count";
};

/** Pins a ring badge to a tile's corner. The badge ring takes the colour of what sits behind it. */
export function CornerBadge({ badge, offset = "dot", className, children, ...props }: CornerBadgeProps) {
  return (
    <span className={cn("relative inline-flex shrink-0", className)} {...props}>
      {children}
      <span
        className={cn(
          "absolute flex",
          offset === "dot" ? "-top-0.5 -right-0.5" : "-top-1.5 -right-2",
        )}
      >
        {badge}
      </span>
    </span>
  );
}

export const ringDot = cva("block size-3 rounded-full border-[2.5px]", {
  variants: {
    tone: toneFill,
    ring: {
      surface: "border-surface",
      paper: "border-paper",
      well: "border-well",
      page: "border-page",
    },
  },
  defaultVariants: { tone: "signal", ring: "surface" },
});

/** A 12px dot ringed in the colour behind it, for a tile's corner. */
export function RingDot({
  tone,
  ring,
  className,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof ringDot>) {
  return <span className={cn(ringDot({ tone, ring }), className)} {...props} />;
}

export const ringCount = cva(
  "block rounded-full border-[2.5px] px-1.5 text-2xs leading-4 font-bold whitespace-nowrap",
  {
    variants: {
      tone: {
        plum: "bg-plum text-on-plum",
        signal: "bg-signal text-on-signal",
      },
      ring: {
        surface: "border-surface",
        paper: "border-paper",
        well: "border-well",
        page: "border-page",
      },
    },
    defaultVariants: { tone: "plum", ring: "surface" },
  },
);

/** A count ringed in the colour behind it, for a tile's corner. */
export function RingCount({
  tone,
  ring,
  className,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof ringCount>) {
  return <span className={cn(ringCount({ tone, ring }), className)} {...props} />;
}

export type ResultGlyphProps = Omit<ComponentProps<"span">, "children"> & {
  result: "ok" | "failed";
};

/** An 18px result mark: a tide check or a plum cross. */
export function ResultGlyph({ result, className, ...props }: ResultGlyphProps) {
  return (
    <span
      role="img"
      aria-label={result === "ok" ? "Succeeded" : "Failed"}
      className={cn(
        "inline-flex size-4.5 shrink-0 items-center justify-center rounded-full",
        result === "ok" ? "bg-t-tide text-t-tide-fg" : "bg-plum text-on-plum",
        className,
      )}
      {...props}
    >
      <Icon icon={result === "ok" ? Check : X} size={14} />
    </span>
  );
}
