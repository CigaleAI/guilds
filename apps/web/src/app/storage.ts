import { useCallback, useState } from "react";

export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode); the value holds for this visit only.
  }
}

/** A remembered on/off preference, stored as "true" / "false". */
export function useStoredFlag(key: string): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState(() => readStored(key) === "true");
  const set = useCallback(
    (next: boolean) => {
      writeStored(key, String(next));
      setValue(next);
    },
    [key],
  );
  return [value, set];
}
