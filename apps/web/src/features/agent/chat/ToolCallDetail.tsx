import { Pin } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useTaskDiff } from "../../../api/queries";
import type { CallProgress } from "../../../api/toolProgress";
import { Button, CopyButton, JsonTree, Segmented, Banner, Icon, cn } from "@guildsrun/ui";
import type { FlowCall } from "../runs/runFlowModel";
import type { RunMessage } from "../runs/toolFormat";
import {
  callArguments,
  callMetadata,
  hasTaskDiff,
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

/** A call's arguments or result: JSON as a tree, or as raw text; anything else as text. */
function Payload({ text, json, what }: { text: string; json: unknown; what: string }) {
  const structured = json !== null && typeof json === "object";
  const [raw, setRaw] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {structured ? (
          <Segmented
            size="sm"
            label={`${what} as`}
            value={raw ? "raw" : "tree"}
            onValueChange={(value) => setRaw(value === "raw")}
            options={[
              { value: "tree", label: "Tree" },
              { value: "raw", label: "Raw" },
            ]}
          />
        ) : null}
        <CopyButton text={text} what={what} className="ml-auto" />
      </div>
      {structured && !raw ? (
        <div className="max-h-96 overflow-auto rounded-md bg-surface p-3">
          <JsonTree value={json} />
        </div>
      ) : (
        <Code>{text}</Code>
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
    <Payload text={returned.text} json={returned.isJson ? returned.raw : null} what="result" />
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

function MetadataPane({ facts }: { facts: readonly CallFact[] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      {facts.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="min-w-0 truncate font-mono text-xs leading-5">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DetailPane({ view, call, run }: { view: DetailView; call: FlowCall; run: CallRun }) {
  if (view === "arguments") return <ArgumentsPane call={call} />;
  if (view === "result") return <ResultPane call={call} run={run} />;
  if (view === "diff") return <TaskDiff runId={run.id ?? ""} callId={call.id} />;
  return <MetadataPane facts={toolCallFacts(call, run.progress?.session_id ?? null)} />;
}

const callViews: { value: DetailView; label: string }[] = [
  { value: "arguments", label: "Arguments" },
  { value: "result", label: "Result" },
  { value: "metadata", label: "Metadata" },
];

const taskDiffView: { value: DetailView; label: string } = { value: "diff", label: "Diff" };

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
          options={hasTaskDiff(call, run.id) ? [...callViews, taskDiffView] : callViews}
        />
        {onAsk ? (
          <Button variant="outline" size="xs" className="ml-auto" onClick={() => onAsk(call)}>
            <Icon icon={Pin} size={14} />
            Ask the coach
          </Button>
        ) : null}
      </div>
      <DetailPane view={view} call={call} run={run} />
    </div>
  );
}
