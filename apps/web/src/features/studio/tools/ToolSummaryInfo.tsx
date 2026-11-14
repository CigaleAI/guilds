import { Info } from "lucide-react";
import { useState } from "react";
import { IconButton, Tooltip } from "@guildsrun/ui";

type ToolSummaryInfoProps = { name: string; summary: string };

/**
 * An info icon that shows a tool's summary on hover, on keyboard focus, and on a click or tap;
 * Esc, a click elsewhere, or leaving it closes the summary.
 */
export function ToolSummaryInfo({ name, summary }: ToolSummaryInfoProps) {
  const [open, setOpen] = useState(false);
  return (
    // The summary renders in a portal whose clicks still bubble to the row that opens the tool.
    <span className="inline-flex" onClick={(event) => event.stopPropagation()}>
      <Tooltip label={summary} open={open} onOpenChange={setOpen}>
        <IconButton
          icon={Info}
          label={`About ${name}`}
          variant="ghost"
          size={24}
          className="-my-1 text-muted hover:text-fg"
          onClick={() => setOpen(true)}
        />
      </Tooltip>
    </span>
  );
}
