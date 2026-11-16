import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState, type ReactNode } from "react";
import { JsonTree } from "../content/JsonTree";
import { Segmented } from "../controls/Segmented";
import {
  FlowBatch,
  FlowEntry,
  FlowStepBlock,
  FlowStepRun,
  FlowThought,
  FlowTimeline,
} from "./FlowTimeline";
import type { GenerationFilter } from "./GenerationFilters";
import { GenerationHeader } from "./GenerationHeader";
import {
  ToolCall,
  ToolCallLink,
  ToolCallTags,
  type ToolCallEffect,
  type ToolCallStatus,
  type ToolKind,
} from "./ToolCall";

const meta: Meta<typeof FlowTimeline> = {
  title: "Components/Runs/FlowTimeline",
  component: FlowTimeline,
};
export default meta;

type Story = StoryObj<typeof FlowTimeline>;

/** Tokens and cost, shown on a step's header on hover. */
const facts = [
  { label: "7.3k tok", title: "7,120 in · 180 out" },
  { label: "$0.0010", title: "Cost source: catalog" },
];

type Call = {
  name: string;
  kind: ToolKind;
  hint: string;
  duration: string;
  status?: ToolCallStatus;
  effect?: ToolCallEffect;
  error?: string;
  link?: string;
  detail?: unknown;
};

type Step = {
  /** What its calls did, for its header. */
  title: string;
  thinking?: string;
  /** The rest of the thinking, behind **more**. */
  more?: string;
  /** What the model said alongside its calls. */
  note?: string;
  calls: Call[];
  duration: string;
};

const steps: Step[] = [
  {
    title: "Run git ls-remote origin",
    thinking: "The remote repo seems empty or inaccessible.",
    calls: [
      {
        name: "shell",
        kind: "execute",
        hint: "git ls-remote origin",
        duration: "1.5s",
        detail: { command: "git ls-remote git@example.com:acme/landing.git" },
      },
    ],
    duration: "1.5s",
  },
  {
    title: "Run gh api repos/acme/landing/contents",
    thinking: "The repo exists but seems empty. Let me check its contents through the API.",
    more: "If it has no commits, the landing page has to start from scratch.",
    note: "The repo is empty, so this means building the hero scaffold as well as the animation. I'll look for design notes first, then delegate.",
    calls: [
      {
        name: "shell",
        kind: "execute",
        hint: "gh api repos/acme/landing/contents",
        duration: "1.5s",
      },
    ],
    duration: "1.5s",
  },
  {
    title: "Wrote brief.md, plan.md",
    calls: [
      {
        name: "note_write",
        kind: "write",
        hint: "Wrote brief.md",
        duration: "90ms",
        effect: "wrote",
        link: "brief.md",
      },
      {
        name: "note_write",
        kind: "write",
        hint: "Wrote plan.md",
        duration: "110ms",
        effect: "wrote",
        link: "plan.md",
      },
    ],
    duration: "0.2s",
  },
  {
    title: "Run pnpm test · Read src/Hero.tsx, src/hero.css · Run git push origin main",
    thinking: "The hero is in. Now I verify it.",
    calls: [
      { name: "shell", kind: "execute", hint: "pnpm test", duration: "6.1s" },
      { name: "file_read", kind: "read", hint: "src/Hero.tsx", duration: "40ms" },
      { name: "file_read", kind: "read", hint: "src/hero.css", duration: "38ms" },
      {
        name: "shell",
        kind: "execute",
        hint: "git push origin main",
        duration: "3s",
        status: "failed",
        error: "error: src refspec main does not match any",
      },
    ],
    duration: "9.2s",
  },
  {
    title: "Run open_release.py",
    thinking: "The push failed because origin has no main branch.",
    note: "No main branch on origin yet, so the push failed. I'll run the release script to open it, then push again. Tests and lint pass locally, and the landing hero is committed on a local branch.",
    calls: [
      {
        name: "script_run",
        kind: "execute",
        hint: "Run open_release.py",
        duration: "4.5s",
        effect: "ran",
      },
    ],
    duration: "4.5s",
  },
];

