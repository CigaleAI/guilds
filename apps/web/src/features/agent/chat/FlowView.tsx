import { createLink } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Button,
  CopyButton,
  Markdown,
  Banner,
  GenerationHeader,
  StepRow,
  ToolCall,
  ToolCallLink,
  cn,
  mutatingKinds,
} from "@guildsrun/ui";
import type {
  GenerationStatus,
  GenerationFilter,
  StepFact,
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
  messageContentText,
  parseToolArgs,
  previewText,
  toolOutcome,
} from "../runs/toolFormat";
import { kindBreakdown, levelFromDisplayPath } from "../runs/toolKinds";
import type { ToolProgress } from "../../../api/toolProgress";
import { ProgressLines, ToolCallDetail } from "./ToolCallDetail";

const CallLink = createLink(ToolCallLink);

/** How many of a running call's latest progress lines show under it while it is closed. */
const PROGRESS_TAIL = 6;

/** Reasoning longer than this, or taller than six lines, starts clamped. */
const REASONING_CLAMP = 480;

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

/** Reasoning often opens on a fragment ("Hmm." or "Wait…"), so a title shorter than this takes the next sentence too. */
const TITLE_MIN = 40;

/** A step's lead: the opening sentence of what the model wrote or thought, else the tools it called. */
function stepTitle(step: FlowStep): string {
  const text = step.turn ? turnText(step.turn).trim() || turnReasoning(step.turn).trim() : "";
  if (!text) return step.calls.map((call) => call.info.name).join(", ");
  const line =
    text
      .split("\n")
      .map(plainLine)
      .find((item) => item.trim()) ?? "";
  let title = "";
  for (const sentence of line.split(/(?<=[.!?])\s+/)) {
    title = title ? `${title} ${sentence}` : sentence;
    if (title.length >= TITLE_MIN) break;
  }
  return previewText(title, 120);
}

