import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";

const storageKey = "guilds-theme";

function systemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(storageKey);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

/** Sets `data-theme` on <html>, which every token reads. */
export function applyTheme(preference: ThemePreference): void {
  document.documentElement.dataset.theme = preference === "system" ? systemTheme() : preference;
}

/** The viewer's theme choice, remembered on this device; "system" follows the OS setting live. */
export function useTheme(): [ThemePreference, (next: ThemePreference) => void] {
  const [preference, setPreference] = useState(readThemePreference);

  useEffect(() => {
    applyTheme(preference);
    if (preference !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const follow = () => applyTheme("system");
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, [preference]);

  const choose = useCallback((next: ThemePreference) => {
    try {
      if (next === "system") localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, next);
    } catch {
      // Storage can be unavailable (private mode); the choice still applies for this visit.
    }
    setPreference(next);
  }, []);

  return [preference, choose];
}

export const ThemeContext = createContext<[ThemePreference, (next: ThemePreference) => void]>([
  "system",
  () => {},
]);

/** The theme choice held at the app's root. */
export function useThemeChoice(): [ThemePreference, (next: ThemePreference) => void] {
  return useContext(ThemeContext);
}