function CallDetail({ kind, value }: { kind: ToolKind; value: unknown }) {
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          size="sm"
          label="call details"
          value="arguments"
          onValueChange={() => {}}
          options={[
            { value: "arguments", label: "Arguments" },
            { value: "result", label: "Result" },
            { value: "metadata", label: "Metadata" },
          ]}
        />
        <span className="ml-auto">
          <ToolCallTags kind={kind} level="local" />
        </span>
      </div>
      <div className="rounded-md bg-surface p-3">
        <JsonTree value={value} />
      </div>
    </div>
  );
}

const allCalls = steps.flatMap((step) => step.calls);

function effectOf(calls: readonly Call[]): ToolCallEffect | null {
  if (calls.some((call) => call.effect === "wrote")) return "wrote";
  return calls.some((call) => call.effect === "ran") ? "ran" : null;
}

const kindOrder: ToolKind[] = ["memory", "read", "write", "execute", "act", "post", "connected"];

/** What steps' calls did, for a header that does not name them. */
function cuesOf(of: readonly Step[]) {
  const calls = of.flatMap((step) => step.calls);
  const seconds = of.reduce((sum, step) => sum + parseFloat(step.duration), 0);
  return {
    kinds: kindOrder.filter((kind) => calls.some((call) => call.kind === kind)),
    effect: effectOf(calls),
    failed: calls.filter((call) => call.status === "failed").length,
    calls: calls.length,
    duration: { label: `${seconds.toFixed(1)}s`, title: "model and tool time" },
    facts,
  };
}

function GenerationFlow() {
  const [filter, setFilter] = useState<GenerationFilter | null>(null);
  const [thinkingHidden, setThinkingHidden] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [openCall, setOpenCall] = useState<string | null>(null);
  const view = `${expanded}:${filter ?? "all"}`;
  const [folds, setFolds] = useState<{ view: string; open: Record<string, boolean> }>({
    view,
    open: {},
  });
  const kept = (call: Call) =>
    filter === "mutations"
      ? call.effect === "wrote"
      : filter === "errors"
        ? call.status === "failed"
        : true;
  const expandAll = (next: boolean) => {
    setExpanded(next);
    if (!next) setFilter(null);
  };
  const jump = () =>
    [...document.querySelectorAll("[data-note]")]
      .at(-1)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  const isOpen = (key: string, calls: readonly Call[]) =>
    (folds.view === view ? folds.open[key] : undefined) ??
    (expanded || (filter !== null && calls.some(kept)));
  const toggle = (key: string, next: boolean) =>
    setFolds((current) => ({
      view,
      open: { ...(current.view === view ? current.open : {}), [key]: next },
    }));

  const card = (call: Call, key: string, index?: number) => (
    <ToolCall
      key={key}
      {...(index !== undefined ? { index } : {})}
      name={call.name}
      kind={call.kind}
      hint={call.hint}
      status={call.status ?? "ok"}
      duration={call.duration}
      {...(call.effect ? { effect: call.effect } : {})}
      {...(call.error ? { error: call.error } : {})}
      {...(call.link ? { link: <ToolCallLink href="#">{call.link}</ToolCallLink> } : {})}
      dimmed={!kept(call)}
      expanded={openCall === key}
      detail={
        openCall === key ? (
          <CallDetail kind={call.kind} value={call.detail ?? { hint: call.hint }} />
        ) : undefined
      }
      onClick={() => setOpenCall((current) => (current === key ? null : key))}
    />
  );

  /** A step as one block: folded to its header and its note; open onto everything. */
  const stepBlock = (step: Step, index: number) => {
    const key = `step:${index}`;
    const thinking = thinkingHidden ? undefined : step.thinking;
    const [only] = step.calls;
    return (
      <FlowEntry
        key={key}
        marker="step"
        tone={step.calls.some((call) => call.status === "failed") ? "failed" : "ok"}
        dimmed={filter !== null && !step.calls.some(kept)}
      >
        <FlowStepBlock
          label={`Step ${index + 1}`}
          title={step.title}
          {...(step.note ? { note: step.note } : {})}
          {...cuesOf([step])}
          open={isOpen(key, step.calls)}
          onOpenChange={(next) => toggle(key, next)}
        >
          {thinking ? (
            <FlowThought
              key={`${index}:thinking:${view}`}
              label="thinking"
              summary={thinking}
              defaultOpen={expanded}
            >
              {step.more ? (
                <div className="rounded-lg bg-paper px-3 py-2">
                  <p className="text-sm whitespace-pre-wrap text-fg-2">
                    {`${thinking}\n\n${step.more}`}
                  </p>
                </div>
              ) : null}
            </FlowThought>
          ) : null}
          {only && step.calls.length === 1 ? card(only, `${index}:0`) : null}
          {step.calls.length > 1 ? (
            <FlowBatch key={`${index}:calls`}>
              {step.calls.map((call, position) => card(call, `${index}:${position}`, position + 1))}
            </FlowBatch>
          ) : null}
        </FlowStepBlock>
      </FlowEntry>
    );
  };

  /** One block per step, and two or more steps that produced nothing compacted into one. */
  const timeline = () => {
    const entries: ReactNode[] = [];
    let silent: Step[] = [];
    const flush = () => {
      const [first] = silent;
      if (silent.length === 1 && first) entries.push(stepBlock(first, steps.indexOf(first)));
      if (silent.length > 1 && first) {
        const key = `run:${steps.indexOf(first)}`;
        const calls = silent.flatMap((step) => step.calls);
        entries.push(
          <FlowEntry
            key={key}
            marker="steps"
            tone={calls.some((call) => call.status === "failed") ? "failed" : "ok"}
            dimmed={filter !== null && !calls.some(kept)}
          >
            <FlowStepRun
              steps={silent.length}
              {...cuesOf(silent)}
              open={isOpen(key, calls)}
              onOpenChange={(next) => toggle(key, next)}
            >
              <FlowTimeline>
                {silent.map((step) => stepBlock(step, steps.indexOf(step)))}
              </FlowTimeline>
            </FlowStepRun>
          </FlowEntry>,
        );
      }
      silent = [];
    };
    steps.forEach((step, index) => {
      if (step.note) {
        flush();
        entries.push(stepBlock(step, index));
      } else {
        silent.push(step);
      }
    });
    flush();
    return entries;
  };

  return (
    <section className="flex flex-col rounded-xl bg-surface">
      <GenerationHeader
        className="border-b border-line"
        title="Generation 1"
        stats={[
          { label: "42s", title: "18s model · 24s tools" },
          { label: "6 steps" },
          { label: "10 tool calls" },
          { label: "1 failed", tone: "failed" },
          { label: "61k tok" },
          { label: "$0.0041" },
        ]}
        status={{ kind: "errors", count: 1 }}
        counts={{
          all: allCalls.length,
          mutations: allCalls.filter((call) => call.effect === "wrote").length,
          errors: allCalls.filter((call) => call.status === "failed").length,
        }}
        filter={filter}
        onFilterChange={setFilter}
        thinkingHidden={thinkingHidden}
        onThinkingHiddenChange={setThinkingHidden}
        expanded={expanded}
        onExpandedChange={expandAll}
        onJumpToAnswer={jump}
      />
      <div className="px-3 pt-2 pb-3">
        <FlowTimeline>{timeline()}</FlowTimeline>
      </div>
    </section>
  );
}

