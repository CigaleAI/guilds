import { createLink } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CopyButton,
  Markdown,
  Banner,
  FlowBatch,
  FlowEntry,
  FlowHarnessTask,
  FlowStepBlock,
  FlowStepRun,
  FlowThought,
  FlowTimeline,
  GenerationHeader,
  ToolCall,
  ToolCallLink,
  cn,
} from "@guildsrun/ui";
import type {
  FlowCallTone,
  FlowStepCues,
  GenerationStat,
  GenerationStatus,
  GenerationFilter,
  StepFact,
  ToolCallEffect,
  ToolCallStatus,
} from "@guildsrun/ui";
import {
  flowStats,
  turnReasoning,
  turnText,
  turnUsage,
  type FlowCall,
  type FlowSegment,
  type FlowStep,
} from "../runs/runFlowModel";
import {
  codeTaskChanges,
  codeTaskStatus,
  formatCost,
  formatDuration,
  formatTokens,
  friendlyToolCall,
  messageContentText,
  parseToolArgs,
  previewText,
  summarizeCalls,
  toolOutcome,
} from "../runs/toolFormat";
import {
  TOOL_KINDS,
  isMutation,
  isScriptRun,
  kindLabel,
  levelFromDisplayPath,
} from "../runs/toolKinds";
import type { ToolProgress } from "../../../api/toolProgress";
import type { Harness } from "../../../api/types/agents";
import { harnessLabels } from "../harness";
import { HarnessLogo } from "../HarnessLogo";
import { callHarness, callMetadata } from "./callDetail";
import { ProgressLines, ToolCallDetail } from "./ToolCallDetail";

const CallLink = createLink(ToolCallLink);

/** How many of a running call's latest progress lines show under it while it is closed. */
const PROGRESS_TAIL = 6;

/** Reasoning longer than this, or of more than one line, unfolds onto the rest with **more**. */
const THOUGHT_LINE = 120;

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

/** What a call did beyond reading: wrote tracked state, or ran a script. */
function callEffect(call: FlowCall): ToolCallEffect | null {
  if (isMutation(call.info)) return "wrote";
  return isScriptRun(call.info) ? "ran" : null;
}

/** What calls did together: a write outranks a script run. */
function callsEffect(calls: readonly FlowCall[]): ToolCallEffect | null {
  const effects = calls.map(callEffect);
  if (effects.includes("wrote")) return "wrote";
  return effects.includes("ran") ? "ran" : null;
}

function callsTone(calls: readonly FlowCall[], generating: boolean): FlowCallTone {
  const statuses = calls.map((call) => callStatus(call, generating));
  if (statuses.includes("failed")) return "failed";
  return statuses.includes("running") ? "running" : "ok";
}

/** A task delegated to the coding harness, which shows as its own block even while its step is folded. */
function isCodeTask(call: FlowCall): boolean {
  return call.info.name === "code_task";
}

/** How a code task's status reads on its block: "Running…", "Done", "Failed", or how it ended. */
function taskStatusLabel(call: FlowCall, status: ToolCallStatus): string {
  if (status === "running") return "Running…";
  const word = codeTaskStatus(callMetadata(call).status);
  if (word && word !== "completed") return word.charAt(0).toUpperCase() + word.slice(1);
  return status === "failed" ? "Failed" : "Done";
}

function totalDuration(calls: readonly FlowCall[]): number {
  return calls.reduce((sum, call) => sum + callDuration(call), 0);
}

function callDuration(call: FlowCall): number {
  return numberOf(callMetadata(call).duration_ms);
}

function turnMeta(step: FlowStep): Record<string, unknown> {
  return step.turn?.metadata ?? {};
}

