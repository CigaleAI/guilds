import type { StudioAgent, StudioTool } from "../../../api/types/studio";
import { agentLook } from "../../../app/agents";
import { Avatar, cn } from "@guildsrun/ui";

/** The agents offered a tool: a solid ring for those that call it, a dashed one for the rest. */
export function OfferedAgents({ tool, agents }: { tool: StudioTool; agents: StudioAgent[] }) {
  const shown = tool.agents.filter((usage) => usage.offered);
  if (!shown.length) {
    return <span className="text-xs text-muted">no longer offered</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((usage) => {
        const agent = agents.find((item) => item.id === usage.agent_id);
        const name = agent?.name ?? usage.agent_id;
        return (
          <span
            key={usage.agent_id}
            title={usage.calls ? `${name} calls it` : `${name} is offered it and never calls it`}
            className={cn(
              "rounded-full border-2 p-px",
              usage.calls ? "border-signal" : "border-dashed border-line-3",
            )}
          >
            <Avatar
              name={name}
              size={24}
              {...(agent ? agentLook(agent) : { tone: "dusk" as const })}
            />
          </span>
        );
      })}
    </span>
  );
}
