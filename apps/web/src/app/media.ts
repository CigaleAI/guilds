import { useSyncExternalStore } from "react";

/** Whether a media query matches now, following it as the window changes. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Tailwind's `md` breakpoint: below it the app takes its phone layout. */
export const wideScreen = "(min-width: 48rem)";

/** Which panes of a list beside its open item show. */
export type VisiblePanes = { list: boolean; item: boolean };

/**
 * The panes a list-and-item page shows: both on a wide screen; on a phone the list while it is
 * open or nothing is open, the item otherwise.
 */
export function visiblePanes(wide: boolean, listOpen: boolean, hasItem: boolean): VisiblePanes {
  if (wide) return { list: true, item: true };
  return { list: listOpen || !hasItem, item: hasItem && !listOpen };
}
