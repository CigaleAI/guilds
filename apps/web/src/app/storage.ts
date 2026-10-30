import { useCallback, useState } from "react";

export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * How a write to the browser's storage ended: stored, or unavailable when the browser denies the
 * page its storage (private mode), and the value holds for this visit only.
 */
export type StoredWrite = "stored" | "unavailable";

/** Stores a value under a key, or removes the key for null. */
export function writeStored(key: string, value: string | null): StoredWrite {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return "stored";
  } catch {
    return "unavailable";
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
