import { Dialog as RadixDialog } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { dialogScrim } from "./Dialog";

/** A large modal sheet for one object, such as the agent inspector. The caller builds its header. */
export const Sheet = RadixDialog.Root;

/** The element that opens a sheet. */
export const SheetTrigger = RadixDialog.Trigger;

/** Closes the sheet; wrap the header's close IconButton with `asChild`. */
export const SheetClose = RadixDialog.Close;

/** Names the sheet for assistive tech; wrap the visible name in the header, such as the agent handle. */
export const SheetTitle = RadixDialog.Title;

/** Supporting line under the title, linked as the sheet's description. */
export const SheetDescription = RadixDialog.Description;

export type SheetContentProps = ComponentProps<typeof RadixDialog.Content> & {
  /** Fill the whole window instead of the 1100px sheet. */
  expanded?: boolean;
};

/**
 * The sheet panel: 1100 wide and as tall as the window allows, or the full window when expanded.
 * On a phone it always fills the window.
 */
export function SheetContent({ expanded = false, className, ...props }: SheetContentProps) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className={dialogScrim({ gutter: expanded ? "none" : "sheet" })}>
        <RadixDialog.Content
          data-expanded={expanded ? "" : undefined}
          className={cn(
            "anim-modal flex h-full w-full min-w-0 flex-col overflow-hidden bg-paper text-fg shadow-modal outline-none",
            !expanded && "max-w-275 sm:rounded-2xl",
            className,
          )}
          {...props}
        />
      </RadixDialog.Overlay>
    </RadixDialog.Portal>
  );
}

/** The sheet's fixed top: identity, status and the expand, menu and close buttons. */
export function SheetHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("flex shrink-0 items-start gap-5 px-7 pt-6 pb-5", className)} {...props} />
  );
}

/** The sheet's scrolling content. */
export function SheetBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto px-7 py-6", className)} {...props} />;
}
