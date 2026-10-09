import { useEffect, useRef, useState } from "react";
import {
  CopyButton,
  Markdown,
  Banner,
  CallBatch,
  GenerationHeader,
  StepRow,
  mutatingKinds,
  ToolCall,
} from "@guildsrun/ui";
import type {
  GenerationStatus,
  GenerationFilter,
  StepOutcome,
  StepSegment,
  ToolCallStatus,
} from "@guildsrun/ui";
import {
  flowStats,
  turnReasoning,
  turnText,
  type FlowCall,
  type FlowSegment,
  type FlowStep,
} from "../runs/runFlowModel";
import {
  formatCost,
  formatDuration,
  formatTokens,
  friendlyToolCall,
  previewText,
  toolOutcome,
} from "../runs/toolFormat";
import { ToolCallDetail } from "./ToolCallDetail";

function numberOf(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** Why a call failed; a call with no result failed too once its run stopped generating. */
function callError(call: FlowCall, generating: boolean): string | null {
  if (call.error) return call.error;
  return call.result || generating ? null : "No result: the run stopped before this call returned.";
}

function callStatus(call: FlowCall, generating: boolean): ToolCallStatus {
  if (callError(call, generating)) return "failed";
  return call.result ? "ok" : "running";
}

function stepOutcome(step: FlowStep, generating: boolean): StepOutcome {
  const statuses = step.calls.map((call) => callStatus(call, generating));
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("running")) return "running";
  return step.calls.some((call) => mutatingKinds.has(call.info.kind)) ? "wrote" : "ok";
}

function callDuration(call: FlowCall): number {
  return numberOf((call.result?.metadata as Record<string, unknown> | undefined)?.duration_ms);
}

function turnMeta(step: FlowStep): Record<string, unknown> {
  return (step.turn?.metadata as Record<string, unknown> | undefined) ?? {};
}

/** A line of markdown as plain text: no heading marks, emphasis or code ticks. */
function plainLine(line: string): string {
  return line.replace(/^\s*#+\s+/, "").replace(/\*\*|__|`/g, "");
}

/** Title and detail for a step's row: the first line of what the model wrote or thought. */
function stepSummary(step: FlowStep): { title: string; detail?: string } {
  const text = step.turn ? turnText(step.turn).trim() || turnReasoning(step.turn).trim() : "";
  if (!text)
    return { title: `${step.calls.length} tool${step.calls.length === 1 ? "" : "s"} requested` };
  const [first = "", ...rest] = text
    .split("\n")
    .map(plainLine)
    .filter((line) => line.trim());
  const detail = previewText(rest.join(" "), 160);
  return detail ? { title: previewText(first, 90), detail } : { title: previewText(first, 90) };
}

/** A step to open and scroll to: a tool call by id, or the step that wrote a message sequence. */
export type RevealStep = { call?: string; seq?: number };

/** Scrolls the nearest scrolling ancestor, and only it, so the node sits in its middle. */
function centerInScroller(node: HTMLElement) {
  let scroller = node.parentElement;
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
    scroller = scroller.parentElement;
  }
  if (!scroller) return;
  const box = scroller.getBoundingClientRect();
  const target = node.getBoundingClientRect();
  scroller.scrollTop += target.top - box.top - (box.height - target.height) / 2;
}

const callKey = (call: FlowCall) => `${call.id}:${call.position}`;

/** The call a reveal names in this flow, or the first call of the step it names. */
function revealedCall(flow: FlowSegment, reveal: RevealStep | undefined): FlowCall | null {
  if (!reveal) return null;
  for (const step of flow.steps) {
    for (const call of step.calls) {
      if (reveal.call !== undefined && call.id === reveal.call) return call;
      if (reveal.seq !== undefined && call.result?.seq === reveal.seq) return call;
    }
    if (reveal.seq !== undefined && step.turn?.seq === reveal.seq) return step.calls[0] ?? null;
  }
  return null;
}

type FlowViewProps = {
  flow: FlowSegment;
  /** The run is generating, so calls without a result are still waiting on it. */
  generating: boolean;
  /** Unfolded when it is running or the latest generation. */
  defaultOpen: boolean;
  /** Opens this flow at that step's call and scrolls to it, when the flow holds it. */
  reveal?: RevealStep;
  /** Pins a call to a question for Studio's coach. */
  onAskCall?: ((call: FlowCall) => void) | undefined;
};

