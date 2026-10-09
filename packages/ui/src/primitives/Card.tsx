import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";

export const card = cva("min-w-0 overflow-hidden rounded-xl", {
  variants: {
    tone: {
      paper: "bg-paper text-fg",
      surface: "bg-surface text-fg",
      panel: "bg-panel text-on-panel",
      plum: "bg-plum text-on-plum",
    },
  },
  defaultVariants: { tone: "paper" },
});

export type CardProps = ComponentProps<"div"> & VariantProps<typeof card>;

export function Card({ tone, className, ...props }: CardProps) {
  return <div className={cn(card({ tone }), className)} {...props} />;
}

export type CardHeaderProps = Omit<ComponentProps<"div">, "title"> & {
  title: ReactNode;
  /** Tag or count beside the title's row end. */
  meta?: ReactNode;
  /** Trailing control, such as a collapse chevron or an action. */
  trail?: ReactNode;
};

export function CardHeader({ title, meta, trail, className, ...props }: CardHeaderProps) {
  return (
    <div
      className={cn("flex items-center justify-between gap-3 border-b border-line px-4 py-3", className)}
      {...props}
    >
      <div className="min-w-0 truncate text-md font-semibold">{title}</div>
      {meta || trail ? (
        <div className="flex shrink-0 items-center gap-2">
          {meta}
          {trail}
        </div>
      ) : null}
    </div>
  );
}

export function CardBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("px-4 py-3.5 text-sm text-fg-2", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex items-center justify-end gap-1.5 bg-surface px-4 py-2.5 text-fg", className)}
      {...props}
    />
  );
}

/** Cards stacked front to back; each later card tucks under the one above by its own radius. */
export function CardStack({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("isolate flex flex-col", className)} {...props} />;
}

export const cardStackItem = cva("relative min-w-0", {
  variants: {
    tone: {
      panel: "bg-panel text-on-panel",
      plum: "bg-plum text-on-plum",
      signal: "bg-signal text-on-signal",
      paper: "bg-paper text-fg",
    },
    tucked: {
      false: "rounded-lg",
      true: "-mt-5 rounded-b-lg pt-5",
    },
  },
  defaultVariants: { tone: "panel", tucked: false },
});

export type CardStackItemProps = ComponentProps<"div"> &
  Omit<VariantProps<typeof cardStackItem>, "tucked"> & {
    /** 0 is the front card; each level sits behind the one before it. */
    level: number;
  };

export function CardStackItem({ tone, level, className, style, ...props }: CardStackItemProps) {
  return (
    <div
      className={cn(cardStackItem({ tone, tucked: level > 0 }), className)}
      style={{ zIndex: 100 - level, ...style }}
      {...props}
    />
  );
}
