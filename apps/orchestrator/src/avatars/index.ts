import { Avatar, Style } from "@dicebear/core";
import botttsNeutralDef from "@dicebear/styles/bottts-neutral.json" with { type: "json" };
import cameoDef from "@dicebear/styles/cameo.json" with { type: "json" };
import crittersDef from "@dicebear/styles/critters.json" with { type: "json" };
import cutoutsDef from "@dicebear/styles/cutouts.json" with { type: "json" };
import pixelbotDef from "@dicebear/styles/pixelbot.json" with { type: "json" };
import voxelBotDef from "@dicebear/styles/voxel-bot.json" with { type: "json" };
import { DEFAULT_AVATAR_COLOR, DEFAULT_AVATAR_SHAPE } from "../agents/validation.js";
import { clayAvatarSvg, parseClayShape } from "./clay.js";

export { clayAvatarSvg, parseClayShape };

export const SUPPORTED_AVATAR_STYLES = [
  "critters",
  "cameo",
  "pixelbot",
  "bottts-neutral",
  "clay",
  "cutouts",
  "voxel-bot",
] as const;

export type AvatarStyleName = (typeof SUPPORTED_AVATAR_STYLES)[number];

const STYLE_SET = new Set<string>(SUPPORTED_AVATAR_STYLES);
const PREFIX_STYLES = [...SUPPORTED_AVATAR_STYLES].sort((a, b) => b.length - a.length);

const crittersStyle = new Style(crittersDef);
const cameoStyle = new Style(cameoDef);
const pixelbotStyle = new Style(pixelbotDef);
const botttsNeutralStyle = new Style(botttsNeutralDef);
const cutoutsStyle = new Style(cutoutsDef);
const voxelBotStyle = new Style(voxelBotDef);

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

export function parseAvatarShape(raw?: string | null): {
  style: AvatarStyleName;
  seed: string;
} {
  const text = String(raw || "").trim().toLowerCase();
  if (!text) {
    return { style: "clay", seed: DEFAULT_AVATAR_SHAPE };
  }

  const colonIndex = text.indexOf(":");
  if (colonIndex > 0) {
    const prefix = text.slice(0, colonIndex);
    const rest = text.slice(colonIndex + 1);
    if (STYLE_SET.has(prefix)) {
      return {
        style: prefix as AvatarStyleName,
        seed: rest || DEFAULT_AVATAR_SHAPE,
      };
    }
  }

  for (const style of PREFIX_STYLES) {
    if (text.startsWith(`${style}-`)) {
      return {
        style,
        seed: text.slice(style.length + 1) || DEFAULT_AVATAR_SHAPE,
      };
    }
  }

  return { style: "clay", seed: text };
}

export function renderAvatarSvg(
  styleName: string,
  seed = DEFAULT_AVATAR_SHAPE,
  color = DEFAULT_AVATAR_COLOR,
): string {
  const normalizedStyle = styleName.trim().toLowerCase();
  const hex = hexDigits(color);

  switch (normalizedStyle) {
    case "critters": {
      const avatar = new Avatar(crittersStyle, {
        seed,
        backgroundColor: [],
        bodyColor: [hex],
        accentColor: [darkenHex(color, 0.28)],
      });
      return avatar.toString();
    }
    case "cameo": {
      const avatar = new Avatar(cameoStyle, {
        seed,
        backgroundColor: [],
        bodyColor: [hex],
      });
      return avatar.toString();
    }
    case "pixelbot": {
      const avatar = new Avatar(pixelbotStyle, {
        seed,
        backgroundColor: [],
        glowColor: [hex],
      });
      return avatar.toString();
    }
    case "bottts-neutral": {
      const avatar = new Avatar(botttsNeutralStyle, {
        seed,
        backgroundColor: [hex],
      });
      return avatar.toString();
    }
    case "cutouts": {
      const avatar = new Avatar(cutoutsStyle, {
        seed,
        backgroundColor: [],
        paperFaceColor: [hex],
        paperBackColor: [darkenHex(color, 0.28)],
        paperHairColor: [darkenHex(color, 0.4)],
      });
      return avatar.toString();
    }
    case "voxel-bot": {
      const avatar = new Avatar(voxelBotStyle, {
        seed,
        backgroundColor: [],
        bodyColor: [hex],
        accentColor: [darkenHex(color, 0.28)],
        glowColor: [hex],
      });
      return avatar.toString();
    }
    case "clay":
    default:
      return clayAvatarSvg(seed, color);
  }
}

export function renderAvatarFromShape(
  shape = DEFAULT_AVATAR_SHAPE,
  color = DEFAULT_AVATAR_COLOR,
): string {
  const { style, seed } = parseAvatarShape(shape);
  return renderAvatarSvg(style, seed, color);
}
