/**
 * The identity palette: every agent owns one of these colours. The avatar tile fills with it and
 * the agent's name is written in its paired text colour.
 */
export const identityTones = ["signal", "tide", "moss", "ochre", "rosewood", "dusk"] as const;

export type IdentityTone = (typeof identityTones)[number];

/** The hex stored on an agent for each tone. */
export const identityHex: Record<IdentityTone, string> = {
  signal: "#1fafd1",
  tide: "#4a8a9c",
  moss: "#7f9a5e",
  ochre: "#c08f55",
  rosewood: "#b8627f",
  dusk: "#8672a0",
};

/** Avatar fill with its ink initials. */
export const identityFill: Record<IdentityTone, string> = {
  signal: "bg-id-signal text-on-id",
  tide: "bg-id-tide text-on-id",
  moss: "bg-id-moss text-on-id",
  ochre: "bg-id-ochre text-on-id",
  rosewood: "bg-id-rosewood text-on-id",
  dusk: "bg-id-dusk text-on-id",
};

/** Text colour for an agent's name, readable on paper and surface in both themes. */
export const identityText: Record<IdentityTone, string> = {
  signal: "text-id-signal-t",
  tide: "text-id-tide-t",
  moss: "text-id-moss-t",
  ochre: "text-id-ochre-t",
  rosewood: "text-id-rosewood-t",
  dusk: "text-id-dusk-t",
};

/** A soft ground in the identity colour, such as a person's message bubble. */
export const identityTint: Record<IdentityTone, string> = {
  signal: "bg-id-signal-tint",
  tide: "bg-id-tide-tint",
  moss: "bg-id-moss-tint",
  ochre: "bg-id-ochre-tint",
  rosewood: "bg-id-rosewood-tint",
  dusk: "bg-id-dusk-tint",
};

/** Colours agents stored before this palette, each paired with the tone of the same hue. */
const earlierHex: Record<string, IdentityTone> = {
  "#3b82f6": "signal",
  "#14b8a6": "tide",
  "#a3e635": "moss",
  "#fbbf24": "ochre",
  "#ff4d8d": "rosewood",
  "#7c5cff": "dusk",
};

function rgbOf(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return null;
  return [parseInt(match[1] ?? "0", 16), parseInt(match[2] ?? "0", 16), parseInt(match[3] ?? "0", 16)];
}

/** Perceptual colour distance ("redmean"): good enough to pick the nearest of six colours. */
function distance([r1, g1, b1]: [number, number, number], [r2, g2, b2]: [number, number, number]): number {
  const mean = (r1 + r2) / 2;
  const [dr, dg, db] = [r1 - r2, g1 - g2, b1 - b2];
  return Math.sqrt((2 + mean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - mean) / 256) * db * db);
}

/** The identity tone for an agent's stored colour; any other hex takes the nearest palette colour. */
export function identityToneOf(color: string): IdentityTone {
  const hex = color.trim().toLowerCase();
  const exact = identityTones.find((tone) => identityHex[tone] === hex) ?? earlierHex[hex];
  if (exact) return exact;
  const rgb = rgbOf(hex);
  if (!rgb) return "dusk";
  let nearest: IdentityTone = "dusk";
  let best = Infinity;
  for (const tone of identityTones) {
    const toneRgb = rgbOf(identityHex[tone]);
    const gap = toneRgb ? distance(rgb, toneRgb) : Infinity;
    if (gap < best) {
      best = gap;
      nearest = tone;
    }
  }
  return nearest;
}

/** A person's tone: none until they choose a colour. */
export function personTone(color: string | null | undefined): IdentityTone | undefined {
  return color ? identityToneOf(color) : undefined;
}

/** Two-letter initials from a handle: the first two characters, upper-cased. */
export function initialsOf(name: string): string {
  return name.trim().slice(0, 2).toUpperCase();
}
