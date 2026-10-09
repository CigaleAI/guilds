import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import { Pill } from "../../primitives/Pill";

export type WorkspaceHeaderProps = Omit<ComponentProps<"header">, "children" | "title"> & {
  /** The workspace, such as "Studio" or "Builder". */
  eyebrow: string;
  /** What the session works on: a guild, or the recipe being designed. */
  title: ReactNode;
  /** Details in mono, such as "coach · openrouter/openai/gpt-5 · temp 0.2"; they truncate first. */
  meta?: ReactNode;
  /** The session's state, such as "active · idle"; `live` fills it cyan, `hint` is its tooltip. */
  status?: { label: string; live: boolean; hint?: string };
  /** Trailing controls: Buttons in their `on-panel` variant. */
  actions?: ReactNode;
};

/** The ink band that opens a Studio or Builder session: what it works on, its state, and its controls. */
export function WorkspaceHeader({
  eyebrow,
  title,
  meta,
  status,
  actions,
  className,
  ...props
}: WorkspaceHeaderProps) {
  return (
    <header
      className={cn(
        "flex flex-wrap items-center gap-x-3.5 gap-y-2 bg-panel px-4 py-4 text-on-panel md:px-6",
        className,
      )}
      {...props}
    >
      <span className="type-label text-signal-soft">{eyebrow}</span>
      <h1 className="min-w-0 truncate type-h2">{title}</h1>
      {meta ? (
        <span
          title={typeof meta === "string" ? meta : undefined}
          className="min-w-24 flex-1 basis-full truncate font-mono text-xs text-on-panel-muted sm:basis-0"
        >
          {meta}
        </span>
      ) : null}
      <div className="ml-auto flex flex-wrap items-center gap-1">
        {status ? (
          <Pill
            size="sm"
            fill={status.live ? "accent" : "ghost"}
            title={status.hint}
            className={cn("mr-1", !status.live && "bg-on-panel/10 text-on-panel")}
          >
            {status.label}
          </Pill>
        ) : null}
        {actions}
      </div>
    </header>
  );
}
