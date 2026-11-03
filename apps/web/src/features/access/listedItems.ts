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
 * What a page's item pane shows: an item open; a chosen path the page does not list, with nothing
 * open; or nothing, when nothing is chosen and the page reaches no listed item.
 */
export type OpenItem<Item extends ListedItem> =
  { state: "open"; item: Item } | { state: "unlisted"; path: string } | { state: "none" };

/**
 * What the page opens: the chosen item, by display path, in either section, reached or not; a
 * chosen path the page does not list opens no other item in its place. With nothing chosen, the
 * first item the page's guild or agent reaches opens; an unreached item opens only when chosen.
 */
export function findOpenItem<Item extends ListedItem>(
  sections: ItemSections<Item>,
  chosenPath: string | undefined,
): OpenItem<Item> {
  const items = listedItems(sections);
  if (chosenPath === undefined) {
    const first = items.find((item) => !isUnreached(item));
    return first ? { state: "open", item: first } : { state: "none" };
  }
  const chosen = items.find((item) => item.display_path === chosenPath);
  return chosen ? { state: "open", item: chosen } : { state: "unlisted", path: chosenPath };
}
