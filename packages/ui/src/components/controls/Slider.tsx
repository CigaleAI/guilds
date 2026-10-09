import { Slider as RadixSlider } from "radix-ui";
import { useId, useState } from "react";
import { cn } from "../../cn";
import { Tag } from "../../primitives/Tag";
import { describedBy, formFieldIds, FormField, type FormFieldText } from "./FormField";

export type SliderProps = FormFieldText & {
  value?: number;
  defaultValue?: number;
  onValueChange?: (value: number) => void;
  /** Fires once the knob is released, for saving. */
  onValueCommit?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Text of the value tag; defaults to the value at the step's precision. */
  format?: (value: number) => string;
  disabled?: boolean;
  name?: string;
  id?: string;
  /** Accessible name when there is no visible label. */
  "aria-label"?: string;
  className?: string;
};

function decimalsOf(step: number) {
  const [, fraction = ""] = String(step).split(".");
  return fraction.length;
}

/** A labelled range for one number, such as a model's temperature, with its value in a mono tag. */
export function Slider({
  label,
  aside,
  hint,
  error,
  value,
  defaultValue,
  onValueChange,
  onValueCommit,
  min = 0,
  max = 1,
  step = 0.1,
  format,
  disabled = false,
  name,
  id,
  "aria-label": ariaLabel,
  className,
}: SliderProps) {
  const autoId = useId();
  const thumbId = id ?? autoId;
  const [inner, setInner] = useState(defaultValue ?? min);
  const current = value ?? inner;
  const text = format ? format(current) : current.toFixed(decimalsOf(step));
  return (
    <FormField
      controlId={thumbId}
      labelFor={false}
      label={label}
      aside={aside}
      hint={hint}
      error={error}
      className={className}
    >
      <div className="flex items-center gap-3">
        <RadixSlider.Root
          value={[current]}
          onValueChange={([next]) => {
            if (next === undefined) return;
            setInner(next);
            onValueChange?.(next);
          }}
          onValueCommit={([next]) => {
            if (next !== undefined) onValueCommit?.(next);
          }}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          {...(name ? { name } : {})}
          className="group/slider relative flex h-5 min-w-0 flex-1 cursor-pointer touch-none items-center select-none data-disabled:cursor-not-allowed"
        >
          <RadixSlider.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-well">
            <RadixSlider.Range className="absolute h-full rounded-full bg-signal group-data-disabled/slider:bg-rule" />
          </RadixSlider.Track>
          <RadixSlider.Thumb
            id={thumbId}
            aria-label={ariaLabel}
            aria-labelledby={label ? formFieldIds(thumbId).label : undefined}
            aria-describedby={describedBy(thumbId, { hint, error })}
            aria-invalid={error ? true : undefined}
            aria-valuetext={text}
            className={cn(
              "block size-4 rounded-full bg-paper inset-ring-2 inset-ring-fg transition-shadow",
              "group-data-disabled/slider:inset-ring-rule-2",
            )}
          />
        </RadixSlider.Root>
        <Tag
          tone="paper"
          aria-hidden
          className={cn("min-w-10 justify-center tabular-nums", disabled && "text-muted")}
        >
          {text}
        </Tag>
      </div>
    </FormField>
  );
}
