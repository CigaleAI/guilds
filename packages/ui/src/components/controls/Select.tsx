import { Check, ChevronDown, ChevronsUpDown, ChevronUp } from "lucide-react";
import { Select as RadixSelect } from "radix-ui";
import { Fragment, useId, type ReactNode } from "react";
import { cn } from "../../cn";
import { field } from "../../primitives/Field";
import { Icon } from "../../primitives/Icon";
import { describedBy, FormField, type FormFieldText } from "./FormField";

export type SelectOption = {
  value: string;
  /** What the list and the closed field show. */
  label: ReactNode;
  /** A second line in the list only, such as a model's display name. */
  description?: ReactNode;
  disabled?: boolean;
};

/** Options under a heading, such as models by provider. */
export type SelectOptionGroup = { label: string; options: readonly SelectOption[] };

export type SelectProps = FormFieldText &
  Omit<RadixSelect.SelectProps, "children" | "dir"> & {
    options: readonly (SelectOption | SelectOptionGroup)[];
    placeholder?: string;
    /** Mono values, for machine ids such as `openrouter/anthropic/claude-sonnet`. */
    mono?: boolean;
    tone?: "paper" | "well" | "surface";
    /** Shown before the value, such as an assignee's avatar. */
    lead?: ReactNode;
    id?: string;
    /** Accessible name when there is no visible label. */
    "aria-label"?: string;
    className?: string;
    /** Classes for the closed field. */
    fieldClassName?: string;
  };

function isGroup(entry: SelectOption | SelectOptionGroup): entry is SelectOptionGroup {
  return "options" in entry;
}

function SelectItem({ option, mono }: { option: SelectOption; mono: boolean }) {
  return (
    <RadixSelect.Item
      value={option.value}
      disabled={option.disabled ?? false}
      className={cn(
        "flex cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-2 text-md text-fg outline-none select-none",
        "data-highlighted:bg-surface data-disabled:cursor-default data-disabled:text-faint",
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <RadixSelect.ItemText>
          <span className={cn("block truncate", mono && "font-mono text-sm")}>{option.label}</span>
        </RadixSelect.ItemText>
        {option.description ? (
          <span className="truncate text-xs text-muted">{option.description}</span>
        ) : null}
      </span>
      <RadixSelect.ItemIndicator className="flex shrink-0">
        <Icon icon={Check} size={16} />
      </RadixSelect.ItemIndicator>
    </RadixSelect.Item>
  );
}

const scrollButton = "flex h-6 cursor-default items-center justify-center text-muted";

/**
 * A labelled picker over a fixed list: model, thinking level, timezone. The closed field matches
 * text fields; the open list is a paper popover with a check on the chosen option.
 */
export function Select({
  options,
  label,
  aside,
  hint,
  error,
  placeholder,
  mono = false,
  tone = "paper",
  lead,
  id,
  "aria-label": ariaLabel,
  className,
  fieldClassName,
  disabled,
  ...rootProps
}: SelectProps) {
  const autoId = useId();
  const triggerId = id ?? autoId;
  return (
    <FormField
      controlId={triggerId}
      label={label}
      aside={aside}
      hint={hint}
      error={error}
      className={className}
    >
      <RadixSelect.Root disabled={disabled ?? false} {...rootProps}>
        <RadixSelect.Trigger
          id={triggerId}
          aria-label={ariaLabel}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(triggerId, { hint, error })}
          className={cn(
            field({ shape: "box", tone, invalid: Boolean(error) }),
            "w-full cursor-pointer text-left focus-visible:outline-none data-placeholder:text-muted",
            "disabled:cursor-not-allowed disabled:text-muted",
            mono && "font-mono text-sm",
            fieldClassName,
          )}
        >
          {lead ? <span className="flex shrink-0 items-center">{lead}</span> : null}
          <span className="min-w-0 flex-1 truncate">
            <RadixSelect.Value placeholder={placeholder} />
          </span>
          <RadixSelect.Icon className="flex shrink-0 text-muted">
            <Icon icon={ChevronsUpDown} size={14} />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>
        <RadixSelect.Portal>
          <RadixSelect.Content
            position="popper"
            sideOffset={8}
            collisionPadding={16}
            className="z-50 overflow-hidden rounded-lg bg-paper p-1.5 text-fg shadow-pop"
            style={{
              minWidth: "var(--radix-select-trigger-width)",
              maxHeight: "var(--radix-select-content-available-height)",
            }}
          >
            <RadixSelect.ScrollUpButton className={scrollButton}>
              <Icon icon={ChevronUp} size={14} />
            </RadixSelect.ScrollUpButton>
            <RadixSelect.Viewport className="flex flex-col gap-0.5">
              {options.map((entry, index) =>
                isGroup(entry) ? (
                  <Fragment key={entry.label}>
                    {index > 0 ? (
                      <RadixSelect.Separator className="mx-2.5 my-1 h-px bg-line" />
                    ) : null}
                    <RadixSelect.Group className="flex flex-col gap-0.5">
                      <RadixSelect.Label className="px-2.5 pt-2 pb-1 type-label text-muted">
                        {entry.label}
                      </RadixSelect.Label>
                      {entry.options.map((option) => (
                        <SelectItem key={option.value} option={option} mono={mono} />
                      ))}
                    </RadixSelect.Group>
                  </Fragment>
                ) : (
                  <SelectItem key={entry.value} option={entry} mono={mono} />
                ),
              )}
            </RadixSelect.Viewport>
            <RadixSelect.ScrollDownButton className={scrollButton}>
              <Icon icon={ChevronDown} size={14} />
            </RadixSelect.ScrollDownButton>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
    </FormField>
  );
}
