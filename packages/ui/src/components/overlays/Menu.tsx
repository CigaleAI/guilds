import { cva, type VariantProps } from "class-variance-authority";
import { Ellipsis, type LucideIcon } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";
import { Kbd } from "../../primitives/Kbd";
import { IconButton, type IconButtonProps } from "../actions/IconButton";

/** A list of actions behind a ⋯ button: rename, export, pause, delete. */
export const Menu = DropdownMenu.Root;

export type MenuTriggerProps = Omit<IconButtonProps, "icon" | "label"> & {
  icon?: LucideIcon;
  /** Accessible name, such as "Agent options". */
  label?: string;
};

/** The ⋯ IconButton that opens a menu. It stays ink while its menu is open. */
export function MenuTrigger({ icon = Ellipsis, label = "More actions", className, ...props }: MenuTriggerProps) {
  return (
    <DropdownMenu.Trigger asChild>
      <IconButton
        icon={icon}
        label={label}
        className={cn(
          "data-[state=open]:bg-ink-fill data-[state=open]:text-on-ink data-[state=open]:hover:bg-ink-fill",
          className,
        )}
        {...props}
      />
    </DropdownMenu.Trigger>
  );
}

/** The menu panel: 8px below its trigger, right-aligned to it. */
export function MenuContent({
  align = "end",
  sideOffset = 8,
  collisionPadding = 8,
  className,
  ...props
}: ComponentProps<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "anim-pop z-50 flex max-w-80 min-w-60 flex-col gap-0.5 rounded-lg bg-paper p-1.5 text-fg shadow-pop outline-none",
          className,
        )}
        {...props}
      />
    </DropdownMenu.Portal>
  );
}

export const menuItem = cva(
  [
    "flex cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-2 text-md select-none focus-visible:-outline-offset-2",
    "data-disabled:cursor-not-allowed data-disabled:text-faint",
  ],
  {
    variants: {
      destructive: {
        true: "text-plum-t data-highlighted:bg-t-plum",
        false: "data-highlighted:bg-well",
      },
    },
    defaultVariants: { destructive: false },
  },
);

export type MenuItemProps = ComponentProps<typeof DropdownMenu.Item> &
  VariantProps<typeof menuItem> & {
    icon?: LucideIcon;
    /** Keyboard shortcut shown at the row's end, such as ⌘R. */
    shortcut?: string;
  };

/** One action. Destructive actions go last, after a separator, in plum. */
export function MenuItem({ icon, shortcut, destructive, className, children, ...props }: MenuItemProps) {
  return (
    <DropdownMenu.Item className={cn(menuItem({ destructive }), className)} {...props}>
      {icon ? <Icon icon={icon} /> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut ? <Kbd className="text-muted">{shortcut}</Kbd> : null}
    </DropdownMenu.Item>
  );
}

/** A hairline between groups of actions. */
export function MenuSeparator({ className, ...props }: ComponentProps<typeof DropdownMenu.Separator>) {
  return <DropdownMenu.Separator className={cn("mx-1.5 my-1 h-px bg-line", className)} {...props} />;
}

/** A mono caption over a group of actions. */
export function MenuLabel({ className, ...props }: ComponentProps<typeof DropdownMenu.Label>) {
  return <DropdownMenu.Label className={cn("px-2.5 pt-2 pb-1 type-label text-muted", className)} {...props} />;
}
