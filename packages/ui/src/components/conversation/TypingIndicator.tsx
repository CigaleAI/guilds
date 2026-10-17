import type { ComponentProps } from "react";
import { cn } from "../../cn";
import type { IdentityTone } from "../../identity";
import { Avatar } from "../identity/Avatar";

export type TypingIndicatorProps = Omit<ComponentProps<"div">, "children"> & {
  /** Agent handle. */
  name: string;
  tone: IdentityTone;
  src?: string;
  /** What the agent is doing; defaults to "<name> is thinking…". */
  caption?: string;
  /** 44 lines up with agent messages in a chat; 32 for tighter lists. */
  avatarSize?: 32 | 44;
  /** The ground of the dots pill, matching the agent bubbles around it. */
  bubble?: "paper" | "surface";
};

const dots = ["bg-muted", "bg-faint", "bg-rule"] as const;

/** Three pulsing dots: a reply still being written, such as after the text streamed so far. */
export function TypingDots({ className, ...props }: Omit<ComponentProps<"span">, "children">) {
  return (
    <span className={cn("flex shrink-0 gap-1", className)} {...props}>
      {dots.map((fill) => (
        <span key={fill} className={cn("size-1.5 rounded-full motion-safe:animate-pulse", fill)} />
      ))}
    </span>
  );
}

/** An agent working on a reply: its avatar and three pulsing dots. */
export function TypingIndicator({
  name,
  tone,
  src,
  caption,
  avatarSize = 44,
  bubble = "paper",
  className,
  ...props
}: TypingIndicatorProps) {
  const text = caption ?? `${name} is thinking…`;
  return (
    <div role="status" className={cn("flex min-w-0 items-center gap-3", className)} {...props}>
      <Avatar name={name} tone={tone} size={avatarSize} {...(src ? { src } : {})} aria-hidden />
      <TypingDots
        aria-hidden
        className={cn("rounded-full px-3.5 py-2.5", bubble === "paper" ? "bg-paper" : "bg-surface")}
      />
      <span className="min-w-0 truncate text-sm text-muted">{text}</span>
    </div>
  );
}
