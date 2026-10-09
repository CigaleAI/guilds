import { Switch } from "radix-ui";
import { useId, type ReactNode } from "react";
import { cn } from "../../cn";

export type ToggleProps = Omit<Switch.SwitchProps, "children"> & {
  /** Visible label beside the switch; without it, pass `aria-label`. */
  label?: ReactNode;
  /** A line under the label saying what the switch does. */
  description?: ReactNode;
};

/**
 * A 52×30 switch for a setting that takes effect on its own, such as a guild's routines or an
 * agent's browser: signal track when on, well when off, paper knob.
 */
export function Toggle({ label, description, id, className, disabled, ...props }: ToggleProps) {
  const autoId = useId();
  const switchId = id ?? autoId;
  const descriptionId = description ? `${switchId}-description` : undefined;
  const control = (
    <Switch.Root
      id={switchId}
      disabled={disabled ?? false}
      aria-describedby={descriptionId}
      className={cn(
        "inline-flex h-7.5 w-13 shrink-0 cursor-pointer items-center rounded-full bg-well p-0.5 inset-ring-[1.5px] inset-ring-line-3 transition-colors",
        "data-[state=checked]:bg-signal data-[state=checked]:inset-ring-0 disabled:cursor-not-allowed disabled:opacity-50",
        !label && className,
      )}
      {...props}
    >
      <Switch.Thumb className="size-6.5 rounded-full bg-paper transition-transform data-[state=checked]:translate-x-5.5" />
    </Switch.Root>
  );
  if (!label) return control;
  return (
    <div className={cn("inline-flex items-start gap-3", className)}>
      {control}
      <span className="flex min-h-7.5 min-w-0 flex-col justify-center">
        <label
          htmlFor={switchId}
          className={cn(
            "cursor-pointer text-sm font-semibold text-fg",
            disabled && "cursor-not-allowed text-muted",
          )}
        >
          {label}
        </label>
        {description ? (
          <span id={descriptionId} className="text-xs text-muted">
            {description}
          </span>
        ) : null}
      </span>
    </div>
  );
}
