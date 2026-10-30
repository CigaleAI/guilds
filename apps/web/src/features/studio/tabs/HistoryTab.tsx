import { Link } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, MessagesSquare, Pin, Repeat, User } from "lucide-react";
import { useState } from "react";
import { useAgent } from "../../../api/queries/agents";
import { useRun, useRunMessages } from "../../../api/queries/runs";
import { useStudioInspector, useStudioRoutines, useStudioRuns } from "../../../api/queries/studio";
import type { StudioAgent, StudioRoutine, StudioRun } from "../../../api/types/studio";
import { clockTime, dayLabel, relativeTime } from "../../../app/format";
import {
  Button,
  Checkbox,
  Select,
  Banner,
  SkeletonRows,
  Icon,
  Row,
  Tag,
  Tile,
} from "@guildsrun/ui";
import { Transcript } from "../../agent/chat/Transcript";
import { runKindLabel } from "../../agent/runState";
import { DetailHeader, Empty, MasterDetail } from "../MasterDetail";
import { useStudio } from "../StudioContext";
import { isRunKindFilter, type RunKindFilter } from "./historyFilters";

const kindIcon = { direct: User, group: MessagesSquare, schedule: Repeat } as const;
const any = "all";

/** What a run was: its routine, the group chat rows it read up to, or a direct session. */
function runSummary(run: StudioRun, routines: StudioRoutine[] | undefined): string {
  if (run.kind === "schedule") {
    const routine = routines?.find((item) => item.id === run.schedule_id);
    return routine?.description || routine?.label || "Routine";
  }
  if (run.kind === "group") {
    return run.group_chat_through_seq !== null
      ? `Group chat up to #${run.group_chat_through_seq}`
      : "Group chat";
  }
  return "Direct session";
}

/** What the run's list row notes after its time: an older Task. */
function runNotes(run: StudioRun, currentTask: string | undefined): string {
  const notes = [
    ...(currentTask && run.task_prompt_hash && run.task_prompt_hash !== currentTask
      ? ["older Task"]
      : []),
  ];
  return notes.map((note) => ` · ${note}`).join("");
}

type RunStateProps = { run: StudioRun; selected: boolean };

function RunState({ run, selected }: RunStateProps) {
  if (run.generating) {
    return (
      <Tag tone={selected ? "on-plum" : "signal"} font="sans">
        generating
      </Tag>
    );
  }
  if (!run.error_count) return null;
  return (
    <Tag
      tone={selected ? "on-plum" : "plum"}
      font="sans"
      title={run.last_error?.message ?? undefined}
    >
      {run.error_count} error{run.error_count === 1 ? "" : "s"}
    </Tag>
  );
}

type RunRowProps = {
  run: StudioRun;
  routines: StudioRoutine[] | undefined;
  currentTask: string | undefined;
  selected: boolean;
  title?: string;
  /** Appended to the row's notes, such as "older instruction". */
  note?: string;
  onSelect: () => void;
};

/** One row of a run list: what it was, when, and what went wrong. */
export function RunRow({
  run,
  routines,
  currentTask,
  selected,
  title,
  note,
  onSelect,
}: RunRowProps) {
  return (
    <Row
      asChild
      density="compact"
      interactive
      selected={selected}
      lead={
        <Tile size={28} tone="surface">
          <Icon icon={kindIcon[run.kind]} size={14} />
        </Tile>
      }
      title={title ?? runSummary(run, routines)}
      meta={`${dayLabel(run.created_at)} · ${clockTime(run.created_at)}${runNotes(run, currentTask)}${note ? ` · ${note}` : ""}`}
      trail={<RunState run={run} selected={selected} />}
    >
      <button type="button" onClick={onSelect} aria-current={selected ? "true" : undefined} />
    </Row>
  );
}

type HistoryTabProps = { agent: StudioAgent };

/**
 * The agent's runs, newest first, with filters for kind, errors and runs on the current Task;
 * the selected run's transcript opens beside them, at a step when one is named.
 */
