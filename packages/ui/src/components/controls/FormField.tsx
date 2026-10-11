import { CircleAlert } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";

/** The label, helper text and limits around one form control. */
export type FormFieldText = {
  label?: ReactNode;
  /** Right of the label: the field's format or origin, such as "Markdown" or "overrides guild default". */
  aside?: ReactNode;
  /** Helper line under the control. An error takes its place. */
  hint?: ReactNode;
  /** What is wrong with the value. Marks the control invalid. */
  error?: ReactNode;
};

/** Element ids a control points at through `aria-labelledby` / `aria-describedby`. */
export function formFieldIds(controlId: string) {
  return {
    label: `${controlId}-label`,
    hint: `${controlId}-hint`,
    error: `${controlId}-error`,
    count: `${controlId}-count`,
  };
}

/** The `aria-describedby` value for a control given which helper lines are showing. */
export function describedBy(
  controlId: string,
  { hint, error, counted }: { hint?: ReactNode; error?: ReactNode; counted?: boolean },
): string | undefined {
  const ids = formFieldIds(controlId);
  const parts = [error ? ids.error : hint ? ids.hint : null, counted ? ids.count : null].filter(
    Boolean,
  );
  return parts.length ? parts.join(" ") : undefined;
}

export type FormFieldProps = Omit<ComponentProps<"div">, "children"> &
  FormFieldText & {
    controlId: string;
    /** Render the label as a `<label for>`; controls that are not labelable use `aria-labelledby`. */
    labelFor?: boolean;
    /** Characters used and allowed, shown under the control. */
    count?: { length: number; max: number };
    children: ReactNode;
  };

/** A labelled form row: label and aside, the control, then hint or error and a character count. */
export function FormField({
  controlId,
  label,
  aside,
  hint,
  error,
  count,
  labelFor = true,
  className,
  children,
  ...props
}: FormFieldProps) {
  const ids = formFieldIds(controlId);
  const labelClass = cn("text-sm font-semibold", error ? "text-plum-t" : "text-fg");
  const helper = error ? (
    <span id={ids.error} className="flex min-w-0 items-start gap-1.5 text-xs text-plum-t">
      <Icon icon={CircleAlert} size={14} className="mt-px" />
      {error}
    </span>
  ) : hint ? (
    <span id={ids.hint} className="min-w-0 text-xs text-muted">
      {hint}
    </span>
  ) : null;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)} {...props}>
      {label || aside ? (
        <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
          {label && labelFor ? (
            <label id={ids.label} htmlFor={controlId} className={labelClass}>
              {label}
            </label>
          ) : label ? (
            <span id={ids.label} className={labelClass}>
              {label}
            </span>
          ) : null}
          {aside ? <span className="ml-auto text-xs text-muted">{aside}</span> : null}
        </div>
      ) : null}
      {children}
      {helper || count ? (
        <div className="flex items-start justify-between gap-3">
          {helper ?? <span />}
          {count ? (
            <span
              id={ids.count}
              className={cn(
                "shrink-0 font-mono text-2xs text-muted tabular-nums",
                count.length >= count.max && "text-plum-t",
              )}
            >
              {count.length} / {count.max}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
