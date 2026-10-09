import { Network } from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "../../cn";
import type { IdentityTone } from "../../identity";
import { Icon } from "../../primitives/Icon";
import { SearchField } from "../controls/SearchField";
import { Avatar } from "../identity/Avatar";

export type AgentTab = {
  id: string;
  name: string;
  tone: IdentityTone;
  /** Mascot art for the avatar. */
  src?: string;
  /** The agent's Task version, shown as `v12`. */
  version?: number | null;
  /** Marks after the name, such as a draft tag or a warning icon. */
  marks?: ReactNode;
  /** Tooltip, such as what needs attention. */
  title?: string;
};

export type AgentTabsProps = Omit<ComponentProps<"nav">, "onSelect"> & {
  /** The first tab: the guild as a whole, with its agent count. */
  overview: { label: string; marks?: ReactNode };
  agents: AgentTab[];
  /** The selected agent's id; null while the overview is open. */
  current: string | null;
  onSelect: (agentId: string | null) => void;
  /** The filter shows once there are more agents than this. */
  filterAbove?: number;
};

const tab = cn(
  "flex shrink-0 cursor-pointer items-center gap-2 rounded-full py-1.5 pr-3.5 pl-1.5 text-md font-semibold whitespace-nowrap text-fg",
  "transition-colors hover:bg-paper/60 aria-[current=page]:bg-paper",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
);

/** The guild's overview, then each agent: chips to point a workspace at one of them. They wrap on
 * wide screens and scroll sideways on a phone. */
export function AgentTabs({
  overview,
  agents,
  current,
  onSelect,
  filterAbove = 4,
  className,
  ...props
}: AgentTabsProps) {
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();
  const filtering = agents.length > filterAbove;
  const shown =
    filtering && query
      ? agents.filter((agent) => agent.id === current || agent.name.toLowerCase().includes(query))
      : agents;

  return (
    <nav
      aria-label="Agents"
      className={cn(
        "flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line bg-surface px-3 py-2.5 md:flex-wrap md:overflow-x-visible md:px-5",
        className,
      )}
      {...props}
    >
      <button
        type="button"
        onClick={() => onSelect(null)}
        aria-current={current === null ? "page" : undefined}
        className={tab}
      >
        <span className="grid size-6 place-items-center rounded-sm bg-panel text-on-panel">
          <Icon icon={Network} size={14} />
        </span>
        {overview.label}
        <span className="font-mono text-2xs opacity-75">{agents.length}</span>
        {overview.marks}
      </button>
      {shown.map((agent) => (
        <button
          key={agent.id}
          type="button"
          onClick={() => onSelect(agent.id)}
          aria-current={agent.id === current ? "page" : undefined}
          title={agent.title}
          className={tab}
        >
          <Avatar
            name={agent.name}
            tone={agent.tone}
            size={24}
            {...(agent.src ? { src: agent.src } : {})}
          />
          {agent.name}
          {agent.version !== null && agent.version !== undefined ? (
            <span className="font-mono text-2xs opacity-75">v{agent.version}</span>
          ) : null}
          {agent.marks}
        </button>
      ))}
      {filtering ? (
        <SearchField
          label="Filter agents"
          placeholder="Filter agents…"
          value={filter}
          onValueChange={setFilter}
          className="ml-auto w-48"
        />
      ) : null}
    </nav>
  );
}