export function HistoryTab({ agent }: HistoryTabProps) {
  const { session, search, go, goInPlace } = useStudio();
  const runs = useStudioRuns(session.id, agent.id);
  const routines = useStudioRoutines(session.id, agent.id);
  const inspector = useStudioInspector(session.id, agent.id);
  const [kind, setKind] = useState<RunKindFilter>(any);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [currentOnly, setCurrentOnly] = useState(false);
  const currentTask = inspector.data?.task.effective_hash;

  if (runs.isPending) return <SkeletonRows rows={6} label="Loading runs" className="p-5" />;
  if (runs.isError) {
    return (
      <div className="p-5">
        <Banner tone="error" title="Couldn't load the runs" meta={runs.error.message} />
      </div>
    );
  }

  const listed = runs.data.filter(
    (run) =>
      (kind === any || run.kind === kind) &&
      (!errorsOnly || run.error_count > 0) &&
      (!currentOnly || !currentTask || run.task_prompt_hash === currentTask),
  );
  const selectedId = search.item ?? runs.data[0]?.id;
  const selected = runs.data.find((run) => run.id === selectedId);
  const fromRoutine =
    selected?.schedule_id && search.item
      ? routines.data?.find((routine) => routine.id === selected.schedule_id)
      : undefined;

  return (
    <MasterDetail
      listLabel={`${agent.name}'s runs`}
      toolbar={
        <>
          <Select
            tone="surface"
            aria-label="Run kind"
            className="w-36"
            value={kind}
            onValueChange={(value) => {
              if (isRunKindFilter(value)) setKind(value);
            }}
            options={[
              { value: any, label: "All kinds" },
              ...(["direct", "group", "schedule"] as const).map((value) => ({
                value,
                label: runKindLabel[value],
              })),
            ]}
          />
          <span className="ml-auto type-meta text-muted">
            {listed.length} run{listed.length === 1 ? "" : "s"}
          </span>
          <Checkbox
            label="Errors"
            checked={errorsOnly}
            onCheckedChange={(value) => setErrorsOnly(value === true)}
          />
          <Checkbox
            label="Current Task"
            checked={currentOnly}
            onCheckedChange={(value) => setCurrentOnly(value === true)}
          />
        </>
      }
      list={
        listed.length ? (
          listed.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              routines={routines.data}
              currentTask={currentTask}
              selected={run.id === selectedId}
              onSelect={() =>
                goInPlace({ section: "agents", agent: agent.id, tab: "history", item: run.id })
              }
            />
          ))
        ) : (
          <Empty>{runs.data.length ? "No runs match." : "No runs yet."}</Empty>
        )
      }
      detail={
        selectedId ? (
          <RunDetail
            key={`${selectedId}:${search.call ?? ""}:${search.seq ?? ""}`}
            agent={agent}
            runId={selectedId}
            header={selected}
            title={selected ? runSummary(selected, routines.data) : undefined}
            reveal={{
              ...(search.call ? { call: search.call } : {}),
              ...(search.seq !== undefined ? { seq: search.seq } : {}),
            }}
            back={
              fromRoutine
                ? {
                    label: fromRoutine.description || "Routine",
                    onBack: () =>
                      go({
                        section: "agents",
                        agent: agent.id,
                        tab: "routines",
                        item: fromRoutine.id,
                      }),
                  }
                : undefined
            }
          />
        ) : (
          <Empty>
            No runs yet. Runs appear as the agent chats, reads the group chat, or wakes on a
            routine.
          </Empty>
        )
      }
    />
  );
}

/** The hashes of the prompts an agent runs on now, each present once it is known. */
type PromptHashes = { guidelines?: string; task?: string; memory?: string };

