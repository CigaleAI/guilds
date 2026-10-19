import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Archive, ArrowLeft, Plus } from "lucide-react";
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
import type { StudioDraft } from "../../api/types";
import { useMediaQuery } from "../../app/media";
import {
  Button,
  Segmented,
  PageError,
  SkeletonRows,
  ConfirmDialog,
  WorkspaceHeader,
  toast,
  cn,
  Icon,
} from "@guildsrun/ui";
import { AgentsSection } from "./AgentsSection";
import { ApprovalTray } from "./ApprovalTray";
import { useApprovals } from "./approvals";
import { clearPin, readPin, type StudioPin } from "./investigate";
import { studioSectionLabel, type StudioSearch } from "./location";
import { Splitter, useSplitShare } from "../coach/Splitter";
import { LoginsPopover } from "./LoginsPopover";
import { SectionBar } from "./SectionBar";
import { StateSection } from "./state/StateSection";
import { StudioChat } from "./StudioChat";
import { StudioContext, useStudio, type StudioView } from "./StudioContext";
import { ProposalPanel } from "./ProposalCards";
import { OverviewTab } from "./tabs/OverviewTab";
import { openDraft } from "./tabs/TaskTabs";
import { ToolsSection } from "./tools/ToolsSection";

/** Below this width the inspector and the coach take turns. */
const splitScreen = "(min-width: 64rem)";
const splitKey = "studio.split";

/**
 * One Studio session: the guild, its agents (topology, then prompt, drafts, history, memory,
 * routines, scripts and Task versions), its state, and the tools its agents call, beside the
 * coach conversation, with evidence from any of them pinned to the next message.
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
  const approvals = useApprovals({
    sessionId,
    session: session.data,
    messages: messages.data,
    drafts: drafts.data,
  });

  const agents = inventory.data ?? [];

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

  const streamText = useStudioStream(sessionId);

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
        section: "agents",
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
    approvals,
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
              {data.status === "active" ? <ApprovalTray /> : null}
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

        {live ? <SectionBar /> : null}

        {!split ? (
          <div className="border-b border-line px-4 py-2 md:px-6">
            <Segmented
              size="sm"
              label="Show"
              value={pane}
              onValueChange={setPane}
              options={[
                { value: "inspect", label: studioSectionLabel[search.section] },
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
                <Inspector drafts={drafts.data ?? []} pending={pending} />
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

/** The open section's view, under the coach's requests that wait in it. */
function Inspector({ drafts, pending }: { drafts: StudioDraft[]; pending: StudioDraft[] }) {
  const { search, approvals } = useStudio();
  if (search.section === "agents") return <AgentsSection drafts={drafts} />;
  return (
    <>
      <ProposalPanel
        proposals={approvals.open.filter((proposal) => proposal.place === search.section)}
      />
      {search.section === "state" ? (
        <StateSection />
      ) : search.section === "tools" ? (
        <ToolsSection />
      ) : (
        <OverviewTab pending={pending} />
      )}
    </>
  );
}
