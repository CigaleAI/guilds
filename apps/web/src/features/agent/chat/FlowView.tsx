import { createLink } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CopyButton,
  Markdown,
  Banner,
  FlowAnswer,
  FlowCallGroup,
  FlowEntry,
  FlowHarnessTask,
  FlowStretch,
  FlowThought,
  FlowTimeline,
  GenerationHeader,
  ToolCall,
  ToolCallLink,
  cn,
} from "@guildsrun/ui";
import type {
  FlowCallTone,
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
  toolOutcome,
} from "../runs/toolFormat";
import { isMutation, isScriptRun, kindBreakdown, levelFromDisplayPath } from "../runs/toolKinds";
import type { ToolProgress } from "../../../api/toolProgress";
import { isoTime, messageTime } from "../../../app/format";
import type { Harness } from "../../../api/types";
import { harnessLabels } from "../harness";
import { HarnessLogo } from "../HarnessLogo";
import { callHarness } from "./callDetail";
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

/** A piece of a step on the rail, and the calls it holds; standalone pieces (answers and code tasks) split the rail into stretches. */
type Part = { key: string; node: ReactNode; standalone: boolean; calls: readonly FlowCall[] };

/** A task delegated to the coding harness, which takes its own block on the rail. */
function isCodeTask(call: FlowCall): boolean {
  return call.info.name === "code_task";
}

/** How a code task's status reads on its block: "Running…", "Done", "Failed", or how it ended. */
function taskStatusLabel(call: FlowCall, status: ToolCallStatus): string {
  if (status === "running") return "Running…";
  const word = codeTaskStatus(
    (call.result?.metadata as Record<string, unknown> | undefined)?.status,
  );
  if (word && word !== "completed") return word.charAt(0).toUpperCase() + word.slice(1);
  return status === "failed" ? "Failed" : "Done";
}

