import type { LucideIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";
import { Tile } from "../../primitives/Tile";

export type EmptyStateProps = Omit<ComponentProps<"div">, "title"> & {
  icon: LucideIcon;
  title: ReactNode;
  /** What would be here and how it gets here, in a sentence. */
  description?: ReactNode;
  /** The way forward: a primary Button. */
  action?: ReactNode;
  /** A quieter alternative: a ghost Button or link. */
  secondaryAction?: ReactNode;
  /** Error swaps the well icon tile for plum. */
  tone?: "neutral" | "error";
};

/** Nothing here yet: a centred paper card with an icon, a title, a sentence and the next step. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  tone = "neutral",
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-lg bg-paper px-5 py-7 text-center text-fg",
        className,
      )}
      {...props}
    >
      <Tile size={44} tone={tone === "error" ? "plum" : "well"}>
        <Icon icon={icon} size={20} />
      </Tile>
      <p className="text-lg font-semibold">{title}</p>
      {description ? <p className="max-w-70 text-sm text-pretty text-muted">{description}</p> : null}
      {action || secondaryAction ? (
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}
