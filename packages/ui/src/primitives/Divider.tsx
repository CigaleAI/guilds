import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";

/** A hairline. */
export function Divider({
  orientation = "horizontal",
  className,
  ...props
}: ComponentProps<"div"> & { orientation?: "horizontal" | "vertical" }) {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={cn(
        "shrink-0 bg-line",
        orientation === "horizontal" ? "h-px w-full" : "w-px self-stretch",
        className,
      )}
      {...props}
    />
  );
}

/** A hairline broken by a mono label, such as a routine boundary in a chat. */
export function LabelledDivider({
  label,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & { label: ReactNode }) {
  return (
    <div
      role="separator"
      className={cn("flex items-center gap-3 type-meta text-muted", className)}
      {...props}
    >
      <span className="h-px flex-1 bg-line-3" />
      <span className="shrink-0">{label}</span>
      <span className="h-px flex-1 bg-line-3" />
    </div>
  );
}

/** A dashed frame around things that happen together: parallel calls, pending items. */
export function DashedGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("rounded-lg border-[1.5px] border-dashed border-rule p-2.5", className)}
      {...props}
    />
  );
}

/** A left rail that shows nesting, as under a guild in the sidebar. */
export function TreeRail({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("ml-3 border-l-[1.5px] border-line-3 pl-3", className)} {...props} />;
}
