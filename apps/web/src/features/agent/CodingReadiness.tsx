import { useNavigate } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { Banner, IconButton } from "@guildsrun/ui";
import { useAgentHarness } from "../../api/queries";
import { codingProblems, codingProblemsSentence, codingProblemsText } from "./harness";

/** A warning in the agent's header while its coding runs would fail at start; it leads to Settings. */
export function CodingNotReadyButton({ guildId, agentId }: { guildId: string; agentId: string }) {
  const navigate = useNavigate();
  const status = useAgentHarness(agentId);
  const problems = status.data ? codingProblems(status.data) : [];
  if (!problems.length) return null;
  const text = codingProblemsText(problems);
  return (
    <IconButton
      icon={TriangleAlert}
      label={text}
      title={text}
      variant="surface"
      className="text-t-ochre-fg"
      onClick={() =>
        void navigate({
          to: "/guilds/$guildId/agents/$agentId/settings",
          params: { guildId, agentId },
        })
      }
    />
  );
}

/** A banner at the top of a coding agent's Settings while its saved setup would fail a coding run at start. */
export function CodingReadinessBanner({ agentId }: { agentId: string }) {
  const status = useAgentHarness(agentId);
  const problems = status.data ? codingProblems(status.data) : [];
  if (!problems.length) return null;
  return (
    <Banner tone="warning" title="Coding isn't ready">
      {codingProblemsSentence(problems)}
    </Banner>
  );
}
