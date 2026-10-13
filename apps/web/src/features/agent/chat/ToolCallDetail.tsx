import { Pin } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useTaskDiff } from "../../../api/queries";
import type { CallProgress } from "../../../api/toolProgress";
import { Button, CopyButton, JsonTree, Segmented, Banner, Icon, cn } from "@guildsrun/ui";
import { harnessLabel } from "../harness";
import type { FlowCall } from "../runs/runFlowModel";
import {
  codeTaskChanges,
  codeTaskStatus,
  formatDuration,
  formatReturnedData,
  formatToolArgs,
  stripRemainingToolCalls,
} from "../runs/toolFormat";
import { DiffView } from "./ChangesPanel";

type View = "arguments" | "result" | "metadata" | "diff";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

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

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function shortSha(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 7) : "";
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

/**
 * One tool call opened up: what the agent asked for, what came back (or, while it runs, what it
 * has reported), how it ran, and for a code task the diff it made.
 */
export function ToolCallDetail({
  call,
  generating,
  onAsk,
  runId,
  progress,
}: {
  call: FlowCall;
  generating: boolean;
  /** Pins this call to a question for Studio's coach. */
  onAsk?: ((call: FlowCall) => void) | undefined;
  /** The run the call belongs to, where its task diff is fetched from. */
  runId?: string;
  /** What the call has reported while it runs. */
  progress?: CallProgress;
}) {
  const [view, setView] = useState<View>(
    call.error ? "result" : progress?.lines.length ? "result" : "arguments",
  );
  const fn = record(record(call.call).function);
  const args = formatToolArgs(fn.arguments);
  const meta = record(call.result?.metadata);
  const content = call.result ? stripRemainingToolCalls(record(call.result.payload).content) : null;
  const returned = formatReturnedData(content);
  const task = call.info.name === "code_task";
  const hasDiff = task && Boolean(runId) && typeof meta.end_sha === "string" && meta.end_sha !== "";
  const diff = useTaskDiff(runId ?? "", hasDiff && view === "diff" ? call.id : null);
  const facts: [string, string][] = [
    ["Call", call.id || "—"],
    ["Tool", call.info.name],
    ["Status", task ? codeTaskStatus(meta.status) : ""],
    ["Harness", task && meta.harness ? harnessLabel(meta.harness) : ""],
    ["Repository", task ? text(meta.repository) : ""],
    ["Session", task ? text(meta.session_id) || (progress?.session_id ?? "") : ""],
    ["Changes", task ? codeTaskChanges(meta) : ""],
    [
      "Checkpoints",
      task && meta.start_sha && meta.end_sha
        ? `${shortSha(meta.start_sha)} → ${shortSha(meta.end_sha)}`
        : "",
    ],
    ["Duration", formatDuration(Number(meta.duration_ms))],
    ["Output filter", String(meta.output_filter ?? "")],
    [
      "Exit code",
      meta.exit_code === undefined || meta.exit_code === null ? "" : String(meta.exit_code),
    ],
    [task ? "Harness log" : "Full output", text(meta.log_path)],
    ["Working directory", typeof meta.cwd === "string" ? meta.cwd : ""],
    ["File", typeof meta.path === "string" ? meta.path : ""],
    ["Lines", Array.isArray(meta.range) ? `${String(meta.range[0])}–${String(meta.range[1])}` : ""],
    ["Same as step", typeof meta.repeat_of === "number" ? String(meta.repeat_of) : ""],
    [
      "Bytes",
      meta.original_bytes === undefined
        ? ""
        : `${String(meta.original_bytes)} → ${String(meta.stored_bytes ?? "")} stored`,
    ],
    [
      "Tool calls left",
      meta.remaining_tool_calls === undefined ? "" : String(meta.remaining_tool_calls),
    ],
    ["Committed", call.result?.created_at ?? ""],
  ];

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          size="sm"
          label={`${call.info.name} details`}
          value={view}
          onValueChange={setView}
          options={[
            { value: "arguments", label: "Arguments" },
            { value: "result", label: "Result" },
            { value: "metadata", label: "Metadata" },
            ...(hasDiff ? [{ value: "diff" as const, label: "Diff" }] : []),
          ]}
        />
        {onAsk ? (
          <Button variant="outline" size="xs" className="ml-auto" onClick={() => onAsk(call)}>
            <Icon icon={Pin} size={14} />
            Ask the coach
          </Button>
        ) : null}
      </div>
      {view === "arguments" ? (
        args.isEmpty ? (
          <p className="text-sm text-muted">{args.text}</p>
        ) : (
          <Payload text={args.text} json={args.parsed} what="arguments" />
        )
      ) : view === "result" ? (
        <div className="flex flex-col gap-2">
          {call.error ? <Banner tone="error" title="The tool failed" meta={call.error} /> : null}
          {meta.truncated === true ? (
            <p className="text-xs text-muted">
              Truncated by the output pipeline: {String(meta.original_bytes)} bytes →{" "}
              {String(meta.stored_bytes)} stored.
            </p>
          ) : null}
          {call.result ? (
            <Payload
              text={returned.text}
              json={returned.isJson ? returned.raw : null}
              what="result"
            />
          ) : generating && progress?.lines.length ? (
            <ProgressLines lines={progress.lines} />
          ) : (
            <p className="text-sm text-muted">
              {generating
                ? "Waiting for tool output…"
                : "No result: the run stopped before this call returned."}
            </p>
          )}
        </div>
      ) : view === "diff" ? (
        <DiffView diff={diff} className="bg-surface" />
      ) : (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          {facts
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted">{label}</dt>
                <dd className="min-w-0 truncate font-mono text-xs leading-5">{value}</dd>
              </div>
            ))}
        </dl>
      )}
    </div>
  );
}
