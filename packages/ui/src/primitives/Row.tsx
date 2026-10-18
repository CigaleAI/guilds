import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";

/**
 * Lead · body · trail. The base of guild and agent rows, tool rows, table and file items,
 * select rows, utility links, step rows, tool calls and table rows.
 *
 * Selected rows fill plum and are the only plum row in their list. Rows set `data-selected`, so
 * children can switch colour with `group-data-[selected=true]/row:…`.
 */
export const row = cva("group/row flex min-w-0 items-center gap-2 text-left text-fg", {
  variants: {
    density: {
      compact: "rounded-md px-2.5 py-1.5",
      default: "rounded-lg p-2.5",
      roomy: "rounded-lg px-3.5 py-3",
    },
    tone: {
      plain: "",
      paper: "bg-paper",
      surface: "bg-surface",
    },
    interactive: {
      true: "cursor-pointer transition-colors hover:bg-paper-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
      false: "",
    },
    selected: {
      true: "bg-plum text-on-plum hover:bg-plum",
      false: "",
    },
    danger: {
      true: "bg-t-plum text-plum-t",
      false: "",
    },
    disabled: {
      true: "pointer-events-none text-muted",
      false: "",
    },
  },
  compoundVariants: [{ tone: "plain", interactive: true, className: "hover:bg-paper" }],
  defaultVariants: {
    density: "default",
    tone: "plain",
    interactive: false,
    selected: false,
    danger: false,
    disabled: false,
  },
});

export type RowProps = Omit<ComponentProps<"div">, "title"> &
  VariantProps<typeof row> & {
    lead?: ReactNode;
    title?: ReactNode;
    /** Caption under the title; truncates. */
    meta?: ReactNode;
    trail?: ReactNode;
    /** Title in mono for machine names (agents, tools, files). */
    mono?: boolean;
    /** Render the child element (a button or link) as the row; lead, body and trail go inside it. */
    asChild?: boolean;
  };

export function Row({
  density,
  tone,
  interactive,
  selected,
  danger,
  disabled,
  lead,
  title,
  meta,
  trail,
  mono,
  asChild,
  className,
  children,
  ...props
}: RowProps) {
  const Comp = asChild ? Slot.Root : "div";
  const body =
    title !== undefined || meta !== undefined ? (
      <div className="flex min-w-0 flex-1 flex-col">
        {title !== undefined ? (
          <span className={cn("truncate text-sm", mono ? "font-mono font-medium" : "font-semibold")}>
            {title}
          </span>
        ) : null}
        {meta !== undefined ? (
          <span className="truncate text-xs text-muted group-data-[selected=true]/row:text-on-plum-muted">
            {meta}
          </span>
        ) : null}
      </div>
    ) : null;

  return (
    <Comp
      data-selected={selected ? "true" : undefined}
      aria-disabled={disabled || undefined}
      className={cn(row({ density, tone, interactive, selected, danger, disabled }), className)}
      {...props}
    >
      {lead ? <span className="flex shrink-0 items-center">{lead}</span> : null}
      {body}
      <Slot.Slottable>{children}</Slot.Slottable>
      {trail ? <span className="ml-auto flex shrink-0 items-center gap-2">{trail}</span> : null}
    </Comp>
  );
}
