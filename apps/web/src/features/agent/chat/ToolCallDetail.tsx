import { Pin } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useTaskDiff, useTaskLog } from "../../../api/queries";
import type { CallProgress } from "../../../api/toolProgress";
import {
  Button,
  CopyButton,
  JsonTree,
  Markdown,
  Segmented,
  Banner,
  Icon,
  ToolCallTags,
  cn,
} from "@guildsrun/ui";
import type { FlowCall } from "../runs/runFlowModel";
import type { RunMessage } from "../runs/toolFormat";
import {
  callArguments,
  callMetadata,
  hasTaskDiff,
  hasTaskLog,
  openingView,
  returnedData,
  toolCallFacts,
  type CallFact,
  type DetailView,
} from "./callDetail";
import { DiffView } from "./ChangesPanel";

/** The run a tool call belongs to, as its detail needs it. */
type CallRun = {
  /** The run's id, where a code task's diff is fetched from. */
  id?: string;
  generating: boolean;
  /** What the call has reported while it runs. */
  progress?: CallProgress;
};

function Code({ children }: { children: string }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-md bg-surface p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg">
      {children}
    </pre>
  );
}

/** The lines a running call has reported, latest last, kept scrolled to the latest. */
export function ProgressLines({
  lines,
  className,
}: {
  lines: readonly string[];
  className?: string;
}) {
  const box = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <pre
      ref={box}
      aria-label="Progress"
      className={cn(
        "max-h-96 overflow-auto rounded-md bg-surface p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg-2",
        className,
      )}
    >
      {lines.join("\n")}
    </pre>
  );
}

const treeViews = [
  { value: "tree", label: "Tree" },
  { value: "raw", label: "Raw" },
];

const markdownViews = [
  { value: "rendered", label: "Markdown" },
  { value: "raw", label: "Raw" },
];

/**
 * A call's arguments or result: JSON as a tree, or as raw text; anything else as text, or as
 * rendered Markdown when `markdown` is set.
 */
function Payload({
  text,
  json,
  what,
  markdown = false,
}: {
  text: string;
  json: unknown;
  what: string;
  markdown?: boolean;
}) {
  const structured = json !== null && typeof json === "object";
  const views = structured ? treeViews : markdown ? markdownViews : null;
  const [raw, setRaw] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {views ? (
          <Segmented
            size="sm"
            label={`${what} as`}
            value={raw ? "raw" : structured ? "tree" : "rendered"}
            onValueChange={(value) => setRaw(value === "raw")}
            options={views}
          />
        ) : null}
        <CopyButton text={text} what={what} className="ml-auto" />
      </div>
      {raw || !views ? (
        <Code>{text}</Code>
      ) : structured ? (
        <div className="max-h-96 overflow-auto rounded-md bg-surface p-3">
          <JsonTree value={json} />
        </div>
      ) : (
        <div className="max-h-96 overflow-auto rounded-md bg-surface p-3">
          <Markdown density="compact">{text}</Markdown>
        </div>
      )}
    </div>
  );
}

function ArgumentsPane({ call }: { call: FlowCall }) {
  const args = callArguments(call);
  return args.isEmpty ? (
    <p className="text-sm text-muted">{args.text}</p>
  ) : (
    <Payload text={args.text} json={args.parsed} what="arguments" />
  );
}

function ReturnedPayload({ result }: { result: RunMessage }) {
  const returned = returnedData(result);
  return (
    <Payload
      text={returned.text}
      json={returned.isJson ? returned.raw : null}
      what="result"
      markdown={!returned.isEmpty}
    />
  );
}

/** A running call's result: the lines it has reported, or that none came yet. */
function RunningResult({ lines }: { lines: readonly string[] }) {
  return lines.length ? (
    <ProgressLines lines={lines} />
  ) : (
    <p className="text-sm text-muted">Waiting for tool output…</p>
  );
}

/** What came back; while the call runs, what it has reported. */
function ResultBody({ call, run }: { call: FlowCall; run: CallRun }) {
  if (call.result) return <ReturnedPayload result={call.result} />;
  if (run.generating) return <RunningResult lines={run.progress?.lines ?? []} />;
  return (
    <p className="text-sm text-muted">No result: the run stopped before this call returned.</p>
  );
}

/** The result, under the error the tool failed with and how the output pipeline cut it. */
function ResultPane({ call, run }: { call: FlowCall; run: CallRun }) {
  const meta = callMetadata(call);
  return (
    <div className="flex flex-col gap-2">
      {call.error ? <Banner tone="error" title="The tool failed" meta={call.error} /> : null}
      {meta.truncated === true ? (
        <p className="text-xs text-muted">
          Truncated by the output pipeline: {String(meta.original_bytes)} bytes →{" "}
          {String(meta.stored_bytes)} stored.
        </p>
      ) : null}
      <ResultBody call={call} run={run} />
    </div>
  );
}

