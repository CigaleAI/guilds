import { Link } from "@tanstack/react-router";
import { FolderGit2 } from "lucide-react";
import type { ReactNode } from "react";
import { cn, Icon, Tooltip } from "@guildsrun/ui";
import { useAgentHarness, useSecrets } from "../../api/queries";
import { codingStrip, type StripPart } from "./harness";
import { HarnessLogo } from "./HarnessLogo";
import type { SettingsSection } from "./settings/sections";

/** One part of the strip: a link to the Settings section that sets it, explained on hover. */
function Part({
  part,
  section,
  guildId,
  agentId,
  children,
}: {
  part: StripPart;
  section: Extract<SettingsSection, "harness" | "repositories">;
  guildId: string;
  agentId: string;
  children: ReactNode;
}) {
  return (
    <Tooltip label={part.detail}>
      <Link
        to="/guilds/$guildId/agents/$agentId/settings"
        params={{ guildId, agentId }}
        search={{ section }}
        aria-label={`${part.text}: ${part.detail}`}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-sm px-1.5 transition-colors hover:bg-well focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
          part.problem && "font-semibold",
        )}
      >
        {children}
      </Link>
    </Tooltip>
  );
}

/**
 * One line over a coding agent's chat: the harness that codes, whether it can sign in, and how
 * many repositories it reaches, each explained on hover and leading to the Settings section that
 * sets it. A missing piece is named and turns the strip ochre.
 */
export function CodingStrip({ guildId, agentId }: { guildId: string; agentId: string }) {
  const status = useAgentHarness(agentId);
  const secrets = useSecrets({ scope: "agent", id: agentId });
  if (!status.data) return null;
  const strip = codingStrip({ status: status.data, secrets: secrets.data ?? [], now: new Date() });
  const parts = [strip.harnessPart, strip.credential, strip.repositories];
  const problem = parts.some((part) => part?.problem);
  const where = { guildId, agentId };
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-5 py-1.5 text-sm",
        problem ? "bg-t-ochre text-t-ochre-fg" : "bg-surface text-fg-2",
      )}
    >
      <Part part={strip.harnessPart} section="harness" {...where}>
        {strip.harness ? <HarnessLogo harness={strip.harness} size={24} /> : null}
        {strip.harness && !strip.harnessPart.problem ? (
          <span className="sr-only">{strip.harnessPart.text}</span>
        ) : (
          strip.harnessPart.text
        )}
      </Part>
      {strip.credential ? (
        <Part part={strip.credential} section="harness" {...where}>
          <span
            aria-hidden
            className={cn("size-2 rounded-full", strip.credential.problem ? "bg-ochre" : "bg-tide")}
          />
          {strip.credential.text}
        </Part>
      ) : null}
      <Part part={strip.repositories} section="repositories" {...where}>
        <Icon icon={FolderGit2} size={16} />
        {strip.repositories.text}
      </Part>
    </div>
  );
}
