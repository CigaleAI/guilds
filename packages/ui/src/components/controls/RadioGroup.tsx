import { RadioGroup as RadixRadioGroup } from "radix-ui";
import { useId, type ReactNode } from "react";
import { cn } from "../../cn";

export type RadioOption = { value: string; label: ReactNode; disabled?: boolean };

export type RadioGroupProps = Omit<RadixRadioGroup.RadioGroupProps, "children"> & {
  options: RadioOption[];
};

/** 18px rounds: a 1.5px rule outline, ink with an inner dot when chosen. Rows are the hit target. */
export function RadioGroup({ options, className, ...props }: RadioGroupProps) {
  const baseId = useId();
  return (
    <RadixRadioGroup.Root className={cn("flex flex-col", className)} {...props}>
      {options.map((option) => {
        const id = `${baseId}-${option.value}`;
        return (
          <label
            key={option.value}
            htmlFor={id}
            className={cn(
              "inline-flex min-h-8 cursor-pointer items-center gap-2 text-md text-fg",
              option.disabled && "cursor-not-allowed text-muted",
            )}
          >
            <RadixRadioGroup.Item
              id={id}
              value={option.value}
              disabled={option.disabled}
              className={cn(
                "inline-flex size-4.5 shrink-0 items-center justify-center rounded-full bg-paper inset-ring-[1.5px] inset-ring-rule-2",
                "data-[state=checked]:bg-ink-fill data-[state=checked]:inset-ring-0",
                "disabled:bg-well disabled:inset-ring-0",
              )}
            >
              <RadixRadioGroup.Indicator className="size-2 rounded-full bg-on-ink" />
            </RadixRadioGroup.Item>
            {option.label}
          </label>
        );
      })}
    </RadixRadioGroup.Root>
  );
}
