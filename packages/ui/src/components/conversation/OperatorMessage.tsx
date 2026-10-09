import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import { identityText, identityTint, type IdentityTone } from "../../identity";
import { bubble } from "../../primitives/Bubble";
import { MarkdownToneContext } from "../content/Markdown";
import { Avatar } from "../identity/Avatar";

export type OperatorMessageProps = ComponentProps<"article"> & {
  /** "You" for the signed-in operator, the person's name for a peer, or "Operator". */
  author?: string;
  /**
   * The person's identity colour: the bubble takes its soft ground and the name its shade.
   * Without one the bubble is plum.
   */
  tone?: IdentityTone | undefined;
  /** The person behind the message; shows their round avatar, in their colour, before the name. */
  person?: { name: string; src?: string };
  /** Display time, such as "06:04 AM". */
  time?: string;
  dateTime?: string;
  /** Message sequence number in the chat. */
  seq?: number;
  /**
   * `chat` sits at the log's end edge at most 85% wide, as in direct and group chat;
   * `coach` fills the narrow Studio coach column, set in from the start edge.
   */
  layout?: "chat" | "coach";
  children?: ReactNode;
};

/** A person's message: a soft ground in their colour, with its tail corner at the end edge. */
export function OperatorMessage({
  author = "Operator",
  tone,
  person,
  time,
  dateTime,
  seq,
  layout = "chat",
  className,
  children,
  ...props
}: OperatorMessageProps) {
  return (
    <article
      data-seq={seq}
      aria-label={`${author}${time ? `, ${time}` : ""}`}
      className={cn(
        bubble({ variant: "human" }),
        "flex flex-col gap-1.5 px-5 py-3.5 text-md",
        tone && identityTint[tone],
        layout === "coach" && "ml-10 max-w-none self-stretch",
        className,
      )}
      {...props}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {person ? (
          <Avatar
            name={person.name}
            tone={tone ?? "dusk"}
            size={24}
            round
            {...(person.src ? { src: person.src } : {})}
          />
        ) : null}
        <span className={cn("text-sm font-bold", tone ? identityText[tone] : "text-plum-t")}>
          {author}
        </span>
        {time ? (
          <time className="type-meta text-muted" {...(dateTime ? { dateTime } : {})}>
            {time}
          </time>
        ) : null}
        {seq !== undefined ? <span className="type-meta text-muted">seq {seq}</span> : null}
      </header>
      <MarkdownToneContext.Provider value="tinted">
        <div className="min-w-0">{children}</div>
      </MarkdownToneContext.Provider>
    </article>
  );
}
