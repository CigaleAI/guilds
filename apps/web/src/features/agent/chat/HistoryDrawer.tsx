import { Clock, X } from "lucide-react";
import { Icon, IconButton } from "@guildsrun/ui";
import { AgentHistoryList } from "../history/AgentHistory";

type HistoryDrawerProps = {
  selectedId?: string;
  onSelect: (id: string | null) => void;
  onClose: () => void;
};

/** The Chat session list: every run, newest first, beside the transcript. */
export function HistoryDrawer({ selectedId, onSelect, onClose }: HistoryDrawerProps) {
  return (
    <aside className="flex min-h-0 w-80 max-w-[85vw] shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <Icon icon={Clock} size={16} className="text-muted" />
        <h3 className="text-sm font-semibold">History</h3>
        <IconButton
          icon={X}
          label="Hide history"
          variant="ghost"
          size={28}
          className="ml-auto"
          onClick={onClose}
        />
      </div>
      <AgentHistoryList {...(selectedId ? { selectedId } : {})} onSelect={onSelect} />
    </aside>
  );
}
