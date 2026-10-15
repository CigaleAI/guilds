import { Link } from "@tanstack/react-router";
import { Code2 } from "lucide-react";
import { cn, Icon } from "@guildsrun/ui";
import { useAgent, useAgentHarness, useOrgModels, useSecrets } from "../../api/queries";
import { useIdentity } from "../../app/identity";
import { modelLabel } from "../models/models";
import { codingStrip, type StripSegment } from "./harness";

function SegmentLink({
  segment,
  guildId,
  agentId,
}: {
  segment: StripSegment;
  guildId: string;
  agentId: string;
}) {
  const className = cn(
    "underline-offset-2 hover:underline",
    segment.problem && "font-semibold text-t-ochre-fg",
  );
  return (
    <Link
      to="/guilds/$guildId/agents/$agentId/settings"
      params={{ guildId, agentId }}
      search={{ section: segment.to }}
      className={className}
    >
      {segment.text}
    </Link>
  );
}

/**
 * One line over a coding agent's chat: the model that leads, the harness and model that code,
 * what the harness runs on, and the repositories, each leading to the Settings section that sets
 * it. A missing piece
 * is named and turns the strip ochre.
 */
export function CodingStrip({ guildId, agentId }: { guildId: string; agentId: string }) {
  const { org } = useIdentity();
  const agent = useAgent(agentId);
  const models = useOrgModels(org.id);
  const status = useAgentHarness(agentId);
  const secrets = useSecrets({ scope: "agent", id: agentId });
  if (!agent.data || !status.data) return null;
  const segments = codingStrip({
    status: status.data,
    leadModel: modelLabel(models.data, agent.data.config.model),
    secrets: secrets.data ?? [],
    now: new Date(),
  });
  const problem = segments.some((segment) => segment.problem);
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-6 py-2 text-sm",
        problem ? "bg-t-ochre text-t-ochre-fg" : "bg-surface text-fg-2",
      )}
    >
      <Icon icon={Code2} size={14} />
      {segments.map((segment, index) => (
        <span key={segment.to + segment.text} className="flex items-center gap-2">
          {index ? <span aria-hidden="true">·</span> : null}
          <SegmentLink segment={segment} guildId={guildId} agentId={agentId} />
        </span>
      ))}
    </div>
  );
}
