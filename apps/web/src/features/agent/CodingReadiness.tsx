import { useNavigate } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { Banner, IconButton } from "@guildsrun/ui";
import { useAgentHarness } from "../../api/queries/agents";
import {
  codingProblems,
  codingProblemsSentence,
  codingProblemsText,
  type CodingProblem,
} from "./harness";
import { problemSection } from "./settings/sections";

type CodingNotReadyButtonProps = { guildId: string; agentId: string };

/**
 * A warning in the agent's header while its coding runs would fail at start; it opens the Settings
 * section where the first problem is fixed.
 */
export function CodingNotReadyButton({ guildId, agentId }: CodingNotReadyButtonProps) {
  const navigate = useNavigate();
  const status = useAgentHarness(agentId);
  const problems = status.data ? codingProblems(status.data) : [];
  const [first] = problems;
  if (!first) return null;
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
          search: { section: problemSection(first) },
        })
      }
    />
  );
}

type CodingReadinessBannerProps = { title: string; problems: readonly CodingProblem[] };

/**
 * A banner at the top of a coding or subscription agent's Settings while its saved setup would fail
 * its harness at start, naming every problem; nothing without one.
 */
export function CodingReadinessBanner({ title, problems }: CodingReadinessBannerProps) {
  if (!problems.length) return null;
  return (
    <Banner tone="warning" title={title}>
      {codingProblemsSentence(problems)}
    </Banner>
  );
}