function totalDuration(calls: readonly FlowCall[]): number {
  return calls.reduce((sum, call) => sum + callDuration(call), 0);
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
function stepAnswer(step: FlowStep): string {
  return step.turn ? turnText(step.turn).trim() : "";
}

/** When a step's turn was written, for an answer's header. */
function stepTime(step: FlowStep): { time?: string; dateTime?: string } {
  const createdAt = step.turn?.created_at;
  return typeof createdAt === "string" && createdAt
    ? { time: messageTime(createdAt), dateTime: isoTime(createdAt) }
    : {};
}

/** Reasoning unfolded: the whole text, with a copy button. */
function ThoughtBody({ text }: { text: string }) {
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
  /** Who wrote the flow's answers. */
  agentName?: string;
};

/** One generation: its header, then its answers on a rail, with the work between them folded into stretches until opened, expanded or filtered. */
export function FlowView({
  flow,
  runId,
  generating,
  reveal,
  inspector,
  onAskCall,
  progress,
  harness,
  agentName,
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
  const answered = flow.steps.some((step) => stepAnswer(step));

  /** Scrolls the generation's last answer into the middle of its scroller. */
  const jumpToAnswer = () => {
    const answers = section.current?.querySelectorAll<HTMLElement>("[data-answer]");
    const last = answers?.[answers.length - 1];
    if (last) centerInScroller(last);
  };

  const dimCall = (call: FlowCall) =>
    (filter === "mutations" && !isMutation(call.info)) ||
    (filter === "errors" && !callError(call, generating));

  /** Expanding opens every thought and group; collapsing also drops the filter, so all fold. */
  const expandAll = (next: boolean) => {
    setExpanded(next);
    if (!next) setFilter(null);
  };
  /** What a change of view remounts, so groups and thoughts take its opening state. */
  const view = `${expanded}:${filter ?? "all"}`;
  /** Stretches opened or closed by hand, for the view they were toggled in. */
  const [stretches, setStretches] = useState<{ view: string; open: Record<string, boolean> }>({
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

  /** A call's card; `railed` when its entry's marker already shows its harness. */
  const renderCall = (call: FlowCall, index?: number, railed = false) => {
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
        {...(runsOn && !railed ? { icon: harnessMark(call) } : {})}
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
  const taskEntry = (call: FlowCall): ReactNode => {
    const status = callStatus(call, generating);
    const meta = (call.result?.metadata as Record<string, unknown> | undefined) ?? {};
    const args = parseToolArgs(call.call?.function?.arguments);
    const runsOn = callHarness(call, harness);
    const reported = status === "running" ? progress?.[call.id] : undefined;
    const open = openCall === callKey(call);
    const error = callError(call, generating);
    const repository = typeof meta.repository === "string" ? meta.repository : args.repo;
    const lit = revealed !== null && callKey(revealed) === callKey(call);
    return (
      <FlowEntry
        key={`task:${callKey(call)}`}
        marker="call"
        tone={callsTone([call], generating)}
        icon={harnessMark(call)}
        dimmed={dimCall(call)}
      >
        <FlowHarnessTask
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
      </FlowEntry>
    );
  };

  /** What the model said in a step, as an answer card that no fold or filter hides. */
  const answerEntry = (step: FlowStep, key: string): ReactNode => {
    const text = stepAnswer(step);
    if (!text) return null;
    const stop = stopTag(turnMeta(step).finish_reason);
    return (
      <FlowEntry key={`${key}:answer`} marker="answer" data-answer="">
        <FlowAnswer
          {...(agentName ? { author: agentName } : {})}
          {...stepTime(step)}
          {...(stop ? { stop } : {})}
          actions={<CopyButton text={text} what="message" size={24} />}
        >
          <Markdown density="compact">{text}</Markdown>
        </FlowAnswer>
      </FlowEntry>
    );
  };

  /** A step on the rail: its reasoning, what it said, then the calls it requested. */
  const stepParts = (step: FlowStep, stepIndex: number): Part[] => {
    const key = `${step.index ?? "result"}:${stepIndex}`;
    const meta = turnMeta(step);
    const stop = stopTag(meta.finish_reason);
    const said = stepAnswer(step);
    const reasoning = step.turn ? turnReasoning(step.turn).trim() : "";
    const dimmed = filter !== null && (step.calls.length === 0 || step.calls.every(dimCall));
    const parts: Part[] = [];
    if (reasoning && !thinkingHidden) {
      const summary = thoughtSummary(reasoning);
      parts.push({
        key: `${key}:thinking`,
        standalone: false,
        calls: [],
        node: (
          <FlowEntry key={`${key}:thinking:${view}`} marker="thought" dimmed={dimmed}>
            <FlowThought
              label="thinking"
              defaultOpen={expanded}
              summary={summary}
              facts={stepFacts(step, meta)}
              {...(!said && stop ? { stop } : {})}
            >
              {reasoning.length > THOUGHT_LINE || reasoning !== summary ? (
                <ThoughtBody text={reasoning} />
              ) : null}
            </FlowThought>
          </FlowEntry>
        ),
      });
    } else if (!reasoning && !said && stop) {
      parts.push({
        key: `${key}:stop`,
        standalone: false,
        calls: [],
        node: (
          <FlowEntry key={`${key}:stop`} marker="thought" dimmed={dimmed}>
            <FlowThought label="stopped" summary="" facts={stepFacts(step, meta)} stop={stop} />
          </FlowEntry>
        ),
      });
    }
    const answer = answerEntry(step, key);
    if (answer) parts.push({ key: `${key}:answer`, standalone: true, calls: [], node: answer });
    const calls = step.calls.filter((call) => !isCodeTask(call));
    const [only] = calls;
    if (only) {
      const single = calls.length === 1;
      parts.push({
        key: `${key}:calls`,
        standalone: false,
        calls,
        node: (
          <FlowEntry
            key={`${key}:calls:${view}`}
            marker="call"
            tone={callsTone(calls, generating)}
            {...(single ? { icon: harnessMark(only) } : {})}
            dimmed={calls.every(dimCall)}
          >
            <FlowCallGroup
              names={calls.map((call) => call.info.name)}
              failed={calls.filter((call) => callError(call, generating)).length}
              effect={callsEffect(calls)}
              duration={formatDuration(totalDuration(calls))}
              defaultOpen={
                expanded ||
                filter === null ||
                !calls.every(dimCall) ||
                calls.some((call) => callStatus(call, generating) === "running") ||
                (revealed !== null && calls.includes(revealed))
              }
            >
              {single
                ? renderCall(only, undefined, true)
                : calls.map((call) => renderCall(call, call.position))}
            </FlowCallGroup>
          </FlowEntry>
        ),
      });
    }
    for (const task of step.calls.filter(isCodeTask)) {
      parts.push({
        key: `${key}:task:${callKey(task)}`,
        standalone: true,
        calls: [task],
        node: taskEntry(task),
      });
    }
    return parts;
  };

  /** Whether a stretch starts open: in its view, or holding a running call or the call revealed. */
  const stretchOpensByDefault = (calls: readonly FlowCall[]) =>
    expanded ||
    (filter !== null && !calls.every(dimCall)) ||
    calls.some((call) => callStatus(call, generating) === "running") ||
    (revealed !== null && calls.includes(revealed));

  const toggleStretch = (key: string, next: boolean) =>
    setStretches((current) => ({
      view,
      open: { ...(current.view === view ? current.open : {}), [key]: next },
    }));

  /** The rail: answers whole, and the work between two answers folded into one stretch until opened. */
  const timeline = (): ReactNode[] => {
    const entries: ReactNode[] = [];
    let run: Part[] = [];
    const flush = () => {
      const calls = run.flatMap((part) => part.calls);
      const [first] = run;
      if (!first || !calls.length) {
        entries.push(...run.map((part) => part.node));
        run = [];
        return;
      }
      const key = `stretch:${first.key}`;
      const open =
        (stretches.view === view ? stretches.open[key] : undefined) ?? stretchOpensByDefault(calls);
      const [only] = calls;
      entries.push(
        <FlowEntry
          key={key}
          marker="call"
          tone={callsTone(calls, generating)}
          {...(calls.length === 1 && only ? { icon: harnessMark(only) } : {})}
          dimmed={calls.every(dimCall)}
        >
          <FlowStretch
            steps={run.filter((part) => part.calls.length).length}
            calls={calls.length}
            names={[...new Set(calls.map((call) => call.info.name))]}
            failed={calls.filter((call) => callError(call, generating)).length}
            effect={callsEffect(calls)}
            duration={formatDuration(totalDuration(calls))}
            open={open}
            onOpenChange={(next) => toggleStretch(key, next)}
          />
        </FlowEntry>,
      );
      if (open) entries.push(...run.map((part) => part.node));
      run = [];
    };
    for (const part of flow.steps.flatMap(stepParts)) {
      if (part.standalone) {
        flush();
        entries.push(part.node);
      } else {
        run.push(part);
      }
    }
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
