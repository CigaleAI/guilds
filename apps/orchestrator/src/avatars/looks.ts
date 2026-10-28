import { randomInt } from "node:crypto";
import { DEFAULT_AVATAR_COLOR, DEFAULT_AVATAR_SHAPE } from "./clay.js";
import { parseAvatarShape, type AvatarStyleName } from "./index.js";

/** Mascot sets the builder picks from for a guild; pixelbot is still rendered when already stored. */
export const GUILD_AVATAR_STYLES = [
  "critters",
  "cameo",
  "clay",
  "cutouts",
  "voxel-bot",
  "bottts-neutral",
] as const;

export type GuildAvatarStyle = (typeof GUILD_AVATAR_STYLES)[number];

/** The six identity colours, same hexes the operator app's palette stores. */
export const IDENTITY_COLORS = [
  "#1fafd1",
  "#4a8a9c",
  "#7f9a5e",
  "#c08f55",
  "#b8627f",
  "#8672a0",
] as const;

const SEED_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SEED_LENGTH = 8;

export type RoleLook = { role?: string; avatar_shape: string; avatar_color: string };

function defaultRandom(): number {
  return randomInt(0, 2 ** 32) / 2 ** 32;
}

function pickIndex(length: number, random: () => number): number {
  if (length <= 0) return 0;
  return Math.min(length - 1, Math.floor(random() * length));
}

export function randomAvatarSeed(random: () => number = defaultRandom): string {
  let seed = "";
  for (let i = 0; i < SEED_LENGTH; i += 1) {
    seed += SEED_ALPHABET[pickIndex(SEED_ALPHABET.length, random)];
  }
  return seed;
}

export function isDefaultAvatarShape(shape: string): boolean {
  const text = shape.trim().toLowerCase();
  return !text || text === DEFAULT_AVATAR_SHAPE || text === `clay:${DEFAULT_AVATAR_SHAPE}`;
}

export function isDefaultAvatarColor(color: string): boolean {
  return !color.trim() || color.trim().toLowerCase() === DEFAULT_AVATAR_COLOR;
}

/** The DiceBear family of a chosen look; null when the shape is the stored default. */
export function assignedAvatarStyle(shape: string): AvatarStyleName | null {
  if (isDefaultAvatarShape(shape)) return null;
  return parseAvatarShape(shape).style;
}

function majorityStyle(roles: readonly RoleLook[] | null | undefined): AvatarStyleName | null {
  const counts = new Map<AvatarStyleName, number>();
  for (const role of roles ?? []) {
    const style = assignedAvatarStyle(role.avatar_shape);
    if (!style) continue;
    counts.set(style, (counts.get(style) ?? 0) + 1);
  }
  let best: AvatarStyleName | null = null;
  let n = 0;
  for (const [style, count] of counts) {
    if (count > n) {
      best = style;
      n = count;
    }
  }
  return best;
}

function uniqueSeed(used: Set<string>, random: () => number): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const seed = randomAvatarSeed(random);
    if (!used.has(seed)) return seed;
  }
  let fallback = randomAvatarSeed(random);
  while (used.has(fallback)) fallback = `${fallback}x`.slice(0, 63);
  return fallback;
}

function nextIdentityColor(used: Set<string>): string {
  for (const color of IDENTITY_COLORS) {
    if (!used.has(color)) return color;
  }
  return IDENTITY_COLORS[used.size % IDENTITY_COLORS.length] ?? IDENTITY_COLORS[0];
}

/**
 * One DiceBear family for the guild, a unique variant and identity colour for each role.
 * Restores a previous role's look when the write omitted it (the schema default).
 * Returns whether any role changed.
 */
export function assignGuildLooks(
  roles: RoleLook[],
  previous: readonly RoleLook[] | null = null,
  random: () => number = defaultRandom,
): boolean {
  if (roles.length === 0) return false;

  const prevByRole = new Map(
    (previous ?? []).filter((item) => item.role).map((item) => [item.role, item] as const),
  );
  for (const role of roles) {
    const prior = role.role ? prevByRole.get(role.role) : undefined;
    if (
      isDefaultAvatarShape(role.avatar_shape) &&
      prior &&
      !isDefaultAvatarShape(prior.avatar_shape)
    ) {
      role.avatar_shape = prior.avatar_shape;
    }
    if (
      isDefaultAvatarColor(role.avatar_color) &&
      prior &&
      !isDefaultAvatarColor(prior.avatar_color)
    ) {
      role.avatar_color = prior.avatar_color;
    }
  }

  const family =
    majorityStyle(previous) ??
    majorityStyle(roles) ??
    GUILD_AVATAR_STYLES[pickIndex(GUILD_AVATAR_STYLES.length, random)] ??
    "critters";

  const keptSeeds = new Set<string>();
  const keptColors = new Set<string>();
  const keepShape: boolean[] = roles.map((role) => {
    const style = assignedAvatarStyle(role.avatar_shape);
    if (style !== family) return false;
    const seed = parseAvatarShape(role.avatar_shape).seed;
    if (!seed || keptSeeds.has(seed)) return false;
    keptSeeds.add(seed);
    return true;
  });
  const keepColor: boolean[] = roles.map((role) => {
    const color = role.avatar_color.trim().toLowerCase();
    if (isDefaultAvatarColor(color) || keptColors.has(color)) return false;
    keptColors.add(color);
    return true;
  });

  let changed = false;
  for (let index = 0; index < roles.length; index += 1) {
    const role = roles[index];
    if (!role) continue;
    if (keepShape[index]) {
      const seed = parseAvatarShape(role.avatar_shape).seed;
      const normalized = `${family}:${seed}`;
      if (role.avatar_shape !== normalized) {
        role.avatar_shape = normalized;
        changed = true;
      }
    } else {
      const seed = uniqueSeed(keptSeeds, random);
      keptSeeds.add(seed);
      const next = `${family}:${seed}`;
      if (role.avatar_shape !== next) {
        role.avatar_shape = next;
        changed = true;
      }
    }
    if (keepColor[index]) {
      const color = role.avatar_color.trim().toLowerCase();
      if (role.avatar_color !== color) {
        role.avatar_color = color;
        changed = true;
      }
    } else {
      const color = nextIdentityColor(keptColors);
      keptColors.add(color);
      if (role.avatar_color !== color) {
        role.avatar_color = color;
        changed = true;
      }
    }
  }
  return changed;
}
