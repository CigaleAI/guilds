import { Shuffle } from "lucide-react";
import { agentLook } from "../../../app/agents";
import {
  Button,
  Segmented,
  ToneSwatches,
  Avatar,
  identityHex,
  identityToneOf,
  Icon,
} from "@guildsrun/ui";
/** Mascot sets the orchestrator draws; an agent's shape is `<set>:<seed>`. */
const avatarSets = [
  { value: "critters", label: "Critters" },
  { value: "cameo", label: "Cameo" },
  { value: "clay", label: "Clay" },
  { value: "cutouts", label: "Cutouts" },
  { value: "voxel-bot", label: "Voxel bots" },
  { value: "bottts-neutral", label: "Bottts" },
] as const;

const seedAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomSeed(length = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => seedAlphabet[byte % seedAlphabet.length]).join("");
}

function setOf(shape: string): string {
  const text = shape.trim().toLowerCase();
  if (!text) return "";
  const colon = text.indexOf(":");
  if (colon > 0) return text.slice(0, colon);
  const styles = [...avatarSets].map((item) => item.value).sort((a, b) => b.length - a.length);
  for (const style of styles) {
    if (text.startsWith(`${style}-`)) return style;
  }
  return "clay";
}

type AvatarPickerProps = {
  name: string;
  shape: string;
  color: string;
  onChange: (look: { shape: string; color: string }) => void;
};

/** The agent's mascot: a set, a random variant within it, and one of the six identity colours. */
export function AvatarPicker({ name, shape, color, onChange }: AvatarPickerProps) {
  const look = agentLook({ avatar_shape: shape, avatar_color: color });
  const set = setOf(shape);
  const tone = identityToneOf(color);

  return (
    <div className="flex flex-wrap items-start gap-5">
      <Avatar name={name} size={64} {...look} />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label="Mascot set"
            size="sm"
            value={set}
            onValueChange={(next) => onChange({ shape: `${next}:${randomSeed()}`, color })}
            options={avatarSets}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={!set}
            onClick={() => onChange({ shape: `${set}:${randomSeed()}`, color })}
          >
            <Icon icon={Shuffle} size={14} />
            Another variant
          </Button>
        </div>
        <ToneSwatches
          label="Colour"
          value={tone}
          onValueChange={(next) => {
            if (next) onChange({ shape, color: identityHex[next] });
          }}
        />
      </div>
    </div>
  );
}
