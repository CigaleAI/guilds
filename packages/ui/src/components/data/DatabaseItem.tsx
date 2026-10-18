import { Database } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";

export type DatabaseItemProps = Omit<ComponentProps<"button">, "children"> & {
  name: string;
  purpose: string;
  /** Live records. */
  count: number;
  /** Time since the definition last changed, such as "3d". */
  age: string;
  selected?: boolean;
  /** Plain rows sit on surface; paper rows stand on their own. */
  tone?: "plain" | "paper";
};

/** A table in the Tables list: name, purpose, record count and age. */
export function DatabaseItem({
  name,
  purpose,
  count,
  age,
  selected = false,
  tone = "plain",
  className,
  type = "button",
  ...props
}: DatabaseItemProps) {
  return (
    <button
      type={type}
      data-selected={selected ? "true" : undefined}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "group/db flex w-full min-w-0 cursor-pointer gap-2.5 rounded-lg px-3 py-2.5 text-left text-fg transition-colors",
        tone === "paper" ? "bg-paper hover:bg-paper-hi" : "hover:bg-paper",
        "selected:bg-plum selected:text-on-plum",
        className,
      )}
      {...props}
    >
      <Icon icon={Database} size={14} className="mt-1" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 truncate text-md font-semibold">{name}</span>
          <span className="shrink-0 rounded-sm bg-well px-1.5 font-mono text-2xs text-fg group-data-[selected=true]/db:bg-signal group-data-[selected=true]/db:text-on-signal">
            {count}
            <span className="sr-only"> records</span>
          </span>
        </span>
        <span className="flex min-w-0 items-center justify-between gap-2 text-xs text-muted group-data-[selected=true]/db:text-on-plum-muted">
          <span className="min-w-0 truncate">{purpose}</span>
          <span className="shrink-0 font-mono">{age}</span>
        </span>
      </span>
    </button>
  );
}
