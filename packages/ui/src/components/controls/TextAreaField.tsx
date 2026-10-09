import { useId, useState, type ComponentProps } from "react";
import { cn } from "../../cn";
import { Field, FieldTextarea } from "../../primitives/Field";
import { describedBy, FormField, type FormFieldText } from "./FormField";

export type TextAreaFieldProps = ComponentProps<"textarea"> &
  FormFieldText & {
    /** Mono for markdown and prompts the agents read; sans for prose people read. */
    font?: "mono" | "sans";
    tone?: "paper" | "well" | "surface";
    /** Show characters used against `maxLength` under the field. */
    showCount?: boolean;
    /** Classes for the field frame; `className` styles the whole row. */
    fieldClassName?: string;
  };

/** A labelled multi-line input, such as a guild's markdown description, with hint, count and error. */
export function TextAreaField({
  label,
  aside,
  hint,
  error,
  font = "mono",
  tone = "paper",
  showCount = false,
  fieldClassName,
  className,
  id,
  rows = 4,
  value,
  defaultValue,
  maxLength,
  onChange,
  ...props
}: TextAreaFieldProps) {
  const autoId = useId();
  const areaId = id ?? autoId;
  const [typed, setTyped] = useState(() => String(defaultValue ?? "").length);
  const length = value !== undefined ? String(value).length : typed;
  const count = showCount && maxLength !== undefined ? { length, max: maxLength } : undefined;
  return (
    <FormField
      controlId={areaId}
      label={label}
      aside={aside}
      hint={hint}
      error={error}
      {...(count ? { count } : {})}
      className={className}
    >
      <Field
        shape="area"
        tone={tone}
        invalid={Boolean(error)}
        className={cn(
          "px-3.5 py-3",
          font === "sans" && "font-sans text-md",
          fieldClassName,
        )}
      >
        <FieldTextarea
          id={areaId}
          rows={rows}
          value={value}
          defaultValue={defaultValue}
          maxLength={maxLength}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(areaId, { hint, error, counted: Boolean(count) })}
          onChange={(event) => {
            setTyped(event.currentTarget.value.length);
            onChange?.(event);
          }}
          {...props}
        />
      </Field>
    </FormField>
  );
}
