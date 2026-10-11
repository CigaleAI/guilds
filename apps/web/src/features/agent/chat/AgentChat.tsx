import { MessageSquarePlus } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import {
  useAgent,
  useCancelRun,
  useOrgModels,
  useResumeRun,
  useRunMessages,
  useSendRunMessage,
  useStartRun,
} from "../../../api/queries";
import { useRunStream } from "../../../api/streams";
import { messageTime } from "../../../app/format";
import { useMediaQuery, wideScreen } from "../../../app/media";
import { Button, Composer, Banner, EmptyState, SkeletonRows, toast, Row } from "@guildsrun/ui";
import { ChangesPanel } from "./ChangesPanel";
import { HistoryDrawer } from "./HistoryDrawer";
import { RunStatus, useChatSession } from "./SessionChrome";
import { Transcript } from "./Transcript";
import { useIdentity } from "../../../app/identity";
import { runIsCapped, runTitle } from "../runState";

const bottomSlack = 64;

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
  const { org } = useIdentity();
  const models = useOrgModels(org.id);
  const messages = useRunMessages(runId);
  const start = useStartRun(agentId);
  const send = useSendRunMessage(agentId);
  const cancel = useCancelRun(agentId);
  const resume = useResumeRun(agentId);
  const log = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const live = useRunStream(agentId, runId, (next) => selectRun(next));

  useLayoutEffect(() => {
    atBottom.current = true;
  }, [runId]);

  useLayoutEffect(() => {
    const el = log.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.data?.length, live?.text, live?.reasoning, run.data?.generating, runId]);

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
  const catalogModel = models.data?.models.find((item) => item.id === agent.data.config.model);
  const acceptAttachments = catalogModel?.attachments === true;
  const attachmentsUnavailable = acceptAttachments
    ? undefined
    : !models.data
      ? "Checking whether this model accepts images"
      : catalogModel
        ? `${catalogModel.label} does not accept images`
        : "This agent's model is not among the organisation's chosen models";
  const current = run.data;
  const ended = current ? current.status !== "active" || Boolean(current.archived_at) : false;
  const continuedIn = current?.continued_by_run_id ?? null;
  const canResume = current
    ? ended &&
      !continuedIn &&
      !current.archived_at &&
      !agent.data.archived_at &&
      !runIsCapped(current)
    : false;

  return (
    <div className="relative flex min-h-0 flex-1">
      {search.history ? (
        <>
          {!wide ? (
            <button
              type="button"
              aria-label="Hide history"
              className="absolute inset-0 z-10 bg-panel/40"
              onClick={toggleHistory}
            />
          ) : null}
          <div className={!wide ? "absolute inset-y-0 left-0 z-20 flex" : "contents"}>
            <HistoryDrawer
              {...(runId ? { selectedId: runId } : {})}
              onSelect={selectRun}
              onClose={toggleHistory}
            />
          </div>
        </>
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
              <div className="flex flex-col items-center gap-6 py-6">
                <EmptyState
                  icon={MessageSquarePlus}
                  title={`New session with ${agent.data.name}`}
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
                        title={runTitle(candidate, schedules.data)}
                        meta={messageTime(candidate.created_at)}
                        trail={<RunStatus run={candidate} />}
                      >
                        <button type="button" onClick={() => selectRun(candidate.id)} />
                      </Row>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : !current || !messages.data ? (
              run.isError || messages.isError ? (
                <Banner
                  tone="error"
                  title="Couldn't load this session"
                  meta={(run.error ?? messages.error)?.message}
                />
              ) : (
                <SkeletonRows rows={5} label="Loading the session" />
              )
            ) : (
              <Transcript
                key={`${current.id}:${search.call ?? ""}:${search.seq ?? ""}`}
                agent={agent.data}
                run={current}
                messages={messages.data}
                live={live}
                {...(search.call !== undefined || search.seq !== undefined
                  ? {
                      reveal: {
                        ...(search.call !== undefined ? { call: search.call } : {}),
                        ...(search.seq !== undefined ? { seq: search.seq } : {}),
                      },
                    }
                  : {})}
              />
            )}
            {current ? <ChangesPanel run={current} /> : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-2 px-4 pb-3 md:px-7 md:pb-6">
          {current && ended && continuedIn ? (
            <Banner
              tone="info"
              title="This session continued in a new run"
              className="mx-auto w-full max-w-240"
              action={
                <Button variant="outline" size="sm" onClick={() => selectRun(continuedIn)}>
                  Open it
                </Button>
              }
            >
              The agent handed its work over near its input limit; the next run picks it up.
            </Banner>
          ) : current && ended ? (
            <Banner
              tone="info"
              title={canResume ? "This session has ended" : "This session reached its limit"}
              className="mx-auto w-full max-w-240"
              action={
                canResume ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={resume.isPending}
                    onClick={() =>
                      resume.mutate(current.id, { onError: failed("Couldn't resume the session") })
                    }
                  >
                    Resume
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => selectRun(null)}>
                    New session
                  </Button>
                )
              }
            >
              {canResume
                ? "Resume it to keep talking, or start a new session."
                : "Start a new session to continue."}
            </Banner>
          ) : null}
          <Composer
            className="mx-auto w-full max-w-240"
            variant={wide ? "card" : "inline"}
            label={`Message ${agent.data.name}`}
            placeholder={
              current
                ? `Send a message to ${agent.data.name}…`
                : `Start a session with ${agent.data.name}…`
            }
            onSend={onSend}
            acceptAttachments={acceptAttachments}
            {...(attachmentsUnavailable ? { attachmentsUnavailable } : {})}
            generating={Boolean(current?.generating) || start.isPending || send.isPending}
            onCancel={() =>
              current && cancel.mutate(current.id, { onError: failed("Couldn't stop the run") })
            }
            disabled={ended || Boolean(agent.data.archived_at)}
          />
        </div>
      </div>
    </div>
  );
}
