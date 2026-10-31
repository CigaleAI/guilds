import { MessageSquarePlus } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { useAgent } from "../../../api/queries/agents";
import {
  useCancelRun,
  useResumeRun,
  useRun,
  useRunMessages,
  useSendRunMessage,
  useStartRun,
} from "../../../api/queries/runs";
import { useOrgModels } from "../../../api/queries/models";
import { useRunStream } from "../../../api/streams";
import { progressLineCount } from "../../../api/toolProgress";
import type { AgentDetail } from "../../../api/types/agents";
import type { OrgModels } from "../../../api/types/models";
import type { LiveTurn } from "../../../api/liveTurn";
import type { ToolProgress } from "../../../api/toolProgress";
import type { Run } from "../../../api/types/runs";
import type { Schedule } from "../../../api/types/schedules";
import { messageTime } from "../../../app/format";
import { useMediaQuery, wideScreen } from "../../../app/media";
import { Button, Composer, Banner, EmptyState, SkeletonRows, toast, Row } from "@guildsrun/ui";
import { ChangesPanel } from "./ChangesPanel";
import type { RevealStep } from "./FlowView";
import { HistoryDrawer } from "./HistoryDrawer";
import { RunStatus, useChatSession, type ChatSearch } from "./SessionChrome";
import { Transcript } from "./Transcript";
import { useIdentity } from "../../../app/identity";
import { runIsCapped, runTitle } from "../runState";

const bottomSlack = 64;

/** Why the composer takes no images with this model; undefined when the model takes them. */
export function attachmentsNote(models: OrgModels | undefined, model: string): string | undefined {
  const listed = models?.models.find((item) => item.id === model);
  if (listed?.attachments === true) return undefined;
  if (!models) return "Checking whether this model accepts images";
  return listed
    ? `${listed.label} does not accept images`
    : "This agent's model is not among the organisation's chosen models";
}

/** The step a chat link opens: the call or the message sequence it names; undefined for neither. */
export function revealOf(search: ChatSearch): RevealStep | undefined {
  if (search.call === undefined && search.seq === undefined) return undefined;
  return {
    ...(search.call !== undefined ? { call: search.call } : {}),
    ...(search.seq !== undefined ? { seq: search.seq } : {}),
  };
}

type SessionHistoryProps = {
  wide: boolean;
  runId: string | undefined;
  onSelect: (id: string | null) => void;
  onClose: () => void;
};

/** The session drawer: beside the transcript on a wide screen, over it behind a scrim otherwise. */
function SessionHistory({ wide, runId, onSelect, onClose }: SessionHistoryProps) {
  return (
    <>
      {!wide ? (
        <button
          type="button"
          aria-label="Hide history"
          className="absolute inset-0 z-10 bg-panel/40"
          onClick={onClose}
        />
      ) : null}
      <div className={!wide ? "absolute inset-y-0 left-0 z-20 flex" : "contents"}>
        <HistoryDrawer
          {...(runId ? { selectedId: runId } : {})}
          onSelect={onSelect}
          onClose={onClose}
        />
      </div>
    </>
  );
}

type NewSessionProps = {
  agentName: string;
  recent: readonly Run[];
  schedules: readonly Schedule[] | undefined;
  onSelect: (id: string) => void;
};

