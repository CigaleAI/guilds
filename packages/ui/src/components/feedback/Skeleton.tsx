import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { useDelayedVisible } from "./useDelayedVisible";

export const skeleton = cva("anim-pulse block shrink-0 bg-well", {
  variants: {
    shape: {
      line: "h-3 rounded-xs",
      block: "rounded-md",
      pill: "h-5 rounded-full",
      circle: "rounded-full",
      tile: "size-11 rounded-lg",
    },
  },
  defaultVariants: { shape: "line" },
});

export type SkeletonProps = ComponentProps<"div"> & VariantProps<typeof skeleton>;

/** A pulsing well block standing in for content that is loading. Size it with classes. */
export function Skeleton({ shape, className, ...props }: SkeletonProps) {
  return <div aria-hidden className={cn(skeleton({ shape }), className)} {...props} />;
}

export type SkeletonGroupProps = ComponentProps<"div"> & {
  /** Milliseconds before the placeholders appear; 0 shows them at once. */
  delay?: number;
  /** Announced to screen readers while the placeholders show. */
  label?: string;
};

/** Holds a loading layout of skeletons. It renders nothing for the first 300ms so fast loads never flash. */
export function SkeletonGroup({ delay = 300, label = "Loading", className, children, ...props }: SkeletonGroupProps) {
  const visible = useDelayedVisible(delay);
  if (!visible) return null;
  return (
    <div role="status" className={cn("flex min-w-0 flex-col gap-3", className)} {...props}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** One table cell's placeholder: a short id, flexible text, a status pill or a short meta value. */
export type SkeletonColumn = "id" | "text" | "pill" | "meta";

const columnCell: Record<SkeletonColumn, SkeletonProps> = {
  id: { className: "w-10" },
  text: { className: "min-w-0 flex-1" },
  pill: { shape: "pill", className: "w-18" },
  meta: { className: "w-14" },
};

export type SkeletonRowsProps = Omit<SkeletonGroupProps, "children"> & {
  rows?: number;
  /** list: a tile and three lines per item. table: one placeholder per cell. */
  layout?: "list" | "table";
  /** Table cells, left to right. */
  columns?: SkeletonColumn[];
};

/** Placeholder rows that mirror the list or table about to load. */
export function SkeletonRows({
  rows = 3,
  layout = "table",
  columns = ["id", "text", "pill", "meta"],
  ...props
}: SkeletonRowsProps) {
  return (
    <SkeletonGroup {...props}>
      {Array.from({ length: rows }, (_, row) =>
        layout === "list" ? (
          <div key={row} className="flex gap-3">
            <Skeleton shape="tile" />
            <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
              <Skeleton className="w-3/10" />
              <Skeleton className="w-9/10" />
              <Skeleton className="w-7/10" />
            </div>
          </div>
        ) : (
          <div key={row} className="flex items-center gap-3">
            {columns.map((column, index) => (
              <Skeleton key={index} {...columnCell[column]} />
            ))}
          </div>
        ),
      )}
    </SkeletonGroup>
  );
}