/**
 * A generation as one block per step: folded, each names what its calls did with cues on them, and
 * shows what the model said under it; open, its reasoning and calls (a batch in one bracket). Steps that produced nothing in a row compact into one block.
 * **Expand all** opens every block; **Writes** or **Errors** open only those holding such calls and
 * dim the rest; **Collapse all** folds it back.
 */
export const Generation: Story = {
  render: () => (
    <div className="w-3xl max-w-full">
      <GenerationFlow />
    </div>
  ),
};

/** A step still waiting on a call pulses its dot and stays open on the running batch. */
export const Running: Story = {
  render: () => (
    <div className="w-3xl max-w-full rounded-xl bg-surface p-3">
      <FlowTimeline>
        <FlowEntry marker="step" tone="running">
          <FlowStepBlock
            label="Step 1"
            title="List degen-orders · Find notes treasury"
            kinds={["read"]}
            calls={2}
            duration={{ label: "2.1s" }}
            open
            onOpenChange={() => {}}
          >
            <FlowThought label="thinking" summary="Checking both feeds before posting." />
            <FlowBatch>
              <ToolCall
                index={1}
                name="record_list"
                kind="read"
                hint="degen-orders"
                status="ok"
                duration="30ms"
              />
              <ToolCall
                index={2}
                name="note_find"
                kind="read"
                hint="Find notes treasury"
                status="running"
              />
            </FlowBatch>
          </FlowStepBlock>
        </FlowEntry>
      </FlowTimeline>
    </div>
  ),
};

