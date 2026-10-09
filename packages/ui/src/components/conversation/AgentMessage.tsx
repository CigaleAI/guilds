import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import { identityText, type IdentityTone } from "../../identity";
import { Button } from "../actions/Button";
import { Avatar } from "../identity/Avatar";

export type AgentMessageProps = Omit<ComponentProps<"article">, "title"> & {
  /** Agent handle. */
  name: string;
  tone: IdentityTone;
  /** Mascot art for the avatar. */
  src?: string;
  /** Display time, such as "06:00 AM". */
  time?: string;
  /** Machine-readable time for the <time> element. */
  dateTime?: string;
  /** Message sequence number in the chat. */
  seq?: number;
  /** Opens the private run that produced this post; shows the "Inspect run" pill. */
  onInspectRun?: () => void;
  /** Makes the agent's name a button that opens its conversation. */
  onOpenAgent?: () => void;
  /** Leave the avatar out, as for the Studio coach speaking in its own panel. */
  hideAvatar?: boolean;
  /** The ground of the bubble: paper on a surface card, surface on a paper chat. */
  bubble?: "paper" | "surface";
  /** Under the body, such as "Updated portfolio_valuation.md". */
  footer?: ReactNode;
  /** The message body, usually rendered Markdown. */
  children?: ReactNode;
};

/** A post by an agent: avatar, then a bubble with its name, time, the run behind it and the rendered body. */
export function AgentMessage({
  name,
  tone,
  src,
  time,
  dateTime,
  seq,
  onInspectRun,
  onOpenAgent,
  hideAvatar,
  bubble = "paper",
  footer,
  children,
  className,
  ...props
}: AgentMessageProps) {
  const nameClass = cn("text-md font-bold", identityText[tone]);
  return (
    <article
      data-seq={seq}
      aria-label={`${name}${time ? `, ${time}` : ""}`}
      className={cn("flex min-w-0 gap-3", className)}
      {...props}
    >
      {hideAvatar ? null : <Avatar name={name} tone={tone} size={44} {...(src ? { src } : {})} />}
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-2 rounded-xl px-5 py-3.5 text-md text-fg",
          bubble === "paper" ? "bg-paper" : "bg-surface",
        )}
      >
        <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {onOpenAgent ? (
            <button
              type="button"
              onClick={onOpenAgent}
              title="Open this agent's conversation"
              className={cn(nameClass, "cursor-pointer hover:underline")}
            >
              {name}
            </button>
          ) : (
            <span className={nameClass}>{name}</span>
          )}
          {time ? (
            <time className="type-meta text-muted" {...(dateTime ? { dateTime } : {})}>
              {time}
            </time>
          ) : null}
          {seq !== undefined ? <span className="type-meta text-muted">seq {seq}</span> : null}
          {onInspectRun ? (
            <Button
              variant="outline"
              size="xs"
              onClick={onInspectRun}
              title="Open this agent's private conversation for this post"
              className="h-5 text-2xs font-bold"
            >
              Inspect run
            </Button>
          ) : null}
        </header>
        {children !== undefined ? <div className="min-w-0">{children}</div> : null}
        {footer !== undefined ? (
          <footer className="flex flex-wrap items-center gap-1.5 text-md">{footer}</footer>
        ) : null}
      </div>
    </article>
  );
}