/** A new session's empty state, with the agent's latest sessions to go back to. */
function NewSession({ agentName, recent, schedules, onSelect }: NewSessionProps) {
  return (
    <div className="flex flex-col items-center gap-6 py-6">
      <EmptyState
        icon={MessageSquarePlus}
        title={`New session with ${agentName}`}
        description="Each session starts from the agent's current prompt, tools and memory."
      />
      {recent.length ? (
        <div className="flex w-full max-w-120 flex-col gap-1">
          <span className="px-2 type-label text-muted">Recent sessions</span>
          {recent.slice(0, 5).map((candidate) => (
            <Row
              key={candidate.id}
              asChild
              interactive
              title={runTitle(candidate, schedules)}
              meta={messageTime(candidate.created_at)}
              trail={<RunStatus run={candidate} />}
            >
              <button type="button" onClick={() => onSelect(candidate.id)} />
            </Row>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type SessionLoadingProps = {
  run: ReturnType<typeof useRun>;
  messages: ReturnType<typeof useRunMessages>;
};

/** A session while its run or its messages load, or why they could not. */
function SessionLoading({ run, messages }: SessionLoadingProps) {
  if (!run.isError && !messages.isError) {
    return <SkeletonRows rows={5} label="Loading the session" />;
  }
  return (
    <Banner
      tone="error"
      title="Couldn't load this session"
      meta={(run.error ?? messages.error)?.message}
    />
  );
}

type SessionEndProps = {
  run: Run;
  resuming: boolean;
  onResume: () => void;
  onSelect: (id: string | null) => void;
};

/**
 * How an ended session goes on: in the run it handed over to, by resuming it, or in a new
 * session once it reached its limit; nothing while it is active.
 */
function SessionEnd({ run, resuming, onResume, onSelect }: SessionEndProps) {
  if (run.status === "active") return null;
  const continuedIn = run.continued_by_run_id ?? null;
  if (continuedIn) {
    return (
      <Banner
        tone="info"
        title="This session continued in a new run"
        className="mx-auto w-full max-w-240"
        action={
          <Button variant="outline" size="sm" onClick={() => onSelect(continuedIn)}>
            Open it
          </Button>
        }
      >
        The agent handed its work over near its input limit; the next run picks it up.
      </Banner>
    );
  }
  const canResume = !runIsCapped(run);
  return (
    <Banner
      tone="info"
      title={canResume ? "This session has ended" : "This session reached its limit"}
      className="mx-auto w-full max-w-240"
      action={
        canResume ? (
          <Button variant="outline" size="sm" disabled={resuming} onClick={onResume}>
            Resume
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={() => onSelect(null)}>
            New session
          </Button>
        )
      }
    >
      {canResume
        ? "Resume it to keep talking, or start a new session."
        : "Start a new session to continue."}
    </Banner>
  );
}

type SessionComposerProps = {
  agent: AgentDetail;
  run: Run | undefined;
  wide: boolean;
  /** A message is on its way: the session is starting, or the message is being sent. */
  sending: boolean;
  onSend: (content: string, files?: File[]) => void;
  onCancel: () => void;
};

/** The message box: it starts a session or writes in this one, and stops the run while it generates. */
function SessionComposer({ agent, run, wide, sending, onSend, onCancel }: SessionComposerProps) {
  const { org } = useIdentity();
  const models = useOrgModels(org.id);
  const attachmentsUnavailable = attachmentsNote(models.data, agent.config.model);
  return (
    <Composer
      className="mx-auto w-full max-w-240"
      variant={wide ? "card" : "inline"}
      label={`Message ${agent.name}`}
      placeholder={run ? `Send a message to ${agent.name}…` : `Start a session with ${agent.name}…`}
      onSend={onSend}
      acceptAttachments={!attachmentsUnavailable}
      {...(attachmentsUnavailable ? { attachmentsUnavailable } : {})}
      generating={Boolean(run?.generating) || sending}
      onCancel={onCancel}
      disabled={run ? run.status !== "active" : false}
    />
  );
}

type SessionViewProps = {
  agent: AgentDetail;
  run: ReturnType<typeof useRun>;
  messages: ReturnType<typeof useRunMessages>;
  live: LiveTurn | null;
  progress: ToolProgress;
  search: ChatSearch;
};

/** An open session: its transcript once it loads, opened where the link points, and what it changed. */
function SessionView({ agent, run, messages, live, progress, search }: SessionViewProps) {
  const current = run.data;
  const reveal = revealOf(search);
  return (
    <>
      {!current || !messages.data ? (
        <SessionLoading run={run} messages={messages} />
      ) : (
        <Transcript
          key={`${current.id}:${search.call ?? ""}:${search.seq ?? ""}`}
          agent={agent}
          run={current}
          messages={messages.data}
          live={live}
          progress={progress}
          {...(reveal ? { reveal } : {})}
        />
      )}
      {current ? <ChangesPanel run={current} /> : null}
    </>
  );
}

/**
 * The agent's conversations. Without `?run=`, the chat shows the run that is generating, keeps that
 * run when it finishes, or a new session when none is; `?history=true` opens the session drawer
 * beside the transcript.
 */
export function AgentChat() {
  const { agentId, search, runId, run, schedules, selectRun, toggleHistory, recent } =
    useChatSession();
  const wide = useMediaQuery(wideScreen);
  const agent = useAgent(agentId);
  const messages = useRunMessages(runId);
  const start = useStartRun(agentId);
  const send = useSendRunMessage(agentId);
  const cancel = useCancelRun(agentId);
  const resume = useResumeRun(agentId);
  const log = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const { live, progress } = useRunStream(agentId, runId, (next) => selectRun(next));
  const progressLines = progressLineCount(progress);

  useLayoutEffect(() => {
    atBottom.current = true;
  }, [runId]);

  useLayoutEffect(() => {
    const el = log.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [
    messages.data?.length,
    live?.text,
    live?.reasoning,
    progressLines,
    run.data?.generating,
    runId,
  ]);

  const failed = (title: string) => (error: Error) =>
    toast({ kind: "error", title, description: error.message });

  const onSend = (content: string, files?: File[]) => {
    atBottom.current = true;
    if (!run.data) {
      start.mutate(
        { message: content, ...(files?.length ? { files } : {}) },
        {
          onSuccess: (created) => selectRun(created.id),
          onError: failed("Couldn't start the session"),
        },
      );
      return;
    }
    send.mutate(
      { runId: run.data.id, content, ...(files?.length ? { files } : {}) },
      { onError: failed("Couldn't send the message") },
    );
  };

  if (!agent.data) return null;
  const current = run.data;

  return (
    <div className="relative flex min-h-0 flex-1">
      {search.history ? (
        <SessionHistory wide={wide} runId={runId} onSelect={selectRun} onClose={toggleHistory} />
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          ref={log}
          onScroll={(event) => {
            const el = event.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < bottomSlack;
          }}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-7 md:py-6"
        >
          <div className="mx-auto flex max-w-240 flex-col gap-3">
            {!runId ? (
              <NewSession
                agentName={agent.data.name}
                recent={recent}
                schedules={schedules.data}
                onSelect={selectRun}
              />
            ) : (
              <SessionView
                agent={agent.data}
                run={run}
                messages={messages}
                live={live}
                progress={progress}
                search={search}
              />
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-2 px-4 pb-3 md:px-7 md:pb-6">
          {current ? (
            <SessionEnd
              run={current}
              resuming={resume.isPending}
              onResume={() =>
                resume.mutate(current.id, { onError: failed("Couldn't resume the session") })
              }
              onSelect={selectRun}
            />
          ) : null}
          <SessionComposer
            agent={agent.data}
            run={current}
            wide={wide}
            sending={start.isPending || send.isPending}
            onSend={onSend}
            onCancel={() =>
              current && cancel.mutate(current.id, { onError: failed("Couldn't stop the run") })
            }
          />
        </div>
      </div>
    </div>
  );
}
