import type { Guild } from "../../api/types/guilds";
import { isBoolean, isJsonObject, parseJson } from "../../api/wire";

/** The operator's folds in the sidebar: whether it folds each guild, by guild id. */
export type FoldedGuilds = Record<Guild["id"], boolean>;

/** Whether a value is the folded guilds: an object whose every field is a guild's folded flag. */
export function isFoldedGuilds(value: unknown): value is FoldedGuilds {
  return isJsonObject(value) && Object.values(value).every(isBoolean);
}

/** The guilds the sidebar folds, read from their stored JSON; null when the text is not such a map. */
export function parseFoldedGuilds(stored: string): FoldedGuilds | null {
  const parsed = parseJson(stored);
  return isFoldedGuilds(parsed) ? parsed : null;
}
