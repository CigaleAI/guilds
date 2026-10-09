import { Tooltip as RadixTooltip } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";

/** Mount once near the app root. Tooltips open after 400ms, then instantly while moving between triggers. */
export function TooltipProvider({ delayDuration = 400, ...props }: ComponentProps<typeof RadixTooltip.Provider>) {
  return <RadixTooltip.Provider delayDuration={delayDuration} {...props} />;
}

type ContentProps = ComponentProps<typeof RadixTooltip.Content>;

export type TooltipProps = Omit<ComponentProps<typeof RadixTooltip.Root>, "children"> & {
  /** What the trigger is or does. Text only: anything that needs a button belongs in a popover. */
  label: ReactNode;
  /** Keyboard shortcut after the label, such as ⌘K. */
  shortcut?: string;
  /** Set the label in mono, for machine values such as a run's id and time. */
  mono?: boolean;
  side?: ContentProps["side"];
  align?: ContentProps["align"];
  /** The trigger: one focusable element that accepts a ref. */
  children: ReactNode;
};

/** A dark label that names an icon button or explains a mark, on hover and on keyboard focus. */
export function Tooltip({
  label,
  shortcut,
  mono = false,
  side = "top",
  align = "center",
  children,
  ...props
}: TooltipProps) {
  return (
    <RadixTooltip.Root {...props}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            "anim-pop z-50 flex max-w-60 items-center gap-2 rounded-sm bg-panel px-2.5 py-1.5 text-xs text-on-panel shadow-pop select-none",
            mono && "font-mono",
          )}
        >
          <span className="min-w-0">{label}</span>
          {shortcut ? <span className="shrink-0 font-mono text-2xs text-on-panel-muted">{shortcut}</span> : null}
          <RadixTooltip.Arrow width={10} height={5} className="fill-panel" />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
