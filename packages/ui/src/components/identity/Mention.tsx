import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { Tag } from "../../primitives/Tag";

export type MentionProps = Omit<ComponentProps<"span">, "children"> & {
  /** Agent handle, without the @. */
  handle: string;
  /** `tinted` on a soft coloured ground, such as a person's message bubble. */
  tone?: "default" | "tinted";
};

/** An @mention of an agent inside a message. */
export function Mention({ handle, tone = "default", className, ...props }: MentionProps) {
  return (
    <Tag
      tone={tone === "tinted" ? "tinted" : "plum"}
      font="sans"
      className={cn("align-baseline", className)}
      {...props}
    >
      @{handle}
    </Tag>
  );
}
