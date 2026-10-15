import { AppWindow, Code2, Unlink } from "lucide-react";
import { Slot } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import type { IdentityTone } from "../../identity";
import { Icon } from "../../primitives/Icon";
import { row } from "../../primitives/Row";
import { AgentStatus, type AgentState } from "../identity/AgentStatus";
import { Avatar } from "../identity/Avatar";

export type AgentRowProps = Omit<ComponentProps<"button">, "children"> & {
  /** Agent handle. */
  name: string;
  tone: IdentityTone;
  src?: string;
  state: AgentState;
  /** The agent has a browser. */
  browser?: boolean;
  /** The agent codes through a harness. */
  coding?: boolean;
  /** Notes its standing prompt embeds that no longer resolve. */
  brokenLinks?: readonly string[];
  /** The agent open in the inspector. */
  selected?: boolean;
  /** Render the child element (a link) as the row. */
  asChild?: boolean;
  children?: ReactNode;
};

function AgentMarkers({
  broken,
  coding,
  browser,
}: {
  broken: string | null;
  coding: boolean | undefined;
  browser: boolean | undefined;
}) {
  if (!broken && !coding && !browser) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-muted">
      {broken ? (
        <span title={broken} className="flex text-t-ochre-fg">
          <Icon icon={Unlink} size={14} label={broken} />
        </span>
      ) : null}
      {coding ? (
        <span title="Coding agent" className="flex">
          <Icon icon={Code2} size={14} label="Coding agent" />
        </span>
      ) : null}
      {browser ? (
        <span title="Has a browser" className="flex">
          <Icon icon={AppWindow} size={14} label="Has a browser" />
        </span>
      ) : null}
    </span>
  );
}

/** An agent under its guild in the sidebar: avatar, handle, coding and browser flags and live state dot. */
export function AgentRow({
  name,
  tone,
  src,
  state,
  browser,
  coding,
  brokenLinks,
  selected,
  asChild,
  className,
  type,
  children,
  ...props
}: AgentRowProps) {
  const Comp = asChild ? Slot.Root : "button";
  const broken =
    brokenLinks && brokenLinks.length > 0
      ? `Broken file link in standing prompt: ${brokenLinks.join(", ")}`
      : null;
  return (
    <Comp
      type={asChild ? undefined : (type ?? "button")}
      data-selected={selected ? "true" : undefined}
      aria-current={selected ? "true" : undefined}
      className={cn(
        row({ density: "compact", interactive: true }),
        "w-full gap-2 px-2 selected:bg-paper selected:hover:bg-paper-hi",
        className,
      )}
      {...props}
    >
      <Avatar name={name} tone={tone} size={24} {...(src ? { src } : {})} aria-hidden />
      <span className="min-w-0 flex-1 truncate font-mono text-sm">{name}</span>
      <AgentMarkers broken={broken} coding={coding} browser={browser} />
      <AgentStatus state={state} label={false} />
      <Slot.Slottable>{children}</Slot.Slottable>
    </Comp>
  );
}
