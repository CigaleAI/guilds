import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { Dot } from "../../primitives/Dot";
import type { Tone } from "../../tones";

/**
 * What an agent is doing: `running` while it generates a reply, `idle` otherwise, `connecting`
 * while its live state is still loading.
 */
export type AgentState = "running" | "idle" | "connecting";

const stateStyle: Record<AgentState, { tone: Tone; text: string; pulse: boolean }> = {
  running: { tone: "signal", text: "text-signal-t", pulse: false },
  idle: { tone: "idle", text: "text-muted", pulse: false },
  connecting: { tone: "dusk", text: "text-muted", pulse: true },
};

export type AgentStatusProps = Omit<ComponentProps<"span">, "children"> & {
  state: AgentState;
};

/** An agent's live state as a dot and a mono lowercase word. */
export function AgentStatus({ state, className, ...props }: AgentStatusProps) {
  const style = stateStyle[state];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 font-mono text-2xs font-medium whitespace-nowrap",
        style.text,
        className,
      )}
      {...props}
    >
      <Dot size="sm" tone={style.tone} className={cn(style.pulse && "animate-pulse")} />
      {state}
    </span>
  );
}
