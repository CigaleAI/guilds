import { X } from "lucide-react";
import { Popover as RadixPopover } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { IconButton, type IconButtonProps } from "../actions/IconButton";

/** Details and a few actions for something small, such as a timeline mark, opened by clicking it. */
export const Popover = RadixPopover.Root;

/** The element the popover opens from and points at. */
export const PopoverTrigger = RadixPopover.Trigger;

/** Positions the popover against an element other than its trigger. */
export const PopoverAnchor = RadixPopover.Anchor;

/** Closes the popover; wrap an action button with `asChild` when the action should also dismiss it. */
export const PopoverClose = RadixPopover.Close;

/** The popover card: paper, anchored 8px from its trigger. Outside click and Esc close it. */
export function PopoverContent({
  side = "bottom",
  align = "start",
  sideOffset = 8,
  collisionPadding = 8,
  className,
  ...props
}: ComponentProps<typeof RadixPopover.Content>) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "anim-pop z-50 flex w-75 flex-col gap-2.5 rounded-lg bg-paper p-3.5 text-fg shadow-pop outline-none",
          className,
        )}
        {...props}
      />
    </RadixPopover.Portal>
  );
}

export type PopoverCloseButtonProps = Omit<IconButtonProps, "icon" | "label"> & { label?: string };

/** The optional ✕ for a popover's first row; push it to the row's end with `ml-auto`. */
export function PopoverCloseButton({ label = "Close", ...props }: PopoverCloseButtonProps) {
  return (
    <PopoverClose asChild>
      <IconButton icon={X} label={label} variant="ghost" size={28} {...props} />
    </PopoverClose>
  );
}
