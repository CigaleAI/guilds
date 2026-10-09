import { CircleHelp, Clock, MessagesSquare, User, type LucideIcon } from "lucide-react";
import { useCallback, useState } from "react";
import type { ActivityAgent, ActivityTriggerReason, ActivityView } from "../../../api/types";
import { agentLook } from "../../../app/agents";
import { cn, identityFill, identityText, Icon } from "@guildsrun/ui";
import type { ActivityIndex, ActivityMap, Chain } from "./activityModel";
import { DIRECT_NODE, MESSAGE_NODE, OPERATOR_NODE, type MapNodeKind } from "./activityModel";

/** One loaded window: the ledger, its lookups, its chains and its map. */
export type ActivityData = {
  view: ActivityView;
  index: ActivityIndex;
  chains: Chain[];
  map: ActivityMap;
};

/** Why a message reached the agent it woke, in a word. */
export const reasonLabel: Record<ActivityTriggerReason, string> = {
  tag: "tagged",
  jev: "routed",
  rules: "rules",
  fallback: "fallback",
};

export const sourceIcon: Record<Exclude<MapNodeKind, "agent">, LucideIcon> = {
  routine: Clock,
  operator: User,
  direct: MessagesSquare,
  message: CircleHelp,
};

/** A map node's name: a routine's description, the operator's messages or chats, or an agent's handle. */
export function nodeName(index: ActivityIndex, id: string): string {
  if (id.startsWith("routine:")) {
    return index.routines.get(id.slice(8))?.description || "A routine no longer listed";
  }
  if (id === OPERATOR_NODE) return "Your messages";
  if (id === DIRECT_NODE) return "Direct chats";
  if (id === MESSAGE_NODE) return "Messages outside the window";
  return index.agents.get(id)?.name ?? "agent";
}

/** An agent's mascot or initial on its identity colour, at inline size. */
export function AgentMark({
  agent,
  size = 16,
  className,
}: {
  agent: ActivityAgent | undefined;
  size?: 14 | 16 | 20;
  className?: string;
}) {
  const look = agent ? agentLook(agent) : { tone: "dusk" as const };
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xs font-mono text-[9px] font-semibold",
        identityFill[look.tone],
        className,
      )}
      style={{ width: size, height: size }}
    >
      {look.src ? (
        <img src={look.src} alt="" className="size-full object-cover" draggable={false} />
      ) : (
        (agent?.name[0] ?? "?").toUpperCase()
      )}
    </span>
  );
}

/** An agent's handle in its identity colour. */
export function AgentName({
  agent,
  className,
}: {
  agent: ActivityAgent | undefined;
  className?: string;
}) {
  const tone = agent ? agentLook(agent).tone : "dusk";
  return (
    <span className={cn("truncate font-mono", identityText[tone], className)}>
      {agent?.name ?? "agent"}
    </span>
  );
}

/** What a map node looks like inline: an agent's mark, or the icon of a routine, the operator or a chat. */
export function NodeMark({
  index,
  id,
  kind,
}: {
  index: ActivityIndex;
  id: string;
  kind: MapNodeKind;
}) {
  if (kind === "agent") return <AgentMark agent={index.agents.get(id)} />;
  return <Icon icon={sourceIcon[kind]} size={16} className="text-muted" />;
}

/** The width of an element, kept current as it resizes. */
export function useWidth() {
  const [width, setWidth] = useState(0);
  const ref = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}
