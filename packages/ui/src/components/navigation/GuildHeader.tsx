import { Lock } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";
import { Pill } from "../../primitives/Pill";
import { AvatarStack, type AvatarStackMember } from "../identity/AvatarStack";
import { CapacityBadge } from "../identity/CapacityBadge";
import type { GuildVisibility } from "./GuildRow";

export type GuildHeaderProps = Omit<ComponentProps<"header">, "children"> & {
  name: string;
  /** The guild's agents, in sidebar order; the first five show in the stack. */
  agents: AvatarStackMember[];
  /** The guild's agent limit (`max_agents`). */
  maxAgents: number;
  /** Agents generating right now; the pill hides at zero. */
  activeCount?: number;
  /** The guild's short description (`about`). Hidden in the compact header. */
  about?: ReactNode;
  visibility?: GuildVisibility;
  /** False when the guild holds every routine. */
  routinesEnabled?: boolean;
  /** Trailing controls, such as the guild options (⋯) IconButton in its `on-plum` variant. */
  actions?: ReactNode;
  /** The slim phone band: name and live status, without the roster and capacity. */
  compact?: boolean;
  /** Opens the selected header avatar, typically that agent's inspector. */
  onAgentSelect?: (agent: AvatarStackMember) => void;
};

/** The plum band that opens a guild: who is in it, how full it is, and what it is for. */
export function GuildHeader({
  name,
  agents,
  maxAgents,
  activeCount,
  about,
  visibility,
  routinesEnabled = true,
  actions,
  compact,
  onAgentSelect,
  className,
  ...props
}: GuildHeaderProps) {
  const eyebrow = <span className="type-label text-signal-soft">Guild</span>;
  const title = (
    <span className="flex min-w-0 items-center gap-2.5">
      <h1 className="min-w-0 truncate type-h1">{name}</h1>
      {visibility === "private" ? (
        <span title="Private to its operators" className="flex shrink-0 text-on-plum-muted">
          <Icon icon={Lock} size={18} label="Private to its operators" />
        </span>
      ) : null}
    </span>
  );
  const stack = (
    <AvatarStack
      members={agents}
      ring="plum"
      size={44}
      max={5}
      aria-label={`${name} agents`}
      {...(onAgentSelect ? { onMemberSelect: onAgentSelect } : {})}
    />
  );
  const badges = (
    <>
      <CapacityBadge count={agents.length} max={maxAgents} tone="dusk" />
      {!routinesEnabled ? (
        <Pill size="xs" fill="ochre-tint">
          Routines off
        </Pill>
      ) : null}
    </>
  );
  const active =
    activeCount !== undefined && activeCount > 0 ? (
      <Pill size="md" fill="accent" className="text-xs font-bold">
        <span className="size-2 rounded-full bg-on-signal" />
        {activeCount} {activeCount === 1 ? "agent" : "agents"} active
      </Pill>
    ) : null;

  if (compact) {
    return (
      <header
        className={cn("flex shrink-0 items-center gap-2 bg-plum px-4 py-2 text-on-plum", className)}
        {...props}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <h1 className="min-w-0 truncate type-title">{name}</h1>
          {visibility === "private" ? (
            <span title="Private to its operators" className="flex shrink-0 text-on-plum-muted">
              <Icon icon={Lock} size={16} label="Private to its operators" />
            </span>
          ) : null}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {!routinesEnabled ? (
            <Pill size="xs" fill="ochre-tint">
              Routines off
            </Pill>
          ) : null}
          {activeCount !== undefined && activeCount > 0 ? (
            <Pill size="xs" fill="accent" className="text-xs font-bold">
              <span className="size-1.5 rounded-full bg-on-signal" />
              {activeCount} active
            </Pill>
          ) : null}
          {actions}
        </div>
      </header>
    );
  }

  return (
    <header
      className={cn("flex shrink-0 flex-col gap-3.5 bg-plum px-10 pt-7 pb-8 text-on-plum", className)}
      {...props}
    >
      {eyebrow}
      <div className="flex flex-wrap items-center gap-5">
        {stack}
        {title}
        {badges}
        <div className="ml-auto flex items-center gap-2">
          {active}
          {actions}
        </div>
      </div>
      {about ? (
        <div className="max-w-160 text-lg text-pretty text-on-plum-muted">{about}</div>
      ) : null}
    </header>
  );
}
