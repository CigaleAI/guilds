import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import { Dialog as RadixDialog } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import { IconButton } from "../actions/IconButton";

/** A modal dialog: a form or a decision on paper over the scrim. Esc, the scrim and the close button dismiss it. */
export const Dialog = RadixDialog.Root;

/** The element that opens a dialog, usually a Button rendered with `asChild`. */
export const DialogTrigger = RadixDialog.Trigger;

/** Closes the dialog it sits in; wrap a Cancel button with `asChild`. */
export const DialogClose = RadixDialog.Close;

/** The scrim that dims the page and centres a modal panel, keeping a gutter at every width. */
export const dialogScrim = cva("anim-scrim fixed inset-0 z-50 flex items-center justify-center bg-scrim", {
  variants: {
    gutter: {
      dialog: "p-4 sm:p-6",
      sheet: "sm:p-10",
      none: "",
    },
  },
  defaultVariants: { gutter: "dialog" },
});

export const dialogPanel = cva(
  "anim-modal group/dialog relative flex max-h-full w-full flex-col overflow-hidden rounded-xl bg-paper text-fg shadow-modal outline-none",
  {
    variants: {
      size: {
        sm: "max-w-100",
        md: "max-w-140",
        lg: "max-w-200",
      },
    },
    defaultVariants: { size: "md" },
  },
);

export type DialogContentProps = ComponentProps<typeof RadixDialog.Content> &
  VariantProps<typeof dialogPanel> & {
    /** Accessible name of the corner close button; `null` leaves the button out. */
    closeLabel?: string | null;
  };

/**
 * The dialog panel: 400, 560 or 800 wide. The close button comes last in focus order, so opening
 * the dialog focuses its first field, or Cancel when it has none.
 */
export function DialogContent({ size, closeLabel = "Close", className, children, ...props }: DialogContentProps) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className={dialogScrim()}>
        <RadixDialog.Content
          data-closable={closeLabel ? "" : undefined}
          className={cn(dialogPanel({ size }), className)}
          {...props}
        >
          {children}
          {closeLabel ? (
            <RadixDialog.Close asChild>
              <IconButton
                icon={X}
                label={closeLabel}
                variant="surface"
                size={32}
                className="absolute top-5 right-6 rounded-sm"
              />
            </RadixDialog.Close>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Overlay>
    </RadixDialog.Portal>
  );
}

export type DialogHeaderProps = Omit<ComponentProps<"div">, "title" | "children"> & {
  title: ReactNode;
  /** One line under the title: what the dialog acts on, or where a multi-step flow stands. */
  description?: ReactNode;
};

/** Title and description. Names the dialog for assistive tech. */
export function DialogHeader({ title, description, className, ...props }: DialogHeaderProps) {
  return (
    <div className={cn("flex shrink-0 flex-col gap-1 px-6 pt-5 group-data-closable/dialog:pr-17", className)} {...props}>
      <RadixDialog.Title className="text-2xl font-semibold text-fg">{title}</RadixDialog.Title>
      {description ? (
        <RadixDialog.Description className="text-md text-muted">{description}</RadixDialog.Description>
      ) : null}
    </div>
  );
}

/** The dialog's content; it scrolls when the dialog is taller than the window. */
export function DialogBody({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5 text-md text-fg", className)}
      {...props}
    />
  );
}

/** Actions on surface, right-aligned with the primary action last. A Back action takes `mr-auto`. */
export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex shrink-0 items-center justify-end gap-2 bg-surface px-6 py-4", className)}
      {...props}
    />
  );
}
