import { Plus } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { IconButton } from "../actions/IconButton";
import { PillCount } from "../../primitives/Pill";

export type SidebarSectionProps = Omit<ComponentProps<"div">, "children"> & {
  /** Section name; shown in mono caps. */
  label: string;
  count?: number;
  onAdd?: () => void;
  /** Accessible name of the add button, such as "Create guild". */
  addLabel?: string;
};

/** The header over a sidebar list: its name, how many it holds, and a button to add one. */
export function SidebarSection({
  label,
  count,
  onAdd,
  addLabel,
  className,
  ...props
}: SidebarSectionProps) {
  return (
    <div className={cn("flex min-h-7 items-center gap-2 px-2", className)} {...props}>
      <h2 className="type-label text-plum-t">{label}</h2>
      {count !== undefined ? (
        <PillCount tone="sand" className="rounded-sm">
          {count}
        </PillCount>
      ) : null}
      {onAdd ? (
        <IconButton
          icon={Plus}
          label={addLabel ?? `Add to ${label.toLowerCase()}`}
          variant="ghost"
          size={28}
          onClick={onAdd}
          className="ml-auto"
        />
      ) : null}
    </div>
  );
}
