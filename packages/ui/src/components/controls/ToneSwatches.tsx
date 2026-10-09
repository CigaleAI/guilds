import { Check } from "lucide-react";
import { RadioGroup } from "radix-ui";
import { cn } from "../../cn";
import { identityFill, identityTones, type IdentityTone } from "../../identity";
import { Icon } from "../../primitives/Icon";

const noTone = "none";

export type ToneSwatchesProps = {
  /** The chosen colour; undefined when none is. */
  value: IdentityTone | undefined;
  onValueChange: (tone: IdentityTone | undefined) => void;
  /** Names the group for assistive tech, such as "Colour". */
  label: string;
  /** Offers "no colour" first, titled with this text; choosing it clears the colour. */
  none?: string;
  disabled?: boolean;
  className?: string;
};

const swatch = cn(
  "grid size-8 cursor-pointer place-items-center rounded-md transition-transform hover:scale-105",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
  "data-[state=checked]:ring-2 data-[state=checked]:ring-fg data-[state=checked]:ring-offset-2 data-[state=checked]:ring-offset-paper",
  "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100",
);

/** The six identity colours as swatches, one chosen; arrow keys move between them. */
export function ToneSwatches({
  value,
  onValueChange,
  label,
  none,
  disabled,
  className,
}: ToneSwatchesProps) {
  return (
    <RadioGroup.Root
      aria-label={label}
      orientation="horizontal"
      value={value ?? (none ? noTone : "")}
      onValueChange={(next) => onValueChange(next === noTone ? undefined : (next as IdentityTone))}
      disabled={disabled}
      className={cn("flex flex-wrap gap-2", className)}
    >
      {none ? (
        <RadioGroup.Item
          value={noTone}
          aria-label={none}
          title={none}
          className={cn(swatch, "bg-t-plum text-plum-t inset-ring inset-ring-line-3")}
        >
          <RadioGroup.Indicator>
            <Icon icon={Check} size={14} />
          </RadioGroup.Indicator>
        </RadioGroup.Item>
      ) : null}
      {identityTones.map((tone) => (
        <RadioGroup.Item
          key={tone}
          value={tone}
          aria-label={tone}
          title={tone}
          className={cn(swatch, identityFill[tone])}
        >
          <RadioGroup.Indicator>
            <Icon icon={Check} size={14} />
          </RadioGroup.Indicator>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
