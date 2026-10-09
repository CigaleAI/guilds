import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";

export type InboxItemProps = Omit<ComponentProps<"button">, "children" | "title"> & {
  /** The reporting agent or the author who tagged you, at 32px. */
  avatar: ReactNode;
  title: ReactNode;
  /** Where it comes from, such as "Degen-capital · issue" or "Degen-capital · mention". */
  meta: ReactNode;
  /** Time since it arrived, such as "6h". */
  age: string;
  unread?: boolean;
  selected?: boolean;
};

/** An inbox entry: an open issue in a guild you operate, or a group-chat message that tags you. */
export function InboxItem({
  avatar,
  title,
  meta,
  age,
  unread = false,
  selected = false,
  className,
  type = "button",
  ...props
}: InboxItemProps) {
  return (
    <button
      type={type}
      data-selected={selected ? "true" : undefined}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "group/inbox flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-md p-2.5 text-left text-fg transition-colors hover:bg-surface",
        "selected:bg-plum selected:text-on-plum",
        className,
      )}
      {...props}
    >
      <span className="flex w-2 shrink-0 justify-center">
        {unread ? (
          <span className="size-2 rounded-full bg-signal group-data-[selected=true]/inbox:bg-signal-soft">
            <span className="sr-only">Unread</span>
          </span>
        ) : null}
      </span>
      <span className="flex size-8 shrink-0 items-center justify-center">{avatar}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("truncate text-md", unread ? "font-bold" : "font-medium")}>{title}</span>
        <span className="truncate text-xs text-muted group-data-[selected=true]/inbox:text-on-plum-muted">{meta}</span>
      </span>
      <span className="shrink-0 font-mono text-2xs whitespace-nowrap text-muted group-data-[selected=true]/inbox:text-on-plum-muted">
        {age}
      </span>
    </button>
  );
}
