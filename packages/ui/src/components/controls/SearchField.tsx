import { Search, X } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { Field, FieldInput } from "../../primitives/Field";
import { Icon } from "../../primitives/Icon";
import { IconButton } from "../actions/IconButton";

export type SearchFieldProps = Omit<
  ComponentProps<"input">,
  "size" | "type" | "value" | "defaultValue" | "onChange"
> & {
  value: string;
  onValueChange: (value: string) => void;
  /** Accessible name, such as "Filter tools". */
  label: string;
  tone?: "paper" | "well" | "surface";
  /** Classes for the pill frame. */
  className?: string;
};

/** A pill search box that filters a list as you type: agents, notes, tools, issues. Esc clears it. */
export function SearchField({
  value,
  onValueChange,
  label,
  tone = "paper",
  className,
  onKeyDown,
  ...props
}: SearchFieldProps) {
  return (
    <Field
      shape="pill"
      tone={tone}
      lead={<Icon icon={Search} size={14} />}
      trail={
        value ? (
          <IconButton
            icon={X}
            label="Clear search"
            variant="ghost"
            size={24}
            round
            className="-mr-2 text-muted hover:text-fg"
            onClick={() => onValueChange("")}
          />
        ) : null
      }
      className={cn("min-w-0", className)}
    >
      <FieldInput
        type="text"
        role="searchbox"
        enterKeyHint="search"
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.preventDefault();
            onValueChange("");
          }
          onKeyDown?.(event);
        }}
        {...props}
      />
    </Field>
  );
}
