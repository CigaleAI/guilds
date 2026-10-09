import { Check, Minus } from "lucide-react";
import { Checkbox as RadixCheckbox } from "radix-ui";
import { useId, type ReactNode } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";

export type CheckboxProps = Omit<RadixCheckbox.CheckboxProps, "children"> & {
  /** Visible label; the whole row is the hit target. Omit for a bare box and pass `aria-label`. */
  label?: ReactNode;
};

/** An 18px box: a 1.5px rule outline on paper, ink when checked or partially checked. */
export function Checkbox({ label, id, className, disabled, ...props }: CheckboxProps) {
  const autoId = useId();
  const boxId = id ?? autoId;
  const box = (
    <RadixCheckbox.Root
      id={boxId}
      disabled={disabled}
      className={cn(
        "group/box inline-flex size-4.5 shrink-0 cursor-pointer items-center justify-center rounded-xs bg-paper inset-ring-[1.5px] inset-ring-rule-2",
        "data-[state=checked]:bg-ink-fill data-[state=checked]:text-on-ink data-[state=checked]:inset-ring-0",
        "data-[state=indeterminate]:bg-ink-fill data-[state=indeterminate]:text-on-ink data-[state=indeterminate]:inset-ring-0",
        "disabled:cursor-not-allowed disabled:bg-well disabled:inset-ring-0",
        !label && className,
      )}
      {...props}
    >
      <RadixCheckbox.Indicator className="flex">
        <Icon icon={Check} size={14} className="hidden group-data-[state=checked]/box:block" />
        <Icon icon={Minus} size={14} className="hidden group-data-[state=indeterminate]/box:block" />
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );
  if (!label) return box;
  return (
    <label
      htmlFor={boxId}
      className={cn(
        "inline-flex min-h-8 cursor-pointer items-center gap-2 text-md text-fg",
        disabled && "cursor-not-allowed text-muted",
        className,
      )}
    >
      {box}
      {label}
    </label>
  );
}
