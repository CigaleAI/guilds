import { Pin } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
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
import type { StepMessage } from "../../../api/types/runs";
import type { FlowCall } from "../runs/runFlowModel";
import type { JsonTreeValue } from "../runs/toolFormat";
import {
  callArguments,
  callMetadata,
  openingView,
  returnedData,
  toolCallFacts,
  type CallFact,
  type DetailView,
} from "./callDetail";

/** The run a tool call belongs to, as its detail needs it. */
type CallRun = {
  generating: boolean;
  /** What the call has reported while it runs. */
  progress?: CallProgress;
};

type CodeProps = { children: string };

function Code({ children }: CodeProps) {
  return (
    <pre className="max-h-96 overflow-auto rounded-md bg-surface p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg">
      {children}
    </pre>
  );
}

type ProgressLinesProps = {
  lines: readonly string[];
  className?: string;
};

/** The lines a running call has reported, latest last, kept scrolled to the latest. */
export function ProgressLines({ lines, className }: ProgressLinesProps) {
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

type PayloadProps = {
  text: string;
  /** The body as JSON, when it is an object or an array; null for text. */
  json: JsonTreeValue | null;
  what: string;
  markdown?: boolean;
};

/**
 * A call's arguments or result: JSON as a tree, or as raw text; anything else as text, or as
 * rendered Markdown when `markdown` is set.
 */
function Payload({ text, json, what, markdown = false }: PayloadProps) {
  const structured = json !== null;
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

type ArgumentsPaneProps = { call: FlowCall };

function ArgumentsPane({ call }: ArgumentsPaneProps) {
  const args = callArguments(call);
  return args.isEmpty ? (
    <p className="text-sm text-muted">{args.text}</p>
  ) : (
    <Payload text={args.text} json={args.parsed} what="arguments" />
  );
}

type ReturnedPayloadProps = { result: StepMessage };

function ReturnedPayload({ result }: ReturnedPayloadProps) {
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

type RunningResultProps = { lines: readonly string[] };

/** A running call's result: the lines it has reported, or that none came yet. */
function RunningResult({ lines }: RunningResultProps) {
  return lines.length ? (
    <ProgressLines lines={lines} />
  ) : (
    <p className="text-sm text-muted">Waiting for tool output…</p>
  );
}

type ResultBodyProps = { call: FlowCall; run: CallRun };

/** What came back; while the call runs, what it has reported. */
function ResultBody({ call, run }: ResultBodyProps) {
  if (call.result) return <ReturnedPayload result={call.result} />;
  if (run.generating) return <RunningResult lines={run.progress?.lines ?? []} />;
  return (
    <p className="text-sm text-muted">No result: the run stopped before this call returned.</p>
  );
}

type ResultPaneProps = { call: FlowCall; run: CallRun };

/** The result, under the error the tool failed with and how the output pipeline cut it. */
function ResultPane({ call, run }: ResultPaneProps) {
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

type MetadataPaneProps = { facts: readonly CallFact[] };

function MetadataPane({ facts }: MetadataPaneProps) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      {facts.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="min-w-0 truncate font-mono text-xs leading-5">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

type DetailPaneProps = { view: DetailView; call: FlowCall; run: CallRun };

function DetailPane({ view, call, run }: DetailPaneProps) {
  if (view === "arguments") return <ArgumentsPane call={call} />;
  if (view === "result") return <ResultPane call={call} run={run} />;
  return <MetadataPane facts={toolCallFacts(call)} />;
}

/** A view a call opens on, as its switch offers it. */
type DetailViewOption = { value: DetailView; label: string };

const callViews: DetailViewOption[] = [
  { value: "arguments", label: "Arguments" },
  { value: "result", label: "Result" },
  { value: "metadata", label: "Metadata" },
];

type ToolCallDetailProps = {
  call: FlowCall;
  run: CallRun;
  /** Pins this call to a question for Studio's coach. */
  onAsk?: ((call: FlowCall) => void) | undefined;
};

/**
 * One tool call opened up: what the agent asked for, what came back (or, while it runs, what it
 * has reported), and how it ran.
 */
export function ToolCallDetail({ call, run, onAsk }: ToolCallDetailProps) {
  const [view, setView] = useState<DetailView>(openingView(call, run.progress));
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          size="sm"
          label={`${call.info.name} details`}
          value={view}
          onValueChange={setView}
          options={callViews}
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
      <DetailPane view={view} call={call} run={run} />
    </div>
  );
}
