import type { LucideIcon } from "lucide-react";
import { Button, EmptyState } from "@guildsrun/ui";
import type { ListedKind } from "../../api/types/access";

type UnlistedItemProps = {
  kind: ListedKind;
  /** The display path a link or a choice named. */
  path: string;
  icon: LucideIcon;
  /** Shows the list again, on a screen where it and the item pane take turns. */
  onShowList?: (() => void) | undefined;
};

/** The item pane of a page whose chosen path it does not list: it says so, and opens no other item. */
export function UnlistedItem({ kind, path, icon, onShowList }: UnlistedItemProps) {
  return (
    <EmptyState
      icon={icon}
      title="Not listed on this page"
      description={
        <>
          This page lists no {kind} at <code className="break-all">{path}</code>.
        </>
      }
      {...(onShowList
        ? {
            action: (
              <Button size="sm" variant="outline" onClick={onShowList}>
                Show the list
              </Button>
            ),
          }
        : {})}
    />
  );
}
