import type { ItemSections, ListedItem } from "../../api/types/access";

/**
 * Whether no row reaches the item for the page's guild or agent: its row is greyed, and a click
 * on it opens its access list instead of the item.
 */
export function isUnreached(item: ListedItem): boolean {
  return item.viewer_mode === "none";
}

/** Where an item is homed, as a row of the shared section names it: its guild, or the organisation. */
export function homeLabel(item: ListedItem): string {
  return item.home?.name ?? "Organisation";
}

/** Each section with only the items that match. */
export function filterSections<Item extends ListedItem>(
  sections: ItemSections<Item>,
  matches: (item: Item) => boolean,
): ItemSections<Item> {
  return { own: sections.own.filter(matches), shared: sections.shared.filter(matches) };
}

/** Every listed item in the order the page shows them: the guild's own, then those shared with it. */
export function listedItems<Item extends ListedItem>(sections: ItemSections<Item>): Item[] {
  return [...sections.own, ...sections.shared];
}

/**
 * The item the page opens: the chosen one, by display path, in either section; without one
 * listed, the first item the page's guild or agent reaches. An unreached item opens only when it
 * is the chosen one.
 */
export function findOpenItem<Item extends ListedItem>(
  sections: ItemSections<Item>,
  chosenPath: string | undefined,
): Item | undefined {
  const items = listedItems(sections);
  return (
    items.find((item) => item.display_path === chosenPath) ??
    items.find((item) => !isUnreached(item))
  );
}
