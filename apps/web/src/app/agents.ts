import type { Agent, AgentBrief } from "../api/types/agents";
import { identityHex, identityToneOf } from "@guildsrun/ui";
import type { IdentityTone } from "@guildsrun/ui";
type Styled = Pick<Agent | AgentBrief, "avatar_shape" | "avatar_color">;

/** Mascot styles the orchestrator renders at /avatars/<style>.svg. */
const artStyles = [
  "bottts-neutral",
  "voxel-bot",
  "pixelbot",
  "critters",
  "cutouts",
  "cameo",
  "clay",
] as const;

type ArtStyle = (typeof artStyles)[number];

/** An agent's mascot: the art style drawing it and the seed that varies it within the style. */
type Mascot = { style: ArtStyle; seed: string };

function mascotOf(shape: string): Mascot {
  const text = shape.trim().toLowerCase();
  for (const style of artStyles) {
    if (text.startsWith(`${style}:`) || text.startsWith(`${style}-`)) {
      return { style, seed: text.slice(style.length + 1) };
    }
  }
  return { style: "clay", seed: text };
}

/** How an agent looks everywhere: its identity colour, and the image of its mascot drawn in it. */
export type AgentLook = { tone: IdentityTone; src?: string };

/** How an agent looks everywhere: its identity colour and its mascot, drawn in that colour. */
export function agentLook(agent: Styled): AgentLook {
  const tone = identityToneOf(agent.avatar_color);
  const { style, seed } = mascotOf(agent.avatar_shape);
  if (!seed) return { tone };
  const color = identityHex[tone].slice(1);
  return { tone, src: `/avatars/${style}.svg?seed=${encodeURIComponent(seed)}&color=${color}` };
}
