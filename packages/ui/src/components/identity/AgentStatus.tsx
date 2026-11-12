import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { Dot, type DotProps } from "../../primitives/Dot";

/**
 * What an agent is doing: `running` while it generates a reply, `idle` otherwise, `connecting`
 * while its live state is still loading, `disabled` while a blocking issue keeps it from running.
 */
export type AgentState = "running" | "idle" | "connecting" | "disabled";

const stateStyle: Record<AgentState, { tone: NonNullable<DotProps["tone"]>; text: string; pulse: boolean }> = {
  disabled: { tone: "alert", text: "text-alert", pulse: false },
  running: { tone: "signal", text: "text-signal-t", pulse: false },
  idle: { tone: "idle", text: "text-muted", pulse: false },
  connecting: { tone: "dusk", text: "text-muted", pulse: true },
};

export type AgentStatusProps = Omit<ComponentProps<"span">, "children"> & {
  state: AgentState;
  /** Whether to show the text label next to the dot. Defaults to true. */
  label?: boolean;
};

/** An agent's live state as a dot and an optional mono lowercase word. */
export function AgentStatus({ state, label = true, className, ...props }: AgentStatusProps) {
  const style = stateStyle[state];
  return (
    <span
      title={props.title ?? state}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 font-mono text-2xs font-medium whitespace-nowrap",
        style.text,
        className,
      )}
      {...props}
    >
      <Dot size="sm" tone={style.tone} className={cn(style.pulse && "animate-pulse")} />
      {label ? state : <span className="sr-only">{state}</span>}
    </span>
  );
}
