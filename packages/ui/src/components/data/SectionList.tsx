import { ChevronDown } from "lucide-react";
import { Collapsible } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";
import { PillCount } from "../../primitives/Pill";
import { ListGroupLabel } from "./ListGroupLabel";

export type SectionListProps = Omit<ComponentProps<"section">, "children"> & {
  /** Section name; shown in mono caps. */
  label: string;
  /** Items in the section. */
  count: number;
  /** Shown in place of the items when the section holds none. */
  empty?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The section's items, as Rows. */
  children?: ReactNode;
};

/** A named group of list items that folds closed under its label, with how many it holds. */
export function SectionList({
  label,
  count,
  empty,
  open,
  defaultOpen = true,
  onOpenChange,
  children,
  className,
  ...props
}: SectionListProps) {
  return (
    <Collapsible.Root
      asChild
      {...(open !== undefined ? { open } : { defaultOpen })}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <section aria-label={label} className={cn("flex flex-col", className)} {...props}>
        <ListGroupLabel className="px-1 pb-1">
          <Collapsible.Trigger className="group/section flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            <Icon
              icon={ChevronDown}
              size={14}
              className="transition-transform group-data-[state=closed]/section:-rotate-90"
            />
            <span className="min-w-0 truncate">{label}</span>
            <PillCount tone="sand" className="rounded-sm">
              {count}
            </PillCount>
          </Collapsible.Trigger>
        </ListGroupLabel>
        <Collapsible.Content className="flex flex-col gap-1">
          {count ? (
            children
          ) : empty !== undefined ? (
            <div className="px-3 py-1.5 text-sm text-muted">{empty}</div>
          ) : null}
        </Collapsible.Content>
      </section>
    </Collapsible.Root>
  );
}