/** Whether the run used what the agent runs on now: its guidelines, Task and memory. */
function sameAsNow(header: StudioRun | undefined, now: PromptHashes): string[] {
  if (!header) return [];
  const notes: string[] = [];
  if (now.task && header.task_prompt_hash)
    notes.push(header.task_prompt_hash === now.task ? "current Task" : "older Task");
  if (now.guidelines && header.system_prompt_hash)
    notes.push(
      header.system_prompt_hash === now.guidelines ? "current guidelines" : "older guidelines",
    );
  if (now.memory && header.memory_prompt_hash)
    notes.push(header.memory_prompt_hash === now.memory ? "current memory" : "older memory");
  return notes;
}

type RunDetailProps = {
  agent: StudioAgent;
  runId: string;
  header: StudioRun | undefined;
  title: string | undefined;
  reveal: { call?: string; seq?: number };
  back: { label: string; onBack: () => void } | undefined;
};

function RunDetail({ agent, runId, header, title, reveal, back }: RunDetailProps) {
  const { session, ask } = useStudio();
  const detail = useAgent(agent.id);
  const run = useRun(runId);
  const messages = useRunMessages(runId);
  const inspector = useStudioInspector(session.id, agent.id);
  const notes = sameAsNow(header, {
    ...(inspector.data?.task.effective_hash ? { task: inspector.data.task.effective_hash } : {}),
    ...(inspector.data ? { guidelines: inspector.data.guidelines.content_hash } : {}),
    ...(inspector.data ? { memory: inspector.data.memory.prompt_hash } : {}),
  });

  if (run.isError || messages.isError) {
    return (
      <Banner
        tone="error"
        title="Couldn't load this run"
        meta={(run.error ?? messages.error)?.message}
      />
    );
  }
  if (!run.data || !messages.data || !detail.data) {
    return <SkeletonRows rows={6} label="Loading the run" />;
  }
  const revealing = reveal.call !== undefined || reveal.seq !== undefined;

  return (
    <>
      <DetailHeader
        title={title ?? runKindLabel[run.data.kind]}
        meta={
          <span className="flex flex-wrap gap-x-2">
            <span className="font-mono">{runId}</span>
            <span>{runKindLabel[run.data.kind]}</span>
            <span>{relativeTime(run.data.created_at)}</span>
            {notes.map((note) => (
              <span key={note}>{note}</span>
            ))}
          </span>
        }
        actions={
          <>
            {back ? (
              <Button variant="ghost" size="sm" onClick={back.onBack}>
                <Icon icon={ArrowLeft} size={14} />
                {back.label}
              </Button>
            ) : null}
            <Button asChild variant="outline" size="sm">
              <Link
                to="/guilds/$guildId/agents/$agentId"
                params={{ guildId: session.source_guild_id, agentId: agent.id }}
                search={{ run: runId }}
              >
                <Icon icon={ExternalLink} size={14} />
                Open in agent
              </Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                ask({
                  kind: "run",
                  agent_id: agent.id,
                  run_id: runId,
                  ...(reveal.call ? { call_id: reveal.call } : {}),
                  ...(reveal.seq !== undefined ? { seq: reveal.seq } : {}),
                  label: `${agent.name} · ${runKindLabel[run.data.kind]}${revealing ? " · this step" : ""}`,
                })
              }
            >
              <Icon icon={Pin} size={14} />
              Ask the coach
            </Button>
          </>
        }
      />
      {run.data.generating ? (
        <Banner
          tone="info"
          title="This run is generating"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void run.refetch();
                void messages.refetch();
              }}
            >
              Refresh
            </Button>
          }
        >
          Studio shows the steps it has stored so far; the agent view streams it live.
        </Banner>
      ) : null}
      <div className="flex flex-col gap-3">
        <Transcript
          agent={detail.data}
          run={run.data}
          messages={messages.data}
          live={null}
          {...(revealing ? { reveal } : {})}
          onAskCall={(call) =>
            ask({
              kind: "run",
              agent_id: agent.id,
              run_id: runId,
              call_id: call.id,
              ...(call.result ? { seq: call.result.seq } : {}),
              label: `${agent.name} · ${call.info.name}`,
            })
          }
        />
      </div>
    </>
  );
}
