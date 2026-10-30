import { Avatar, Style } from "@dicebear/core";
import definition from "@dicebear/styles/clay.json" with { type: "json" };

/** The look an agent has until one is picked: the clay teardrop, in violet. */
export const DEFAULT_AVATAR_SHAPE = "teardrop";
export const DEFAULT_AVATAR_COLOR = "#7c5cff";

export const CLAY_BODY_VARIANTS = [
  "bell",
  "blob",
  "boulder",
  "column",
  "cube",
  "dollop",
  "egg",
  "gumdrop",
  "lean",
  "loaf",
  "pear",
  "slug",
  "squat",
  "stack",
] as const;

const CLAY_BODY_SET = new Set<string>(CLAY_BODY_VARIANTS);
const clayStyle = new Style(definition);

function hexDigits(value: string): string {
  return value.replace("#", "").toLowerCase();
}

function darkenHex(hex: string, amount: number): string {
  const n = parseInt(hexDigits(hex), 16);
  if (!Number.isFinite(n)) {
    return hexDigits(DEFAULT_AVATAR_COLOR);
  }
  const fade = 1 - amount;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((channel) =>
      Math.round(channel * fade)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
}

export function parseClayShape(raw: string): {
  seed: string;
  bodyVariant?: (typeof CLAY_BODY_VARIANTS)[number];
} {
  const text = raw.trim().toLowerCase();
  const dash = text.indexOf("-");
  if (dash > 0) {
    const body = text.slice(0, dash);
    const rest = text.slice(dash + 1);
    if (rest && CLAY_BODY_SET.has(body)) {
      return { seed: rest, bodyVariant: body as (typeof CLAY_BODY_VARIANTS)[number] };
    }
  }
  if (CLAY_BODY_SET.has(text)) {
    return { seed: text, bodyVariant: text as (typeof CLAY_BODY_VARIANTS)[number] };
  }
  return { seed: text || DEFAULT_AVATAR_SHAPE };
}

export function clayAvatarSvg(seed = DEFAULT_AVATAR_SHAPE, color = DEFAULT_AVATAR_COLOR): string {
  const parsed = parseClayShape(seed);
  const body = hexDigits(color);
  const avatar = new Avatar(clayStyle, {
    seed: parsed.seed,
    scale: 1.15,
    backgroundColor: [],
    bodyColor: [body],
    bodyColorFill: "solid",
    accentColor: [darkenHex(color, 0.28)],
    accentColorFill: "solid",
    inkColor: ["0b0b10"],
    inkColorFill: "solid",
    ...(parsed.bodyVariant ? { bodyVariant: parsed.bodyVariant } : {}),
  });
  return avatar.toString();
}