/** A line of markdown as plain text: no heading marks, emphasis or code ticks. */
function plainLine(line: string): string {
  return line.replace(/^\s*#+\s+/, "").replace(/\*\*|__|`/g, "");
}

/** A thought's opening line as plain text, for its folded row. */
function thoughtSummary(text: string): string {
  return (
    text
      .split("\n")
      .map(plainLine)
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

/** Markdown flattened to plain text on one line, for a folded step's note. */
function plainText(text: string): string {
  return text
    .split("\n")
    .map((line) => plainLine(line).trim())
    .filter(Boolean)
    .join(" ");
}

/** What steps' calls did, for a header that does not name them: their kinds, effect, failures, count, time, tokens and cost. */
function stepCues(steps: readonly FlowStep[], generating: boolean): FlowStepCues {
  const calls = steps.flatMap((step) => step.calls);
  const metas = steps.map(turnMeta);
  const usages = steps.map((step) => turnUsage(step.turn));
  const sum = (values: unknown[]) =>
    values.reduce<number>((total, value) => total + numberOf(value), 0);
  const modelMs = sum(metas.map((meta) => meta.latency_ms));
  const toolMs = totalDuration(calls);
  const input = sum(usages.map((usage) => usage.input_tokens));
  const output = sum(usages.map((usage) => usage.output_tokens));
  const cached = sum(usages.map((usage) => usage.cache_read_tokens));
  const costs = metas.map((meta) => meta.cost_usd).filter((cost) => typeof cost === "number");
  const kinds = new Set(calls.map((call) => kindLabel(call.info.kind)));
  const facts: StepFact[] = [];
  if (input + output) {
    facts.push({
      label: `${formatTokens(input + output)} tok`,
      title: [
        `${input.toLocaleString()} in`,
        `${output.toLocaleString()} out`,
        cached ? `${cached.toLocaleString()} cached` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }
  if (costs.length) facts.push({ label: formatCost(sum(costs)) });
  return {
    kinds: TOOL_KINDS.filter((kind) => kinds.has(kind)),
    effect: callsEffect(calls),
    failed: calls.filter((call) => callError(call, generating)).length,
    calls: calls.length,
    duration: {
      label: formatDuration(modelMs + toolMs) || "0ms",
      title: `${formatDuration(modelMs) || "0ms"} model · ${formatDuration(toolMs) || "0ms"} tools`,
    },
    facts,
  };
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
  if (!isMutation(call.info)) return null;
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

/** What the model said alongside a step's calls; empty when it said nothing. */
function stepText(step: FlowStep): string {
  return step.turn ? turnText(step.turn).trim() : "";
}

type ThoughtBodyProps = { text: string };

/** Reasoning unfolded: the whole text, with a copy button. */
function ThoughtBody({ text }: ThoughtBodyProps) {
  return (
    <div className="relative rounded-lg bg-paper px-3 py-2 pr-9">
      <p className="text-sm whitespace-pre-wrap text-fg-2">{text}</p>
      <CopyButton text={text} what="reasoning" size={24} className="absolute top-1.5 right-1.5" />
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

/** A step of the flow with its position among the flow's steps. */
type IndexedStep = { step: FlowStep; index: number };

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
  /** Opens this flow at that step's call and scrolls to it, when the flow holds it. */
  reveal?: RevealStep;
  /** Where chips on mutations lead; without it, calls carry no links. */
  inspector?: Inspector;
  /** Pins a call to a question for Studio's coach. */
  onAskCall?: ((call: FlowCall) => void) | undefined;
  /** What running calls have reported so far, by call id. */
  progress?: ToolProgress;
  /** The harness the agent codes through; marks code tasks that have not named theirs yet. */
  harness?: Harness | null;
};

/** One generation: its header, then one block per step on a rail, folded to what its calls did and what the model said until opened, expanded or filtered. */
export function FlowView({
  flow,
  runId,
  generating,
  reveal,
  inspector,
  onAskCall,
  progress,
  harness,
}: FlowViewProps) {
  const [revealed] = useState(() => revealedCall(flow, reveal));
  const [filter, setFilter] = useState<GenerationFilter | null>(null);
  const [thinkingHidden, setThinkingHidden] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [openCall, setOpenCall] = useState<string | null>(revealed ? callKey(revealed) : null);
  const section = useRef<HTMLElement>(null);
  const stats = flowStats(flow);

  useEffect(() => {
    const node = revealed ? section.current?.querySelector<HTMLElement>("[data-revealed]") : null;
    if (node) centerInScroller(node);
  }, [revealed]);

  const calls = flow.steps.flatMap((step) => step.calls);
  const failedCalls = calls.filter((call) => callError(call, generating)).length;
  const mutations = calls.filter((call) => isMutation(call.info)).length;
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
  const statLabels: GenerationStat[] = [
    {
      label: formatDuration(stats.modelMs + stats.toolMs) || "0ms",
      title: `${formatDuration(stats.modelMs) || "0ms"} model · ${formatDuration(stats.toolMs) || "0ms"} tools`,
    },
    { label: `${stats.steps} step${stats.steps === 1 ? "" : "s"}` },
    {
      label: `${stats.calls} tool call${stats.calls === 1 ? "" : "s"}`,
      ...(stats.kinds ? { title: stats.kinds } : {}),
    },
    ...(failedCalls ? [{ label: `${failedCalls} failed`, tone: "failed" as const }] : []),
    {
      label: `${formatTokens(stats.inputTokens + stats.outputTokens)} tok`,
      title: `${stats.inputTokens.toLocaleString()} in · ${stats.outputTokens.toLocaleString()} out`,
    },
    ...(stats.costUsd !== null ? [{ label: formatCost(stats.costUsd) }] : []),
  ];
  const answered = flow.steps.some((step) => stepText(step));

  /** Scrolls the last thing the model said in the generation into the middle of its scroller. */
  const jumpToAnswer = () => {
    const notes = section.current?.querySelectorAll<HTMLElement>("[data-note]");
    const last = notes?.[notes.length - 1];
    if (last) centerInScroller(last);
  };

  const dimCall = (call: FlowCall) =>
    (filter === "mutations" && !isMutation(call.info)) ||
    (filter === "errors" && !callError(call, generating));

  /** Expanding opens every block and thought; collapsing also drops the filter, so all fold. */
  const expandAll = (next: boolean) => {
    setExpanded(next);
    if (!next) setFilter(null);
  };
  /** What a change of view resets, so blocks and thoughts take its opening state. */
  const view = `${expanded}:${filter ?? "all"}`;
  /** Steps and compacted runs opened or closed by hand, for the view they were toggled in. */
  const [folds, setFolds] = useState<{ view: string; open: Record<string, boolean> }>({
    view,
    open: {},
  });

  /** A code task's harness logo, pulsing while the call runs. */
  const harnessMark = (call: FlowCall): ReactNode => {
    const runsOn = callHarness(call, harness);
    if (!runsOn) return null;
    return (
      <HarnessLogo
        harness={runsOn}
        size={24}
        className={cn(
          "shrink-0",
          callStatus(call, generating) === "running" && "motion-safe:animate-pulse",
        )}
      />
    );
  };

  /** A call's card. */
  const renderCall = (call: FlowCall, index?: number) => {
    const error = callError(call, generating);
    const expanded = openCall === callKey(call);
    const status = callStatus(call, generating);
    const reported = status === "running" ? progress?.[call.id] : undefined;
    const runsOn = callHarness(call, harness);
    const card = (
      <ToolCall
        key={callKey(call)}
        {...(revealed && callKey(revealed) === callKey(call)
          ? { "data-revealed": "", className: "ring-2 ring-signal" }
          : {})}
        name={call.info.name}
        {...(runsOn ? { icon: harnessMark(call) } : {})}
        kind={call.info.kind}
        effect={callEffect(call)}
        server={
          call.info.server && !call.info.name.startsWith(`${call.info.server}_`)
            ? call.info.server
            : null
        }
        {...(index !== undefined ? { index } : {})}
        hint={[
          runsOn && status === "running" ? `${harnessLabels[runsOn]} is generating…` : "",
          friendlyToolCall(call.call),
          toolOutcome(call.result?.metadata),
        ]
          .filter(Boolean)
          .join(" · ")}
        status={status}
        {...(error ? { error: previewText(error, 160) } : {})}
        duration={formatDuration(callDuration(call))}
        dimmed={dimCall(call)}
        expanded={expanded}
        detail={expanded ? detailFor(call) : undefined}
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

  /** A call opened up: its views, with what it has reported while running. */
  const detailFor = (call: FlowCall) => {
    const reported = callStatus(call, generating) === "running" ? progress?.[call.id] : undefined;
    return (
      <ToolCallDetail
        call={call}
        run={{
          generating,
          ...(runId ? { id: runId } : {}),
          ...(reported ? { progress: reported } : {}),
        }}
        onAsk={onAskCall}
      />
    );
  };

  /** A code task as its own block: the harness, the prompt it was given, and how it went. */
  const taskCard = (call: FlowCall): ReactNode => {
    const status = callStatus(call, generating);
    const meta = callMetadata(call);
    const args = parseToolArgs(call.call?.function?.arguments);
    const runsOn = callHarness(call, harness);
    const reported = status === "running" ? progress?.[call.id] : undefined;
    const open = openCall === callKey(call);
    const error = callError(call, generating);
    const repository = typeof meta.repository === "string" ? meta.repository : args.repo;
    const lit = revealed !== null && callKey(revealed) === callKey(call);
    return (
      <FlowHarnessTask
        key={`task:${callKey(call)}`}
        {...(lit ? { "data-revealed": "", className: "ring-2 ring-signal" } : {})}
        harness={runsOn ? harnessLabels[runsOn] : "Harness"}
        prompt={typeof args.brief === "string" ? args.brief : ""}
        {...(typeof repository === "string" && repository ? { repository } : {})}
        status={status === "running" ? "running" : status === "failed" ? "failed" : "done"}
        statusLabel={taskStatusLabel(call, status)}
        changes={codeTaskChanges(meta)}
        effect={callEffect(call)}
        duration={formatDuration(callDuration(call))}
        {...(error ? { error: previewText(error, 160) } : {})}
        {...(reported?.lines.length
          ? {
              progress: (
                <ProgressLines
                  lines={reported.lines.slice(-PROGRESS_TAIL)}
                  className="bg-surface"
                />
              ),
            }
          : {})}
        detail={open ? detailFor(call) : undefined}
        open={open}
        onOpenChange={(next) => setOpenCall(next ? callKey(call) : null)}
      />
    );
  };

  const stepKey = (step: FlowStep, index: number) => `${step.index ?? "result"}:${index}`;

  /** The cards of calls a step requested: one card, or a batch of several numbered in the order they ran. */
  const callCards = (calls: readonly FlowCall[], key: string): ReactNode => {
    const [only] = calls;
    if (!only) return null;
    if (calls.length === 1) return renderCall(only);
    return (
      <FlowBatch key={`${key}:calls`}>
        {calls.map((call) => renderCall(call, call.position))}
      </FlowBatch>
    );
  };

  /** Whether a step or a compacted run starts open: in its view, or holding a running call or the call revealed. */
  const opensByDefault = (calls: readonly FlowCall[]) =>
    expanded ||
    (filter !== null && !calls.every(dimCall)) ||
    calls.some((call) => callStatus(call, generating) === "running") ||
    (revealed !== null && calls.includes(revealed));

  const isOpen = (key: string, calls: readonly FlowCall[]) =>
    (folds.view === view ? folds.open[key] : undefined) ?? opensByDefault(calls);

  const toggle = (key: string, next: boolean) =>
    setFolds((current) => ({
      view,
      open: { ...(current.view === view ? current.open : {}), [key]: next },
    }));

  /** What the model said alongside a step's calls: plain while folded, its Markdown while open. */
  const stepNote = (step: FlowStep, open: boolean): ReactNode => {
    const said = stepText(step);
    if (!said) return null;
    return open ? <Markdown density="compact">{said}</Markdown> : plainText(said);
  };

  /**
   * A step as one block: its header names what its calls did, and what the model said sits under it.
   * Folded, its code tasks show below; open, its reasoning, calls and code tasks.
   */
  const stepBlock = (step: FlowStep, index: number): ReactNode => {
    const key = `step:${stepKey(step, index)}`;
    const open = isOpen(key, step.calls);
    const reasoning = step.turn && !thinkingHidden ? turnReasoning(step.turn).trim() : "";
    const summary = thoughtSummary(reasoning);
    const note = stepNote(step, open);
    const stop = stopTag(turnMeta(step).finish_reason);
    const tasks = step.calls.filter(isCodeTask);
    const outputs = tasks.map(taskCard);
    const [task] = tasks;
    const harnessIcon = task ? harnessMark(task) : null;
    return (
      <FlowEntry
        key={key}
        marker="step"
        tone={callsTone(step.calls, generating)}
        {...(harnessIcon ? { icon: harnessIcon } : {})}
        dimmed={filter !== null && step.calls.every(dimCall)}
      >
        <FlowStepBlock
          label={step.index === null ? "Tool result" : `Step ${step.index}`}
          title={summarizeCalls(step.calls.map((call) => call.call))}
          {...(note ? { note } : {})}
          {...stepCues([step], generating)}
          {...(stop ? { stop } : {})}
          open={open}
          onOpenChange={(next) => toggle(key, next)}
          {...(outputs.length ? { outputs } : {})}
        >
          {reasoning ? (
            <FlowThought
              key={`${key}:thinking:${view}`}
              label="thinking"
              defaultOpen={expanded}
              summary={summary}
            >
              {reasoning.length > THOUGHT_LINE || reasoning !== summary ? (
                <ThoughtBody text={reasoning} />
              ) : null}
            </FlowThought>
          ) : null}
          {callCards(
            step.calls.filter((call) => !isCodeTask(call)),
            key,
          )}
          {outputs}
        </FlowStepBlock>
      </FlowEntry>
    );
  };

  /** Consecutive steps that produced nothing but calls, compacted into one block that opens onto them. */
  const runBlock = (run: readonly IndexedStep[]): ReactNode => {
    const [first] = run;
    if (!first) return null;
    const steps = run.map(({ step }) => step);
    const calls = steps.flatMap((step) => step.calls);
    const key = `run:${stepKey(first.step, first.index)}`;
    return (
      <FlowEntry
        key={key}
        marker="steps"
        tone={callsTone(calls, generating)}
        dimmed={calls.every(dimCall)}
      >
        <FlowStepRun
          steps={run.length}
          {...stepCues(steps, generating)}
          open={isOpen(key, calls)}
          onOpenChange={(next) => toggle(key, next)}
        >
          <FlowTimeline>{run.map(({ step, index }) => stepBlock(step, index))}</FlowTimeline>
        </FlowStepRun>
      </FlowEntry>
    );
  };

  /** Whether a step produced something to read on its own: something the model said, or a code task. */
  const produced = (step: FlowStep) => Boolean(stepText(step)) || step.calls.some(isCodeTask);

  /** The rail: one block per step, and runs of two or more steps that produced nothing compacted into one. */
  const timeline = (): ReactNode[] => {
    const entries: ReactNode[] = [];
    let silent: IndexedStep[] = [];
    const flush = () => {
      const [only] = silent;
      if (silent.length === 1 && only) entries.push(stepBlock(only.step, only.index));
      else if (silent.length > 1) entries.push(runBlock(silent));
      silent = [];
    };
    flow.steps.forEach((step, index) => {
      if (produced(step)) {
        flush();
        entries.push(stepBlock(step, index));
      } else {
        silent.push({ step, index });
      }
    });
    flush();
    return entries;
  };

  return (
    <section
      ref={section}
      className="flex flex-col rounded-xl bg-surface"
      aria-label={flow.generation ? `Generation ${flow.generation}` : "Tool trace"}
    >
      <GenerationHeader
        className="border-b border-line"
        title={
          <span title={model ? `Model: ${model}` : undefined}>
            {flow.generation ? `Generation ${flow.generation}` : "Tool trace"}
          </span>
        }
        stats={statLabels}
        status={status}
        counts={{ all: calls.length, mutations, errors: failedCalls }}
        filter={filter}
        onFilterChange={setFilter}
        thinkingHidden={thinkingHidden}
        onThinkingHiddenChange={setThinkingHidden}
        expanded={expanded}
        onExpandedChange={expandAll}
        {...(answered ? { onJumpToAnswer: jumpToAnswer } : {})}
      />
      <div className="flex flex-col gap-2 px-3 pt-2 pb-3">
        <FlowTimeline>{timeline()}</FlowTimeline>
        {flow.errors.map((error, index) => (
          <Banner
            key={`${String(error.operation)}:${index}`}
            tone="error"
            title={String(error.message ?? "The generation failed")}
            meta={String(error.operation ?? "")}
          />
        ))}
      </div>
    </section>
  );
}