/** A step's figures: calls, model time, tokens and cost, each with its breakdown on hover. */
function stepFacts(step: FlowStep, meta: Record<string, unknown>): StepFact[] {
  const usage = (meta.usage as Record<string, unknown> | undefined) ?? {};
  const count = (value: unknown) => numberOf(value).toLocaleString();
  const calls = step.calls.length;
  const modelMs = numberOf(meta.latency_ms);
  const toolMs = step.calls.reduce((sum, call) => sum + callDuration(call), 0);
  const tokens = numberOf(usage.input_tokens) + numberOf(usage.output_tokens);
  const facts: StepFact[] = [];
  if (calls) {
    facts.push({
      label: `${calls} call${calls === 1 ? "" : "s"}`,
      title: kindBreakdown(step.calls.map((call) => call.info)),
    });
  }
  if (modelMs) {
    facts.push({
      label: formatDuration(modelMs),
      title: `${formatDuration(modelMs)} model · ${formatDuration(toolMs) || "0ms"} tools`,
    });
  }
  if (tokens) {
    facts.push({
      label: `${formatTokens(tokens)} tok`,
      title: [
        `${count(usage.input_tokens)} in`,
        `${count(usage.output_tokens)} out`,
        usage.cache_read_tokens ? `${count(usage.cache_read_tokens)} cached` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }
  if (typeof meta.cost_usd === "number") {
    facts.push({
      label: formatCost(meta.cost_usd),
      ...(typeof meta.cost_source === "string"
        ? { title: `Cost source: ${meta.cost_source}` }
        : {}),
    });
  }
  return facts;
}

/** The tag a finish reason earns: the token budget, or any reason other than stopping or calling tools. */
function stopTag(reason: unknown): string | undefined {
  if (reason === "length") return "max tokens";
  return typeof reason === "string" && reason && reason !== "tool_calls" && reason !== "stop"
    ? `stopped: ${reason}`
    : undefined;
}

/** The agent inspector that links to what a call touched open in. */
export type Inspector = { guildId: string; agentId: string };

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

/** A chip leading to the note, memory or script a mutation wrote; null when the app has nowhere to show what it touched. */
function callLink(call: FlowCall, inspector: Inspector): ReactNode {
  if (!mutatingKinds.has(call.info.kind)) return null;
  switch (call.info.name) {
    case "memory_write":
      return (
        <CallLink to="/guilds/$guildId/agents/$agentId/state/memory" params={inspector}>
          memory.md
        </CallLink>
      );
    case "script_create": {
      const name = parseToolArgs(call.call?.function?.arguments).name;
      return name ? (
        <CallLink to="/guilds/$guildId/agents/$agentId/state/scripts" params={inspector}>
          {String(name)}
        </CallLink>
      ) : null;
    }
    case "note_write": {
      const path = firstLine(messageContentText(call.result?.payload));
      if (!levelFromDisplayPath(path)) return null;
      return (
        <CallLink
          to="/guilds/$guildId/agents/$agentId/state/notes"
          params={inspector}
          search={{ path }}
        >
          {path.split("/").pop()}
        </CallLink>
      );
    }
    default:
      return null;
  }
}

/** The model's reasoning before its calls, clamped when long, with a copy button. */
function StepReasoning({ text }: { text: string }) {
  const long = text.length > REASONING_CLAMP || text.split("\n").length > 6;
  const [all, setAll] = useState(false);
  return (
    <div className="flex flex-col items-start gap-1 border-l-2 border-line py-0.5 pl-3">
      <div className="relative w-full pr-9">
        <p className={cn("text-sm whitespace-pre-wrap text-fg-2", long && !all && "line-clamp-6")}>
          {text}
        </p>
        <CopyButton text={text} what="reasoning" size={24} className="absolute top-0 right-0" />
      </div>
      {long ? (
        <Button variant="ghost" size="xs" onClick={() => setAll(!all)}>
          {all ? "Show less" : "Show all"}
        </Button>
      ) : null}
    </div>
  );
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
  /** The run the flow belongs to; without it, calls offer nothing fetched from the run. */
  runId?: string;
  /** The run is generating, so calls without a result are still waiting on it. */
  generating: boolean;
  /** Unfolded when it is running or the latest generation. */
  defaultOpen: boolean;
  /** Opens this flow at that step's call and scrolls to it, when the flow holds it. */
  reveal?: RevealStep;
  /** Where chips on mutations lead; without it, calls carry no links. */
  inspector?: Inspector;
  /** Pins a call to a question for Studio's coach. */
  onAskCall?: ((call: FlowCall) => void) | undefined;
  /** What running calls have reported so far, by call id. */
  progress?: ToolProgress;
};

/** One generation: its header and strip, then each step with its reasoning and the calls it requested. */
export function FlowView({
  flow,
  runId,
  generating,
  defaultOpen,
  reveal,
  inspector,
  onAskCall,
  progress,
}: FlowViewProps) {
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

  const calls = flow.steps.flatMap((step) => step.calls);
  const failedCalls = calls.filter((call) => callError(call, generating)).length;
  const mutations = calls.filter((call) => mutatingKinds.has(call.info.kind)).length;
  const model = flow.steps
    .map((step) => turnMeta(step).model)
    .find((value): value is string => typeof value === "string");
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
    const status = callStatus(call, generating);
    const reported = status === "running" ? progress?.[call.id] : undefined;
    const card = (
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
        status={status}
        {...(error ? { error: previewText(error, 160) } : {})}
        duration={formatDuration(callDuration(call))}
        dimmed={dimCall(call)}
        expanded={expanded}
        detail={
          expanded ? (
            <ToolCallDetail
              call={call}
              run={{
                generating,
                ...(runId ? { id: runId } : {}),
                ...(reported ? { progress: reported } : {}),
              }}
              onAsk={onAskCall}
            />
          ) : undefined
        }
        link={inspector ? callLink(call, inspector) : null}
        onClick={() => setOpenCall((current) => (current === callKey(call) ? null : callKey(call)))}
      />
    );
    if (expanded || !reported?.lines.length) return card;
    return (
      <div key={callKey(call)} className="flex flex-col gap-1">
        {card}
        <ProgressLines lines={reported.lines.slice(-PROGRESS_TAIL)} className="bg-paper" />
      </div>
    );
  };

  return (
    <section
      ref={section}
      className="flex flex-col gap-2 rounded-xl bg-surface p-2"
      aria-label={flow.generation ? `Generation ${flow.generation}` : "Tool trace"}
    >
      <GenerationHeader
        title={
          <span title={model ? `Model: ${model}` : undefined}>
            {flow.generation ? `Generation ${flow.generation}` : "Tool trace"}
          </span>
        }
        stats={statLabels}
        status={status}
        mutations={mutations}
        failed={failedCalls}
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
            const reasoning = step.turn ? turnReasoning(step.turn) : "";
            const text = step.turn ? turnText(step.turn) : "";
            const failed = step.calls.filter((call) => callError(call, generating)).length;
            const stop = stopTag(meta.finish_reason);
            return (
              <StepRow
                key={`${step.index ?? "result"}:${stepIndex}`}
                outcome={stepOutcome(step, generating)}
                failed={failed}
                title={stepTitle(step)}
                facts={stepFacts(step, meta)}
                {...(stop ? { stop } : {})}
                dimmed={step.calls.length > 0 && step.calls.every(dimCall)}
                filters={filters}
                onFiltersChange={setFilters}
                defaultOpen={
                  stepIndex === flow.steps.length - 1 ||
                  failed > 0 ||
                  (revealed !== null && step.calls.includes(revealed))
                }
              >
                <div className="flex flex-col gap-2">
                  {reasoning ? <StepReasoning text={reasoning} /> : null}
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
                  {step.calls.length ? (
                    <div className="flex flex-col gap-1.5">
                      {step.calls.map((call) =>
                        renderCall(call, step.calls.length > 1 ? call.position : undefined),
                      )}
                    </div>
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
