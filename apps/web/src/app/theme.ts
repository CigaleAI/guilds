import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { readStored, writeStored } from "./storage";

export type ThemePreference = "light" | "dark" | "system";

const storageKey = "guilds-theme";

function systemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function readThemePreference(): ThemePreference {
  const stored = readStored(storageKey);
  return stored === "light" || stored === "dark" ? stored : "system";
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
    writeStored(storageKey, next === "system" ? null : next);
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
