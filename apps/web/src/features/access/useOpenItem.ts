import { useState } from "react";
import type { ItemSections, ListedItem } from "../../api/types/access";
import { findOpenItem, type OpenItem } from "./listedItems";

/** The item a page's browser opens, as `findOpenItem` finds it, and how the operator chooses another. */
export type ItemChoice<Item extends ListedItem> = {
  opened: OpenItem<Item>;
  /** The open item; undefined when the pane opens none. */
  open: Item | undefined;
  /** Opens the item at a display path; undefined opens the first one the page reaches. */
  choose: (path: string | undefined) => void;
};

/**
 * The item a page's browser opens, starting at the path a link named. An item opened without a
 * choice becomes the choice once it opens, so a refetch that reorders the list, or greys that
 * item, keeps it open.
 */
export function useOpenItem<Item extends ListedItem>(
  sections: ItemSections<Item>,
  initialPath: string | undefined,
): ItemChoice<Item> {
  const [chosenPath, setChosenPath] = useState(initialPath);
  const opened = findOpenItem(sections, chosenPath);
  const open = opened.state === "open" ? opened.item : undefined;
  if (chosenPath === undefined && open) setChosenPath(open.display_path);
  return { opened, open, choose: setChosenPath };
}
