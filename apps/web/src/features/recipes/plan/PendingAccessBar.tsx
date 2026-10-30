import { Button } from "@guildsrun/ui";
import { pendingAccessSummary, type PendingAccess } from "./pendingAccess";

type PendingAccessBarProps = {
  pending: PendingAccess;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  /** What saving does besides writing the recipe, such as telling the coach. */
  saveLabel?: string;
};

/** The access changes made on a plan and not yet saved, held at the bottom of the page. */
export function PendingAccessBar({
  pending,
  saving,
  onSave,
  onDiscard,
  saveLabel = "Save access",
}: PendingAccessBarProps) {
  const summary = pendingAccessSummary(pending);
  if (!summary) return null;
  const switched = summary.edits.filter((edit) => edit.action === "set_tool").length;
  const parts = [
    ...(switched ? [`${switched} tool switch${switched === 1 ? "" : "es"}`] : []),
    ...(summary.removedConnectors
      ? [
          `${summary.removedConnectors} connector${summary.removedConnectors === 1 ? "" : "s"} removed`,
        ]
      : []),
  ];
  return (
    <div className="sticky bottom-4 z-10 mx-auto mt-6 flex max-w-240 flex-wrap items-center gap-3 rounded-xl bg-plum px-4 py-3 text-on-plum shadow-pop">
      <span className="min-w-0 flex-1 text-sm">Unsaved access changes: {parts.join(" · ")}</span>
      <Button variant="on-plum" size="sm" disabled={saving} onClick={onDiscard}>
        Discard
      </Button>
      <Button variant="secondary" size="sm" disabled={saving} onClick={onSave}>
        {saving ? "Saving…" : saveLabel}
      </Button>
    </div>
  );
}
