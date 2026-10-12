import { cva } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../cn";

/** What a generation's filters keep in focus: calls that changed state, or calls that failed. */
export type GenerationFilter = "mutations" | "errors";

/** `filters` with `filter` switched on when it was off, and off when it was on. */
export function toggleFilter(
  filters: readonly GenerationFilter[],
  filter: GenerationFilter,
): GenerationFilter[] {
  return filters.includes(filter)
    ? filters.filter((item) => item !== filter)
    : [...filters, filter];
}

const chipTitle: Record<GenerationFilter, { off: string; on: string }> = {
  mutations: { off: "Keep only the calls that changed state", on: "Show every call again" },
  errors: { off: "Keep only the calls that failed", on: "Show every call again" },
};

export const filterChip = cva(
  "inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2 text-2xs font-bold whitespace-nowrap transition-colors select-none hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus selected:hover:opacity-100",
  {
    variants: {
      filter: { mutations: "", errors: "" },
      surface: {
        paper: "selected:bg-ink-fill selected:text-on-ink",
        plum: "h-6.5 px-3 text-on-plum inset-ring-[1.5px] inset-ring-on-plum hover:bg-on-plum-hover hover:opacity-100 selected:bg-signal selected:text-on-signal selected:inset-ring-signal",
      },
    },
    compoundVariants: [
      { filter: "mutations", surface: "paper", class: "bg-t-tide text-t-tide-fg" },
      { filter: "errors", surface: "paper", class: "bg-t-plum text-plum-t" },
    ],
    defaultVariants: { surface: "paper" },
  },
);

export type FilterChipProps = Omit<ComponentProps<"button">, "onClick"> & {
  filter: GenerationFilter;
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  /** The ground the chip sits on. */
  surface?: "paper" | "plum";
};

/** A tag that is also a toggle: pressed, it dims every call outside its filter. */
export function FilterChip({
  filter,
  pressed,
  onPressedChange,
  surface = "paper",
  className,
  children,
  ...props
}: FilterChipProps) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={pressed ? chipTitle[filter].on : chipTitle[filter].off}
      onClick={() => onPressedChange(!pressed)}
      className={cn(filterChip({ filter, surface }), className)}
      {...props}
    >
      {children}
    </button>
  );
}
