import { CircleAlert, FileText, Link2, Table2 } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";
import { tag } from "../../primitives/Tag";
import { embedKind, embedLabel, type EmbedMode } from "./embeds";

export type EmbedChipProps = Omit<ComponentProps<"span">, "children"> & {
  /** The linked note's or table's display path. */
  path: string;
  /** `embed` for `![[path]]`, whose text a run inlines; `reference` for `[[path]]`, which the agent reads when it needs it. */
  mode?: EmbedMode;
  /** The path is not reachable: a deleted file, one the agent cannot read, or a recipe path left after apply. */
  broken?: boolean;
  /** `tinted` on a soft coloured ground, such as a person's message bubble. */
  tone?: "default" | "tinted";
  /** Opens the note or table; the chip becomes a button. */
  onOpen?: (path: string) => void;
};

function chipTone(chip: Pick<EmbedChipProps, "mode" | "broken" | "tone">) {
  if (chip.tone === "tinted") return "tinted";
  if (chip.broken) return "plum";
  return chip.mode === "reference" ? "term" : "signal";
}

function chipTitle(path: string, chip: Pick<EmbedChipProps, "mode" | "broken">): string {
  if (chip.broken)
    return `${embedKind(path) === "table" ? "Table" : "File"} not reachable: ${path}`;
  return chip.mode === "reference" ? `Referenced, read by the agent when needed: ${path}` : path;
}

/** A `![[display-path]]` embed or a `[[display-path]]` reference in a Task or note. */
export function EmbedChip({
  path,
  mode = "embed",
  broken = false,
  tone = "default",
  onOpen,
  className,
  ...props
}: EmbedChipProps) {
  const kind = embedKind(path);
  const title = chipTitle(path, { mode, broken });
  const classes = cn(
    tag({ tone: chipTone({ mode, broken, tone }) }),
    "gap-1 align-middle text-xs",
    onOpen && "cursor-pointer transition-opacity hover:opacity-80",
    className,
  );
  const icon = broken
    ? CircleAlert
    : mode === "reference"
      ? Link2
      : kind === "table"
        ? Table2
        : FileText;
  const content = (
    <>
      <Icon icon={icon} size={14} />
      <span className="min-w-0 truncate">{embedLabel(path)}</span>
      <span className="sr-only">{` (${kind}${mode === "reference" ? ", referenced" : ""})`}</span>
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