/** What the model reported for a step: which model, why it stopped, tokens, cost, response id. */
function modelFacts(meta: Record<string, unknown>): string[] {
  const usage = (meta.usage as Record<string, unknown> | undefined) ?? {};
  const count = (value: unknown) => Number(value).toLocaleString();
  return [
    typeof meta.model === "string" ? meta.model : "",
    typeof meta.finish_reason === "string" ? `stopped: ${meta.finish_reason}` : "",
    usage.input_tokens !== undefined ? `${count(usage.input_tokens)} in` : "",
    usage.output_tokens !== undefined ? `${count(usage.output_tokens)} out` : "",
    usage.cache_read_tokens ? `${count(usage.cache_read_tokens)} cached` : "",
    typeof meta.cost_usd === "number"
      ? `${formatCost(meta.cost_usd)}${typeof meta.cost_source === "string" ? ` (${meta.cost_source})` : ""}`
      : "",
    typeof meta.response_id === "string" ? meta.response_id : "",
  ].filter(Boolean);
}

/** One generation: its header and strip, then each step with the calls it requested. */
export function FlowView({ flow, generating, defaultOpen, reveal, onAskCall }: FlowViewProps) {
  const [revealed] = useState(() => revealedCall(flow, reveal));
  const [open, setOpen] = useState(defaultOpen || revealed !== null);
  const [filters, setFilters] = useState<GenerationFilter[]>([]);
  const [openCall, setOpenCall] = useState<string | null>(revealed ? callKey(revealed) : null);
  const section = useRef<HTMLElement>(null);
  const stats = flowStats(flow);

  useEffect(() => {
    const node = revealed ? section.current?.querySelector<HTMLElement>("[data-revealed]") : null;
    if (node) centerInScroller(node);
  }, [revealed]);

  const unanswered = generating ? 0 : stats.running;
  const status: GenerationStatus =
    stats.errors + unanswered > 0
      ? { kind: "errors", count: stats.errors + unanswered }
      : stats.running > 0
        ? { kind: "running" }
        : { kind: "completed" };
  const statLabels = [
    { label: `${stats.steps} step${stats.steps === 1 ? "" : "s"}` },
    {
      label: `${stats.calls} call${stats.calls === 1 ? "" : "s"}`,
      ...(stats.kinds ? { title: stats.kinds } : {}),
    },
    {
      label: `${formatDuration(stats.modelMs) || "0ms"} model · ${formatDuration(stats.toolMs) || "0ms"} tools`,
    },
    {
      label: `${formatTokens(stats.inputTokens + stats.outputTokens)} tok`,
      title: `${stats.inputTokens.toLocaleString()} in · ${stats.outputTokens.toLocaleString()} out`,
    },
    ...(stats.costUsd !== null ? [{ label: formatCost(stats.costUsd) }] : []),
  ];
  const strip: StepSegment[] = flow.steps.map((step) => {
    const ms =
      numberOf(turnMeta(step).latency_ms) +
      step.calls.reduce((sum, call) => sum + callDuration(call), 0);
    return {
      weight: Math.max(ms, 1),
      outcome: stepOutcome(step, generating),
      label: `${step.index === null ? "Tool result" : `Step ${step.index}`} · ${formatDuration(ms)}`,
    };
  });

  const dimCall = (call: FlowCall) =>
    (filters.includes("mutations") && !mutatingKinds.has(call.info.kind)) ||
    (filters.includes("errors") && !callError(call, generating));

  const renderCall = (call: FlowCall, index?: number) => {
    const error = callError(call, generating);
    const expanded = openCall === callKey(call);
    return (
      <ToolCall
        key={callKey(call)}
        {...(revealed && callKey(revealed) === callKey(call)
          ? { "data-revealed": "", className: "ring-2 ring-signal" }
          : {})}
        name={call.info.name}
        kind={call.info.kind}
        level={call.info.level}
        server={
          call.info.server && !call.info.name.startsWith(`${call.info.server}_`)
            ? call.info.server
            : null
        }
        {...(index !== undefined ? { index } : {})}
        hint={[friendlyToolCall(call.call), toolOutcome(call.result?.metadata)]
          .filter(Boolean)
          .join(" · ")}
        status={callStatus(call, generating)}
        {...(error ? { error: previewText(error, 160) } : {})}
        duration={formatDuration(callDuration(call))}
        dimmed={dimCall(call)}
        expanded={expanded}
        detail={
          expanded ? (
            <ToolCallDetail call={call} generating={generating} onAsk={onAskCall} />
          ) : undefined
        }
        onClick={() => setOpenCall((current) => (current === callKey(call) ? null : callKey(call)))}
      />
    );
  };

  return (
    <section
      ref={section}
      className="flex flex-col gap-2 rounded-xl bg-surface p-2"
      aria-label={flow.generation ? `Generation ${flow.generation}` : "Tool trace"}
    >
      <GenerationHeader
        title={flow.generation ? `Generation ${flow.generation}` : "Tool trace"}
        stats={statLabels}
        status={status}
        steps={strip}
        filters={filters}
        onFiltersChange={setFilters}
        open={open}
        onOpenChange={setOpen}
      />
      {open ? (
        <div className="flex flex-col gap-1.5">
          {flow.steps.map((step, stepIndex) => {
            const meta = turnMeta(step);
            const usage = (meta.usage as Record<string, unknown> | undefined) ?? {};
            const tokens = numberOf(usage.input_tokens) + numberOf(usage.output_tokens);
            const summary = stepSummary(step);
            const reasoning = step.turn ? turnReasoning(step.turn) : "";
            const text = step.turn ? turnText(step.turn) : "";
            const failed = step.calls.filter((call) => callError(call, generating)).length;
            return (
              <StepRow
                key={`${step.index ?? "result"}:${stepIndex}`}
                step={step.index}
                outcome={stepOutcome(step, generating)}
                title={summary.title}
                {...(summary.detail ? { detail: summary.detail } : {})}
                duration={formatDuration(numberOf(meta.latency_ms))}
                {...(tokens ? { tokens: `${formatTokens(tokens)} tok` } : {})}
                hitMaxTokens={meta.finish_reason === "length"}
                dimmed={step.calls.length > 0 && step.calls.every(dimCall)}
                defaultOpen={
                  stepIndex === flow.steps.length - 1 ||
                  failed > 0 ||
                  (revealed !== null && step.calls.includes(revealed))
                }
              >
                <div className="flex flex-col gap-2">
                  {step.calls.length > 1 ? (
                    <CallBatch
                      count={step.calls.length}
                      duration={formatDuration(
                        step.calls.reduce((sum, call) => sum + callDuration(call), 0),
                      )}
                      failed={failed}
                    >
                      {step.calls.map((call) => renderCall(call, call.position))}
                    </CallBatch>
                  ) : (
                    step.calls.map((call) => renderCall(call))
                  )}
                  {reasoning ? (
                    <details className="rounded-lg bg-paper px-3 py-2 text-sm">
                      <summary className="flex cursor-pointer items-center font-semibold text-fg-2">
                        <span className="flex-1">Reasoning</span>
                        <CopyButton text={reasoning} what="reasoning" size={24} />
                      </summary>
                      <p className="mt-2 whitespace-pre-wrap text-fg-2">{reasoning}</p>
                    </details>
                  ) : null}
                  {text.trim() ? (
                    <div className="relative rounded-lg bg-paper px-3 py-2 pr-9">
                      <Markdown density="compact">{text}</Markdown>
                      <CopyButton
                        text={text}
                        what="message"
                        size={24}
                        className="absolute top-1.5 right-1.5"
                      />
                    </div>
                  ) : null}
                  {modelFacts(meta).length ? (
                    <p className="font-mono text-2xs text-muted wrap-anywhere">
                      {modelFacts(meta).join(" · ")}
                    </p>
                  ) : null}
                </div>
              </StepRow>
            );
          })}
          {flow.errors.map((error, index) => (
            <Banner
              key={`${String(error.operation)}:${index}`}
              tone="error"
              title={String(error.message ?? "The generation failed")}
              meta={String(error.operation ?? "")}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
