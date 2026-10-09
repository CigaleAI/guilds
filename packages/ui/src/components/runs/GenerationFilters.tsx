import { cva } from "class-variance-authority";
import { ToggleGroup } from "radix-ui";
import { cn } from "../../cn";

/** What a generation's filters keep in focus: calls that changed state, or calls that failed. */
export type GenerationFilter = "mutations" | "errors";

const filterLabel: Record<GenerationFilter, string> = { mutations: "Mutations", errors: "Errors" };

const filterTitle: Record<GenerationFilter, string> = {
  mutations: "Dim reads and connected lookups",
  errors: "Dim calls that succeeded",
};

export const generationFilter = cva(
  "inline-flex h-5 shrink-0 cursor-pointer items-center rounded-full px-2.5 text-2xs font-bold tracking-wide whitespace-nowrap uppercase transition-colors select-none",
  {
    variants: {
      surface: {
        paper:
          "text-fg inset-ring-[1.5px] inset-ring-fg hover:bg-surface selected:bg-ink-fill selected:text-on-ink selected:inset-ring-ink-fill",
        plum: "h-6.5 px-3 text-on-plum inset-ring-[1.5px] inset-ring-on-plum hover:bg-on-plum-hover selected:bg-signal selected:text-on-signal selected:inset-ring-signal",
      },
    },
    defaultVariants: { surface: "paper" },
  },
);

export type GenerationFiltersProps = {
  /** Filters on offer; Errors is only worth offering when the generation has errors. */
  available: GenerationFilter[];
  value: GenerationFilter[];
  onValueChange: (value: GenerationFilter[]) => void;
  /** The ground the pills sit on. */
  surface?: "paper" | "plum";
  className?: string;
};

/** Toggle pills that dim the calls outside a generation's focus. */
export function GenerationFilters({
  available,
  value,
  onValueChange,
  surface,
  className,
}: GenerationFiltersProps) {
  return (
    <ToggleGroup.Root
      type="multiple"
      value={value}
      onValueChange={(next) =>
        onValueChange(next.filter((item): item is GenerationFilter => item in filterLabel))
      }
      aria-label="Filter calls"
      className={cn("flex shrink-0 items-center gap-1.5", className)}
    >
      {available.map((filter) => (
        <ToggleGroup.Item
          key={filter}
          value={filter}
          title={filterTitle[filter]}
          className={generationFilter({ surface })}
        >
          {filterLabel[filter]}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