function TaskDiff({ runId, callId }: { runId: string; callId: string }) {
  return <DiffView diff={useTaskDiff(runId, callId)} className="bg-surface" />;
}

/** How a code task's log reads: its steps, one line each, or its raw JSONL events. */
type LogView = "steps" | "json";

const logViews: { value: LogView; label: string }[] = [
  { value: "steps", label: "Steps" },
  { value: "json", label: "JSON" },
];

/** A code task's kept harness log, read from the agent's machine once this view opens. */
function TaskLog({ runId, callId }: { runId: string; callId: string }) {
  const log = useTaskLog(runId, callId);
  const [view, setView] = useState<LogView>("steps");
  if (log.isError) {
    return <Banner tone="error" title="Couldn't load the harness log" meta={log.error.message} />;
  }
  if (!log.data) {
    return <p className="text-xs text-muted">Loading the log from the agent&apos;s machine…</p>;
  }
  const { lines, raw } = log.data;
  const cut =
    view === "steps"
      ? log.data.lines_truncated && "Only its first 2000 steps are shown."
      : log.data.raw_truncated &&
        `Only its first 256 KiB of ${Math.ceil(log.data.bytes / 1024)} KiB are shown.`;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Segmented
          size="sm"
          label="Log as"
          value={view}
          onValueChange={setView}
          options={logViews}
        />
        <span className="type-meta text-muted">
          {log.data.events} event{log.data.events === 1 ? "" : "s"}
        </span>
        <CopyButton
          text={view === "steps" ? lines.join("\n") : raw}
          what="log"
          className="ml-auto"
        />
      </div>
      {view === "steps" ? (
        lines.length ? (
          <ProgressLines lines={lines} />
        ) : (
          <p className="text-sm text-muted">The log holds no steps.</p>
        )
      ) : (
        <Code>{raw}</Code>
      )}
      {cut ? <p className="text-xs text-muted">{cut}</p> : null}
    </div>
  );
}

function MetadataPane({
  facts,
  onOpenLog,
}: {
  facts: readonly CallFact[];
  /** Opens the call's harness log; its path in the list then leads there. */
  onOpenLog?: (() => void) | undefined;
}) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      {facts.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="min-w-0 truncate font-mono text-xs leading-5">
            {label === "Harness log" && onOpenLog ? (
              <button
                type="button"
                onClick={onOpenLog}
                title="Open the harness log"
                className="max-w-full cursor-pointer truncate rounded-sm text-left text-signal-t underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                {value}
              </button>
            ) : (
              value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function DetailPane({
  view,
  call,
  run,
  onView,
}: {
  view: DetailView;
  call: FlowCall;
  run: CallRun;
  onView: (view: DetailView) => void;
}) {
  if (view === "arguments") return <ArgumentsPane call={call} />;
  if (view === "result") return <ResultPane call={call} run={run} />;
  if (view === "diff") return <TaskDiff runId={run.id ?? ""} callId={call.id} />;
  if (view === "log") return <TaskLog runId={run.id ?? ""} callId={call.id} />;
  return (
    <MetadataPane
      facts={toolCallFacts(call, run.progress?.session_id ?? null)}
      onOpenLog={hasTaskLog(call, run.id) ? () => onView("log") : undefined}
    />
  );
}

const callViews: { value: DetailView; label: string }[] = [
  { value: "arguments", label: "Arguments" },
  { value: "result", label: "Result" },
  { value: "metadata", label: "Metadata" },
];

const taskDiffView: { value: DetailView; label: string } = { value: "diff", label: "Diff" };

const taskLogView: { value: DetailView; label: string } = { value: "log", label: "Log" };

/** The views a call opens on: a code task's diff and log once it has them. */
function detailViews(call: FlowCall, runId: string | undefined) {
  return [
    ...callViews,
    ...(hasTaskDiff(call, runId) ? [taskDiffView] : []),
    ...(hasTaskLog(call, runId) ? [taskLogView] : []),
  ];
}

/**
 * One tool call opened up: what the agent asked for, what came back (or, while it runs, what it
 * has reported), how it ran, and for a code task the diff it made.
 */
export function ToolCallDetail({
  call,
  run,
  onAsk,
}: {
  call: FlowCall;
  run: CallRun;
  /** Pins this call to a question for Studio's coach. */
  onAsk?: ((call: FlowCall) => void) | undefined;
}) {
  const [view, setView] = useState<DetailView>(openingView(call, run.progress));
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          size="sm"
          label={`${call.info.name} details`}
          value={view}
          onValueChange={setView}
          options={detailViews(call, run.id)}
        />
        <span className="ml-auto">
          <ToolCallTags kind={call.info.kind} level={call.info.level} />
        </span>
        {onAsk ? (
          <Button variant="outline" size="xs" onClick={() => onAsk(call)}>
            <Icon icon={Pin} size={14} />
            Ask the coach
          </Button>
        ) : null}
      </div>
      <DetailPane view={view} call={call} run={run} onView={setView} />
    </div>
  );
}
