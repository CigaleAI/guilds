import { Link } from "@tanstack/react-router";
import { ArrowUpRight, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { StudioAgent, StudioDraft } from "../../api/types";
import { agentLook } from "../../app/agents";
import { AgentTabs, Icon, PillCount, Tag, tabsList, tabsTrigger } from "@guildsrun/ui";
import { ActivityLedger } from "./activity/ActivityLedger";
import { countOpen } from "./pendingModel";
import { ProposalPanel } from "./ProposalCards";
import {
  studioAgentTabs,
  studioTabLabel,
  type StudioAgentTab,
  type StudioSearch,
  type StudioTab,
} from "./location";
import { useStudio } from "./StudioContext";
import { HistoryTab } from "./tabs/HistoryTab";
import { MemoryTab } from "./tabs/MemoryTab";
import { RoutinesTab } from "./tabs/RoutinesTab";
import { ScriptsTab } from "./tabs/ScriptsTab";
import { DraftTab, openDraft, PromptTab } from "./tabs/TaskTabs";
import { VersionsTab } from "./tabs/VersionsTab";
import { warningLabel } from "./warnings";

/** The guild's topology, then one inspector per agent. */
export function AgentsSection({ drafts }: { drafts: StudioDraft[] }) {
  const { agents, search } = useStudio();
  const agent = agents.find((item) => item.id === search.agent) ?? null;
  return (
    <>
      <AgentStrip current={agent} />
      <div className="flex min-h-0 flex-1 flex-col">
        {agent ? (
          <AgentInspector
            agent={agent}
            drafts={drafts.filter((draft) => draft.target_agent_id === agent.id)}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
            <ActivityLedger />
          </div>
        )}
      </div>
    </>
  );
}

/** Topology and each of the guild's agents, to point the inspector at. */
function AgentStrip({ current }: { current: StudioAgent | null }) {
  const { agents, go, approvals } = useStudio();
  const counts = countOpen(approvals.proposals, (proposal) =>
    proposal.place === "agents" ? proposal.agentId : null,
  );
  return (
    <AgentTabs
      overview={{ label: "Topology" }}
      agents={agents.map((item) => ({
        id: item.id,
        name: item.name,
        ...agentLook(item),
        version: item.task_version,
        title: item.warnings.map((warning) => warningLabel[warning]).join(", ") || item.focus,
        marks: <AgentMarks agent={item} pending={counts[item.id] ?? 0} />,
      }))}
      current={current?.id ?? null}
      onSelect={(agentId) =>
        go(agentId ? { section: "agents", agent: agentId } : { section: "agents" })
      }
    />
  );
}

function AgentMarks({ agent, pending }: { agent: StudioAgent; pending: number }) {
  return (
    <>
      {pending ? <PillCount aria-label={`${pending} to approve`}>{pending}</PillCount> : null}
      {agent.draft_id && agent.draft_status && openDraft({ status: agent.draft_status }) ? (
        <Tag tone="signal" font="sans">
          draft
        </Tag>
      ) : null}
      {agent.warnings.length ? (
        <Icon icon={TriangleAlert} size={14} className="text-t-ochre-fg" />
      ) : null}
    </>
  );
}

/** The tab an agent opens on when the URL names none it has. */
function agentTab(
  requested: StudioTab | undefined,
  drafts: StudioDraft[],
  tabs: readonly StudioAgentTab[],
): StudioAgentTab {
  const tab = tabs.find((value) => value === requested);
  if (tab) return tab;
  return drafts.some(openDraft) ? "draft" : "prompt";
}

/** Where an agent's notes and tables open: State, filtered to the agent. */
const stateLinks: { label: string; search: (agentId: string) => StudioSearch }[] = [
  {
    label: "Files",
    search: (agent) => ({ section: "state", agent, tab: "list", kind: "notes" }),
  },
  {
    label: "Tables",
    search: (agent) => ({ section: "state", agent, tab: "list", kind: "tables" }),
  },
];

/** One agent's tabs and the open tab's view. */
function AgentInspector({ agent, drafts }: { agent: StudioAgent; drafts: StudioDraft[] }) {
  const { session, search, approvals } = useStudio();
  const waiting = countOpen(approvals.proposals, (proposal) =>
    proposal.agentId === agent.id && proposal.place === "agents"
      ? (proposal.location?.tab ?? null)
      : null,
  );
  const tabs = studioAgentTabs.filter((value) => value !== "scripts" || agent.scripting !== false);
  const tab = agentTab(search.tab, drafts, tabs);
  const open = drafts.filter(openDraft).length;
  return (
    <>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        <nav aria-label={`Inspect ${agent.name}`} className={tabsList({ look: "track" })}>
          {tabs.map((value) => (
            <Link
              key={value}
              to="/studio/$sessionId"
              params={{ sessionId: session.id }}
              search={{ section: "agents", agent: agent.id, tab: value }}
              aria-current={value === tab ? "page" : undefined}
              className={tabsTrigger({ look: "track" })}
            >
              {studioTabLabel[value]}
              {value === "draft" && open ? <PillCount>{open}</PillCount> : null}
              {waiting[value] ? (
                <span className="size-2 rounded-full bg-signal" aria-label="waiting on approval" />
              ) : null}
            </Link>
          ))}
          {stateLinks.map((link) => (
            <Link
              key={link.label}
              to="/studio/$sessionId"
              params={{ sessionId: session.id }}
              search={link.search(agent.id)}
              title={`Open ${agent.name}'s ${link.label.toLowerCase()} in State`}
              className={tabsTrigger({ look: "track" })}
            >
              {link.label}
              <Icon icon={ArrowUpRight} size={14} className="text-muted" />
            </Link>
          ))}
        </nav>
      </div>
      <ProposalPanel
        proposals={approvals.open.filter(
          (proposal) =>
            proposal.agentId === agent.id &&
            proposal.widget.kind !== "draft" &&
            proposal.location?.tab === tab,
        )}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <AgentView agent={agent} tab={tab} drafts={drafts} />
      </div>
    </>
  );
}

const agentViews: Record<
  StudioAgentTab,
  (props: { agent: StudioAgent; drafts: StudioDraft[] }) => ReactNode
> = {
  prompt: ({ agent }) => <PromptTab agent={agent} />,
  draft: ({ agent, drafts }) => <DraftTab agent={agent} drafts={drafts} />,
  history: ({ agent }) => <HistoryTab agent={agent} />,
  memory: ({ agent }) => <MemoryTab agent={agent} />,
  routines: ({ agent }) => <RoutinesTab agent={agent} />,
  scripts: ({ agent }) => <ScriptsTab agent={agent} />,
  versions: ({ agent }) => <VersionsTab agent={agent} />,
};

function AgentView({
  agent,
  tab,
  drafts,
}: {
  agent: StudioAgent;
  tab: StudioAgentTab;
  drafts: StudioDraft[];
}) {
  return agentViews[tab]({ agent, drafts });
}
