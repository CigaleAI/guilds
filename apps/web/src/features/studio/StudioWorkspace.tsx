import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Archive, ArrowLeft, Plus, TriangleAlert } from "lucide-react";
import { useState } from "react";
import {
  useArchiveStudio,
  useContinueStudio,
  useSetStudioTarget,
  useStudioDrafts,
  useStudioInventory,
  useStudioMessages,
  useStudioSession,
} from "../../api/queries";
import { useStudioStream } from "../../api/streams";
import type { StudioAgent, StudioDraft } from "../../api/types";
import { agentLook } from "../../app/agents";
import { useMediaQuery } from "../../app/media";
import {
  Button,
  Segmented,
  tabsList,
  tabsTrigger,
  PageError,
  SkeletonRows,
  ConfirmDialog,
  AgentTabs,
  WorkspaceHeader,
  toast,
  cn,
  Icon,
  PillCount,
  Tag,
} from "@guildsrun/ui";
import { clearPin, readPin, type StudioPin } from "./investigate";
import {
  studioAgentTabs,
  studioGuildTabs,
  studioTabLabel,
  type StudioSearch,
  type StudioTab,
} from "./location";
import { Splitter, useSplitShare } from "../coach/Splitter";
import { LoginsPopover } from "./LoginsPopover";
import { StudioChat } from "./StudioChat";
import { StudioContext, useStudio, type StudioView } from "./StudioContext";
import { DatabasesTab, FilesTab } from "./tabs/DataTabs";
import { HistoryTab } from "./tabs/HistoryTab";
import { MemoryTab } from "./tabs/MemoryTab";
import { OverviewTab } from "./tabs/OverviewTab";
import { RoutinesTab } from "./tabs/RoutinesTab";
import { ScriptsTab } from "./tabs/ScriptsTab";
import { DraftTab, openDraft, PromptTab } from "./tabs/TaskTabs";
import { VersionsTab } from "./tabs/VersionsTab";
import { warningLabel } from "./warnings";

/** Below this width the inspector and the coach take turns. */
const splitScreen = "(min-width: 64rem)";
const splitKey = "studio.split";

/**
 * One Studio session: the guild's agents to inspect (prompt, drafts, history, memory, routines,
 * scripts, files, databases and Task versions) or the guild's activity, beside the coach
 * conversation, with evidence from either pinned to the next message.
 */
export function StudioWorkspace() {
  const { sessionId } = useParams({ from: "/studio/$sessionId" });
  return <Workspace key={sessionId} sessionId={sessionId} />;
}

