import type { ComponentProps } from "react";
import { Tag, type TagProps } from "../../primitives/Tag";

/** How an agent reaches an item: it reads and writes, it reads, or no row reaches it. */
export type AgentViewerMode = "write" | "read" | "none";

/**
 * How a guild's agents reach an item: all of them read and write, all of them read, only some
 * of them (agent rows alone), or none.
 */
export type GuildViewerMode = "all_write" | "all_read" | "some" | "none";

/** How the agent or guild a list is shown for reaches one of its items. */
export type ViewerMode = AgentViewerMode | GuildViewerMode;

export const viewerModeLabel: Record<ViewerMode, string> = {
  write: "Read & write",
  read: "Read",
  all_write: "All agents · read & write",
  all_read: "All agents · read",
  some: "Some agents",
  none: "No access",
};

const viewerModeTone = {
  write: "tide",
  read: "signal",
  all_write: "tide",
  all_read: "signal",
  some: "term",
  none: "well",
} as const satisfies Record<ViewerMode, TagProps["tone"]>;

export type ModeTagProps = Omit<ComponentProps<"span">, "children"> & {
  mode: ViewerMode;
};

/** How the viewer of a list reaches an item, as a tag: tide for write, signal for read. */
export function ModeTag({ mode, ...props }: ModeTagProps) {
  return (
    <Tag tone={viewerModeTone[mode]} font="sans" {...props}>
      {viewerModeLabel[mode]}
    </Tag>
  );
}
