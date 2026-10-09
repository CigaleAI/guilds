import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import { SearchField } from "./SearchField";
import { Segmented, type SegmentedOption } from "./Segmented";

export type FilterBarProps<T extends string> = Omit<ComponentProps<"div">, "children"> & {
  query: string;
  onQueryChange: (query: string) => void;
  placeholder: string;
  /** Accessible name of the search box, such as "Filter tools". */
  searchLabel: string;
  /** The status filter beside the search, with a count on each choice. */
  filter?: {
    value: T;
    onValueChange: (value: T) => void;
    options: readonly SegmentedOption<T>[];
    label: string;
  };
  size?: "sm" | "md";
  searchTone?: "paper" | "well" | "surface";
  /** Bulk actions at the end of the row, such as "Enable all" or "Reset to inherit". */
  actions?: ReactNode;
};

/** Search, a counted status filter and bulk actions over one list. Wraps on narrow widths. */
export function FilterBar<T extends string>({
  query,
  onQueryChange,
  placeholder,
  searchLabel,
  filter,
  size = "md",
  searchTone = "surface",
  actions,
  className,
  ...props
}: FilterBarProps<T>) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2.5", className)} {...props}>
      <SearchField
        value={query}
        onValueChange={onQueryChange}
        label={searchLabel}
        placeholder={placeholder}
        tone={searchTone}
        className="min-w-48 flex-1 basis-56"
      />
      {filter ? (
        <Segmented
          value={filter.value}
          onValueChange={filter.onValueChange}
          options={filter.options}
          label={filter.label}
          size={size}
        />
      ) : null}
      {actions ? <div className="flex flex-wrap items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}
