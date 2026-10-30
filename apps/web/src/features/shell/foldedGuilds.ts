import { isRecord } from "../../api/wire";

/** Whether a value maps guild ids to whether the sidebar folds them. */
export function isFoldedGuilds(value: unknown): value is Record<string, boolean> {
  return isRecord(value) && Object.values(value).every((folded) => typeof folded === "boolean");
}

/** The guilds the sidebar folds, read from their stored JSON; null when the text is not such a map. */
export function parseFoldedGuilds(stored: string): Record<string, boolean> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  return isFoldedGuilds(parsed) ? parsed : null;
}
