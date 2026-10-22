import { CircleAlert, FileText, Table2 } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";
import { tag } from "../../primitives/Tag";
import { embedKind, embedLabel } from "./embeds";

export type EmbedChipProps = Omit<ComponentProps<"span">, "children"> & {
  /** The embedded note's or table's display path. */
  path: string;
  /** The path is not reachable: a deleted file, one the agent cannot read, or a recipe path left after apply. */
  broken?: boolean;
  /** `tinted` on a soft coloured ground, such as a person's message bubble. */
  tone?: "default" | "tinted";
  /** Opens the note or table; the chip becomes a button. */
  onOpen?: (path: string) => void;
};

/** An `![[display-path]]` embed in a Task or note: the file or table it pulls in at run time. */
export function EmbedChip({
  path,
  broken,
  tone = "default",
  onOpen,
  className,
  ...props
}: EmbedChipProps) {
  const kind = embedKind(path);
  const label = embedLabel(path);
  const title = broken ? `${kind === "table" ? "Table" : "File"} not reachable: ${path}` : path;
  const classes = cn(
    tag({ tone: tone === "tinted" ? "tinted" : broken ? "plum" : "signal" }),
    "gap-1 align-middle text-xs",
    onOpen && "cursor-pointer transition-opacity hover:opacity-80",
    className,
  );
  const content = (
    <>
      <Icon icon={broken ? CircleAlert : kind === "table" ? Table2 : FileText} size={14} />
      <span className="min-w-0 truncate">{label}</span>
      <span className="sr-only">{kind === "table" ? " (table)" : " (note)"}</span>
    </>
  );

  if (onOpen) {
    return (
      <button type="button" title={title} className={classes} onClick={() => onOpen(path)}>
        {content}
      </button>
    );
  }
  return (
    <span title={title} className={classes} {...props}>
      {content}
    </span>
  );
}
