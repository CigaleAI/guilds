import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import { Dot } from "../../primitives/Dot";
import { Tag } from "../../primitives/Tag";
import { OnOffSwitch, type BindingOrigin } from "../controls/OnOffSwitch";

/** "Active via guild" / "Disabled via agent": the effective state and the scope that decided it. */
export function bindingCaption(enabled: boolean, source?: string): string {
  const state = enabled ? "Active" : "Disabled";
  return source ? `${state} via ${source}` : state;
}

export type ToolRowProps = Omit<ComponentProps<"div">, "children"> & {
  /** Tool name as agents call it, such as note_find. */
  name: string;
  /** MCP server or integration that offers the tool. */
  server?: string;
  /** What the tool does, as the model reads it; clamped to two lines. */
  description?: string;
  /** Effective state after org → guild → agent resolution. */
  enabled: boolean;
  /** Scope whose binding decided the effective state: org, guild, agent or platform. */
  source?: string;
  /** Where the switch's value comes from at the scope being edited. */
  origin?: BindingOrigin;
  /** Omit when the tool is not a binding, such as browser and coding tools. */
  onEnabledChange?: (enabled: boolean) => void;
  disabled?: boolean;
  /** Overrides the Active/Disabled via-scope line. */
  caption?: string;
  /** Controls before the switch, such as Delete for an item this scope owns. */
  actions?: ReactNode;
  /** Opens a test call for this function. */
  onNameClick?: () => void;
};

/** One tool in an integration's list: its effective state, where that came from, and its On/Off binding. */
export function ToolRow({
  name,
  server,
  description,
  enabled,
  source,
  origin,
  onEnabledChange,
  disabled,
  caption,
  actions,
  onNameClick,
  className,
  ...props
}: ToolRowProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2.5 border-b border-line px-3.5 py-3 last:border-b-0",
        className,
      )}
      {...props}
    >
      <Dot size="sm" tone={enabled ? "signal" : "idle"} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {onNameClick ? (
            <button
              type="button"
              onClick={onNameClick}
              className="min-w-0 cursor-pointer font-mono text-sm font-medium wrap-anywhere text-fg hover:underline"
            >
              {name}
            </button>
          ) : (
            <span className="min-w-0 font-mono text-sm font-medium wrap-anywhere text-fg">
              {name}
            </span>
          )}
          {server ? <Tag tone="term">{server}</Tag> : null}
        </div>
        {description ? (
          <p className="line-clamp-2 text-xs text-fg-2" title={description}>
            {description}
          </p>
        ) : null}
        <div className="text-xs text-muted">{caption ?? bindingCaption(enabled, source)}</div>
      </div>
      {actions}
      {onEnabledChange ? (
        <OnOffSwitch
          label={name}
          value={enabled}
          onValueChange={onEnabledChange}
          disabled={disabled ?? false}
          {...(origin ? { origin } : {})}
        />
      ) : null}
    </div>
  );
}
