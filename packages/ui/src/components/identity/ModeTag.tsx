import type { ComponentProps } from "react";
import { Tag, type TagProps } from "../../primitives/Tag";

/**
 * How the viewer of a list reaches an item, as the tag shows it: an agent reads and writes, or
 * reads; a guild's agents all read and write, all read, or only some of them reach it; or no row
 * reaches it.
 */
type ModeTagMode = "write" | "read" | "all_write" | "all_read" | "some" | "none";

const modeLabel: Record<ModeTagMode, string> = {
  write: "Read & write",
  read: "Read",
  all_write: "All agents · read & write",
  all_read: "All agents · read",
  some: "Some agents",
  none: "No access",
};

const modeTone = {
  write: "tide",
  read: "signal",
  all_write: "tide",
  all_read: "signal",
  some: "term",
  none: "well",
} as const satisfies Record<ModeTagMode, TagProps["tone"]>;

export type ModeTagProps = Omit<ComponentProps<"span">, "children"> & {
  mode: ModeTagMode;
};

/** How the viewer of a list reaches an item, as a tag: tide for write, signal for read. */
export function ModeTag({ mode, ...props }: ModeTagProps) {
  return (
    <Tag tone={modeTone[mode]} font="sans" {...props}>
      {modeLabel[mode]}
    </Tag>
  );
}