function Workspace({ sessionId }: { sessionId: string }) {
  const search = useSearch({ from: "/studio/$sessionId" });
  const navigate = useNavigate();
  const session = useStudioSession(sessionId);
  const messages = useStudioMessages(sessionId, session.data?.generation_state !== "idle");
  const live = session.data?.status === "active";
  const inventory = useStudioInventory(sessionId, live);
  const drafts = useStudioDrafts(sessionId);
  const setTarget = useSetStudioTarget(sessionId);
  const archive = useArchiveStudio(sessionId);
  const continueSession = useContinueStudio(sessionId);
  const [archiving, setArchiving] = useState(false);
  const [pin, setPin] = useState<StudioPin | null>(() => readPin(sessionId));
  const split = useMediaQuery(splitScreen);
  const [pane, setPane] = useState<"inspect" | "coach">("inspect");
  const [share, setShare] = useSplitShare(splitKey, 0.65);

  const agents = (inventory.data ?? []).filter((agent) => !agent.archived);

  const go = (next: StudioSearch, options?: { replace?: boolean }) => {
    void navigate({
      to: "/studio/$sessionId",
      params: { sessionId },
      search: next,
      ...(options?.replace ? { replace: true } : {}),
    });
    const target = next.agent ?? null;
    if (live && target !== (session.data?.selected_target_agent_id ?? null))
      setTarget.mutate(target);
  };

  const streamText = useStudioStream(sessionId, (draft) => {
    if (draft.target_agent_id) go({ agent: draft.target_agent_id, tab: "draft" });
  });

  if (session.isError) {
    return (
      <div className="grid flex-1 place-items-center p-6">
        <PageError title="Couldn't open this session" description={session.error.message} />
      </div>
    );
  }
  if (!session.data) {
    return (
      <div className="p-8">
        <SkeletonRows rows={6} label="Loading the session" />
      </div>
    );
  }

  const data = session.data;
  const agent = agents.find((item) => item.id === search.agent) ?? null;
  const pending = (drafts.data ?? []).filter(openDraft);
  const view: StudioView = {
    session: data,
    agents,
    search,
    go,
    openStep: ({ agentId, runId, call, seq }) => {
      if (!agents.some((item) => item.id === agentId)) {
        toast({ kind: "error", title: "That run belongs to an agent outside this guild" });
        return;
      }
      go({
        agent: agentId,
        tab: "history",
        item: runId,
        ...(call ? { call } : {}),
        ...(seq !== null && seq !== undefined ? { seq } : {}),
      });
      setPane("inspect");
    },
    ask: (focus) => {
      setPin({ focus, prompt: "" });
      setPane("coach");
    },
  };
  const unpin = () => {
    clearPin(sessionId);
    setPin(null);
  };

  return (
    <StudioContext value={view}>
      <div className="flex min-h-0 flex-1 flex-col">
        <WorkspaceHeader
          eyebrow="Studio"
          title={data.source_guild?.name ?? "Guild"}
          meta={`coach · ${data.coach.model} · temp ${data.coach.temperature}`}
          status={{
            label: data.status === "active" ? `active · ${data.generation_state}` : data.status,
            live: data.status === "active",
          }}
          actions={
            <>
              <Button asChild variant="on-panel" size="sm">
                <Link to="/guilds/$guildId" params={{ guildId: data.source_guild_id }}>
                  <Icon icon={ArrowLeft} size={14} />
                  Back to guild
                </Link>
              </Button>
              {data.status === "blocked" && data.blocked_reason === "input_token_limit" ? (
                <Button
                  variant="accent"
                  size="sm"
                  disabled={continueSession.isPending}
                  onClick={() =>
                    continueSession.mutate(undefined, {
                      onSuccess: (next) =>
                        void navigate({ to: "/studio/$sessionId", params: { sessionId: next.id } }),
                      onError: (error) =>
                        toast({
                          kind: "error",
                          title: "Couldn't continue",
                          description: error.message,
                        }),
                    })
                  }
                >
                  Continue in a new session
                </Button>
              ) : null}
              {data.status === "active" ? <LoginsPopover session={data} /> : null}
              <Button asChild variant="on-panel" size="sm">
                <Link to="/studio" search={{ guild: data.source_guild_id }}>
                  <Icon icon={Plus} size={14} />
                  New session
                </Link>
              </Button>
              {data.status !== "archived" ? (
                <Button variant="on-panel" size="sm" onClick={() => setArchiving(true)}>
                  <Icon icon={Archive} size={14} />
                  Archive
                </Button>
              ) : null}
            </>
          }
        />

        {live ? <AgentStrip agents={agents} current={agent} pending={pending} /> : null}

        {!split ? (
          <div className="border-b border-line px-4 py-2 md:px-6">
            <Segmented
              size="sm"
              label="Show"
              value={pane}
              onValueChange={setPane}
              options={[
                { value: "inspect", label: agent ? agent.name : "Guild" },
                { value: "coach", label: "Coach" },
              ]}
            />
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1">
          {split || pane === "inspect" ? (
            <section
              aria-label="Inspector"
              className={cn("flex min-h-0 min-w-0 flex-col", split ? "flex-none" : "flex-1")}
              style={split ? { width: `${share * 100}%` } : undefined}
            >
              {live ? (
                <Inspector agent={agent} drafts={drafts.data ?? []} pending={pending} />
              ) : (
                <p className="p-6 text-sm text-muted">
                  This session is not live, so its guild can't be inspected here.
                </p>
              )}
            </section>
          ) : null}
          {split ? (
            <Splitter
              storageKey={splitKey}
              share={share}
              onShareChange={setShare}
              label="Resize the inspector"
            />
          ) : null}
          {split || pane === "coach" ? (
            <section aria-label="Coach" className="flex min-h-0 min-w-0 flex-1 flex-col">
              <StudioChat
                session={data}
                messages={messages.data}
                live={streamText}
                pin={pin}
                onUnpin={unpin}
              />
            </section>
          ) : null}
        </div>

        <ConfirmDialog
          open={archiving}
          onOpenChange={setArchiving}
          title="Archive this session?"
          description="It stays readable, but the coach stops and nothing more can be proposed from it."
          confirmLabel="Archive"
          onConfirm={() =>
            archive.mutateAsync().then(
              () => void navigate({ to: "/studio", search: { guild: data.source_guild_id } }),
              (error: Error) => {
                toast({
                  kind: "error",
                  title: "Couldn't archive the session",
                  description: error.message,
                });
                throw error;
              },
            )
          }
        />
      </div>
    </StudioContext>
  );
}

/** The guild and each of its agents, to point the inspector at. */
function AgentStrip({
  agents,
  current,
  pending,
}: {
  agents: StudioAgent[];
  current: StudioAgent | null;
  pending: StudioDraft[];
}) {
  const { go } = useStudio();
  return (
    <AgentTabs
      overview={{
        label: "Guild overview",
        marks: pending.length ? (
          <span className="size-2 rounded-full bg-signal" aria-label="drafts pending" />
        ) : null,
      }}
      agents={agents.map((item) => ({
        id: item.id,
        name: item.name,
        ...agentLook(item),
        version: item.task_version,
        title: item.warnings.map((warning) => warningLabel[warning]).join(", ") || item.focus,
        marks: (
          <>
            {item.draft_id && item.draft_status && openDraft({ status: item.draft_status }) ? (
              <Tag tone="signal" font="sans">
                draft
              </Tag>
            ) : null}
            {item.warnings.length ? (
              <Icon icon={TriangleAlert} size={14} className="text-t-ochre-fg" />
            ) : null}
          </>
        ),
      }))}
      current={current?.id ?? null}
      onSelect={(agentId) => go(agentId ? { agent: agentId } : {})}
    />
  );
}

/** The tabs for the guild or the selected agent, and the open tab's view. */
function Inspector({
  agent,
  drafts,
  pending,
}: {
  agent: StudioAgent | null;
  drafts: StudioDraft[];
  pending: StudioDraft[];
}) {
  const { session, search } = useStudio();
  const agentDrafts = agent ? drafts.filter((draft) => draft.target_agent_id === agent.id) : [];
  const tabs: readonly StudioTab[] = agent
    ? studioAgentTabs.filter((value) => value !== "scripts" || agent.scripting !== false)
    : studioGuildTabs;
  const requested: StudioTab =
    search.tab ?? (agent ? (agentDrafts.some(openDraft) ? "draft" : "prompt") : "overview");
  const tab: StudioTab = tabs.includes(requested)
    ? requested
    : agent
      ? agentDrafts.some(openDraft)
        ? "draft"
        : "prompt"
      : "overview";
  const count = (value: StudioTab) =>
    value === "draft" && agentDrafts.some(openDraft)
      ? agentDrafts.filter(openDraft).length
      : undefined;

  return (
    <>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        <nav
          aria-label={agent ? `Inspect ${agent.name}` : "Inspect the guild"}
          className={tabsList({ look: "track" })}
        >
          {tabs.map((value) => (
            <Link
              key={value}
              to="/studio/$sessionId"
              params={{ sessionId: session.id }}
              search={{ ...(agent ? { agent: agent.id } : {}), tab: value }}
              aria-current={value === tab ? "page" : undefined}
              className={tabsTrigger({ look: "track" })}
            >
              {studioTabLabel[value]}
              {count(value) !== undefined ? <PillCount>{count(value)}</PillCount> : null}
            </Link>
          ))}
        </nav>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {agent ? (
          <AgentView agent={agent} tab={tab} drafts={agentDrafts} />
        ) : tab === "files" ? (
          <FilesTab agent={null} />
        ) : tab === "databases" ? (
          <DatabasesTab agent={null} />
        ) : (
          <OverviewTab pending={pending} />
        )}
      </div>
    </>
  );
}

function AgentView({
  agent,
  tab,
  drafts,
}: {
  agent: StudioAgent;
  tab: StudioTab;
  drafts: StudioDraft[];
}) {
  switch (tab) {
    case "draft":
      return <DraftTab agent={agent} drafts={drafts} />;
    case "history":
      return <HistoryTab agent={agent} />;
    case "memory":
      return <MemoryTab agent={agent} />;
    case "routines":
      return <RoutinesTab agent={agent} />;
    case "scripts":
      return <ScriptsTab agent={agent} />;
    case "files":
      return <FilesTab agent={agent} />;
    case "databases":
      return <DatabasesTab agent={agent} />;
    case "versions":
      return <VersionsTab agent={agent} />;
    default:
      return <PromptTab agent={agent} />;
  }
}
