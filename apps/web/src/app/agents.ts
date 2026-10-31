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

function styleAndSeed(shape: string): { style: string; seed: string } {
  const text = shape.trim().toLowerCase();
  for (const style of artStyles) {
    if (text.startsWith(`${style}:`) || text.startsWith(`${style}-`)) {
      return { style, seed: text.slice(style.length + 1) };
    }
  }
  return { style: "clay", seed: text };
}

/** How an agent looks everywhere: its identity colour and its mascot, drawn in that colour. */
export function agentLook(agent: Styled): { tone: IdentityTone; src?: string } {
  const tone = identityToneOf(agent.avatar_color);
  const { style, seed } = styleAndSeed(agent.avatar_shape);
  if (!seed) return { tone };
  const color = identityHex[tone].slice(1);
  return { tone, src: `/avatars/${style}.svg?seed=${encodeURIComponent(seed)}&color=${color}` };
}
