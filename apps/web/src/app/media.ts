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
