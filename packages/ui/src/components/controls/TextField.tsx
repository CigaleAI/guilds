import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "../../cn";
import { Field, FieldInput } from "../../primitives/Field";
import { describedBy, FormField, type FormFieldText } from "./FormField";

export type TextFieldProps = Omit<ComponentProps<"input">, "size"> &
  FormFieldText & {
    shape?: "box" | "pill" | "compact";
    tone?: "paper" | "well" | "surface";
    /** Mono value, for machine text such as handles, amounts and ids. */
    mono?: boolean;
    lead?: ReactNode;
    trail?: ReactNode;
    /** Show characters used against `maxLength` under the field. */
    showCount?: boolean;
    /** Classes for the field frame; `className` styles the whole row. */
    fieldClassName?: string;
  };

/** A labelled single-line text input with hint, character count and error. */
export function TextField({
  label,
  aside,
  hint,
  error,
  shape = "box",
  tone = "paper",
  mono = false,
  lead,
  trail,
  showCount = false,
  fieldClassName,
  className,
  id,
  value,
  defaultValue,
  maxLength,
  onChange,
  ...props
}: TextFieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const [typed, setTyped] = useState(() => String(defaultValue ?? "").length);
  const length = value !== undefined ? String(value).length : typed;
  const count = showCount && maxLength !== undefined ? { length, max: maxLength } : undefined;
  return (
    <FormField
      controlId={inputId}
      label={label}
      aside={aside}
      hint={hint}
      error={error}
      {...(count ? { count } : {})}
      className={className}
    >
      <Field
        shape={shape}
        tone={tone}
        invalid={Boolean(error)}
        lead={lead}
        trail={trail}
        className={cn(mono && "font-mono text-sm", fieldClassName)}
      >
        <FieldInput
          id={inputId}
          value={value}
          defaultValue={defaultValue}
          maxLength={maxLength}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(inputId, { hint, error, counted: Boolean(count) })}
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
