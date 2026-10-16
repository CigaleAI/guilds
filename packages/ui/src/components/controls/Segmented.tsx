import { ToggleGroup } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "../../cn";
import { Track, trackItem } from "../../primitives/Track";

export type SegmentedOption<T extends string> = {
  value: T;
  label: ReactNode;
  /** How many items this choice holds, shown after the label ("Open 26"). */
  count?: number | string;
  disabled?: boolean;
};

export type SegmentedProps<T extends string> = {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  /** Accessible name of the group, such as "Time range" or "Issue status". */
  label: string;
  size?: "sm" | "md";
  /** The selected option's fill: ink, or paper for a quieter toolbar. */
  fill?: "ink" | "paper";
  /** Mono labels, for machine values such as time ranges. */
  mono?: boolean;
  disabled?: boolean;
  className?: string;
};

/**
 * One choice among a few on a well track: time ranges, Formatted/Markdown, issue and tool filters.
 * Exactly one option is always selected.
 */
export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  label,
  size = "md",
  fill = "ink",
  mono = false,
  disabled = false,
  className,
}: SegmentedProps<T>) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onValueChange(next as T);
      }}
      disabled={disabled}
      aria-label={label}
      asChild
    >
      <Track size={size} className={cn("shrink-0", className)}>
        {options.map((option) => (
          <ToggleGroup.Item
            key={option.value}
            value={option.value}
            disabled={option.disabled ?? false}
            className={cn(trackItem({ size, selectedFill: fill }), mono && "font-mono font-medium")}
          >
            {option.label}
            {option.count !== undefined ? (
              <span className="tabular-nums">{option.count}</span>
            ) : null}
          </ToggleGroup.Item>
        ))}
      </Track>
    </ToggleGroup.Root>
  );
}
