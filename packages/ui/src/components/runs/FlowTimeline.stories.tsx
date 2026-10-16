import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState, type ReactNode } from "react";
import { JsonTree } from "../content/JsonTree";
import { Segmented } from "../controls/Segmented";
import {
  FlowAnswer,
  FlowCallGroup,
  FlowEntry,
  FlowHarnessTask,
  FlowStretch,
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

const facts = [
  { label: "1 call", title: "execute" },
  { label: "2.6s", title: "2.6s model · 1.5s tools" },
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

/** A task delegated to the coding harness, shown as its own block. */
type Task = { prompt: string; repository: string; changes: string; duration: string };

type Step = {
  thinking?: string;
  /** The rest of the thinking, behind **more**. */
  more?: string;
  answer?: { time: string; body: ReactNode };
  calls: Call[];
  task?: Task;
  duration: string;
};

const steps: Step[] = [
  {
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
    thinking: "The repo exists but seems empty. Let me check its contents through the API.",
    more: "If it has no commits, the landing page has to start from scratch.",
    answer: {
      time: "10:31",
      body: (
        <p>
          The repo is empty, so this means building the hero scaffold as well as the animation. I'll
          look for design notes first, then delegate.
        </p>
      ),
    },
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
    thinking: "Now I'll delegate the build to my harness with a self-contained brief.",
    calls: [],
    task: {
      prompt:
        "Build the landing page hero in src/Hero.tsx: a headline with a staggered fade-in and a background that drifts slowly. Add a test for the reduced-motion fallback, run the tests and lint, and commit on the current branch.",
      repository: "landing",
      changes: "9 files · +1559 −0",
      duration: "1m 44s",
    },
    duration: "1m 44s",
  },
  {
    thinking: "The harness reports done. Now I verify it myself.",
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
    thinking: "The push failed because origin has no main branch.",
    answer: {
      time: "10:36",
      body: (
        <div className="flex flex-col gap-2">
          <p>
            No <code className="font-mono text-sm">main</code> branch on origin yet, so the push
            failed. I'll run the release script to open it, then push again.
          </p>
          <ul className="list-disc pl-5 text-fg-2">
            <li>Tests and lint pass locally.</li>
            <li>The landing hero is committed on a local branch.</li>
          </ul>
        </div>
      ),
    },
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

/** A piece of a step on the rail; answers split the rail into stretches. */
/** A piece of a step on the rail; standalone pieces (answers and harness tasks) split it into stretches. */
type Part = { standalone: boolean; step: Step; calls?: Call[]; node: ReactNode };

function effectOf(calls: readonly Call[]): ToolCallEffect | null {
  if (calls.some((call) => call.effect === "wrote")) return "wrote";
  return calls.some((call) => call.effect === "ran") ? "ran" : null;
}

function GenerationFlow() {
  const [filter, setFilter] = useState<GenerationFilter | null>(null);
  const [thinkingHidden, setThinkingHidden] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [openCall, setOpenCall] = useState<string | null>(null);
  const view = `${expanded}:${filter ?? "all"}`;
  const [stretches, setStretches] = useState<{ view: string; open: Record<string, boolean> }>({
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
    [...document.querySelectorAll("[data-answer]")]
      .at(-1)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });

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

  const parts = (step: Step, index: number): Part[] => {
    const dimmed = filter !== null && !step.calls.some(kept);
    const out: Part[] = [];
    if (step.thinking && !thinkingHidden) {
      out.push({
        standalone: false,
        step,
        node: (
          <FlowEntry key={`${index}:thinking:${view}`} marker="thought" dimmed={dimmed}>
            <FlowThought
              label="thinking"
              summary={step.thinking}
              facts={facts}
              defaultOpen={expanded}
            >
              {step.more ? (
                <div className="rounded-lg bg-paper px-3 py-2">
                  <p className="text-sm whitespace-pre-wrap text-fg-2">
                    {`${step.thinking}\n\n${step.more}`}
                  </p>
                </div>
              ) : null}
            </FlowThought>
          </FlowEntry>
        ),
      });
    }
    if (step.answer) {
      out.push({
        standalone: true,
        step,
        node: (
          <FlowEntry key={`${index}:answer`} marker="answer" data-answer="">
            <FlowAnswer
              author="quill"
              time={step.answer.time}
              dateTime={`2026-10-16T${step.answer.time}:00Z`}
            >
              {step.answer.body}
            </FlowAnswer>
          </FlowEntry>
        ),
      });
    }
    const failed = step.calls.filter((call) => call.status === "failed").length;
    const [only] = step.calls;
    if (only)
      out.push({
        standalone: false,
        step,
        calls: step.calls,
        node: (
          <FlowEntry
            key={`${index}:calls:${view}`}
            marker="call"
            tone={failed ? "failed" : "ok"}
            dimmed={dimmed}
          >
            <FlowCallGroup
              names={step.calls.map((call) => call.name)}
              failed={failed}
              effect={effectOf(step.calls)}
              duration={step.duration}
              defaultOpen={expanded || filter === null || step.calls.some(kept)}
            >
              {step.calls.length === 1 && only
                ? card(only, `${index}:0`)
                : step.calls.map((call, position) =>
                    card(call, `${index}:${position}`, position + 1),
                  )}
            </FlowCallGroup>
          </FlowEntry>
        ),
      });
    if (step.task) {
      const key = `${index}:task`;
      out.push({
        standalone: true,
        step,
        node: (
          <FlowEntry key={key} marker="call" dimmed={filter === "errors"}>
            <FlowHarnessTask
              harness="Codex"
              prompt={step.task.prompt}
              repository={step.task.repository}
              status="done"
              statusLabel="Done"
              changes={step.task.changes}
              effect="wrote"
              duration={step.task.duration}
              open={openCall === key}
              onOpenChange={(next) => setOpenCall(next ? key : null)}
              detail={
                <CallDetail
                  kind="execute"
                  value={{ brief: step.task.prompt, repo: step.task.repository }}
                />
              }
            />
          </FlowEntry>
        ),
      });
    }
    return out;
  };

  /** Answers whole; the steps between two answers folded into one stretch until opened. */
  const timeline = () => {
    const entries: ReactNode[] = [];
    let run: Part[] = [];
    const flush = () => {
      const blocks = run.filter((part) => part.calls);
      const calls = blocks.flatMap((part) => part.calls ?? []);
      const [first] = run;
      if (!first || !calls.length) {
        entries.push(...run.map((part) => part.node));
        run = [];
        return;
      }
      const key = `stretch:${steps.indexOf(first.step)}`;
      const open =
        (stretches.view === view ? stretches.open[key] : undefined) ??
        (expanded || (filter !== null && calls.some(kept)));
      const failed = calls.filter((call) => call.status === "failed").length;
      const seconds = blocks.reduce((sum, part) => sum + parseFloat(part.step.duration), 0);
      entries.push(
        <FlowEntry
          key={key}
          marker="call"
          tone={failed ? "failed" : "ok"}
          dimmed={filter !== null && !calls.some(kept)}
        >
          <FlowStretch
            steps={blocks.length}
            calls={calls.length}
            names={[...new Set(calls.map((call) => call.name))]}
            failed={failed}
            effect={effectOf(calls)}
            duration={`${seconds.toFixed(1)}s`}
            open={open}
            onOpenChange={(next) =>
              setStretches((current) => ({
                view,
                open: { ...(current.view === view ? current.open : {}), [key]: next },
              }))
            }
          />
        </FlowEntry>,
      );
      if (open) entries.push(...run.map((part) => part.node));
      run = [];
    };
    for (const part of steps.flatMap(parts)) {
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
 * A generation as one line, fully collapsed: its answers whole, and the work between two answers
 * folded into one stretch ("4 tool calls in 2 steps"); opening a stretch shows its steps with their
 * calls. **Expand all** opens every stretch, thought and group; **Writes** or **Errors** open only
 * the stretches and groups holding those calls and dim the rest; **Collapse all** folds it back.
 */
export const Generation: Story = {
  render: () => (
    <div className="w-3xl max-w-full">
      <GenerationFlow />
    </div>
  ),
};

/** A step still waiting on its calls pulses its wrench; its group opens to show them. */
export const Running: Story = {
  render: () => (
    <div className="w-3xl max-w-full rounded-xl bg-surface p-3">
      <FlowTimeline>
        <FlowEntry marker="thought">
          <FlowThought
            label="thinking"
            summary="Checking both feeds before posting."
            facts={facts}
          />
        </FlowEntry>
        <FlowEntry marker="call" tone="running">
          <FlowCallGroup names={["record_list", "note_find"]} defaultOpen>
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
          </FlowCallGroup>
        </FlowEntry>
      </FlowTimeline>
    </div>
  ),
};

/** A harness task while it runs: its status pulses and its latest progress shows under the prompt. */
export const HarnessTask: Story = {
  render: () => (
    <div className="w-3xl max-w-full rounded-xl bg-surface p-3">
      <FlowTimeline>
        <FlowEntry marker="call" tone="running">
          <FlowHarnessTask
            harness="Claude Code"
            prompt="Fix the failing checkout test: the cart total ignores discounts on bundled items. Keep the public API, add a regression test, and commit on the current branch."
            repository="shop"
            status="running"
            statusLabel="Running…"
            duration="38s"
            open={false}
            onOpenChange={() => {}}
            progress={
              <pre className="max-h-32 overflow-auto rounded-md bg-surface p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg-2">
                {
                  "Reading src/cart/total.ts\nRunning pnpm test cart\n2 failing: bundles apply discount"
                }
              </pre>
            }
          />
        </FlowEntry>
        <FlowEntry marker="call" tone="failed">
          <FlowHarnessTask
            harness="Codex"
            prompt="Upgrade the router to v2 and fix every call site."
            repository="site"
            status="failed"
            statusLabel="Timed out"
            duration="30m 00s"
            error="the harness ran past its 30-minute limit"
            open={false}
            onOpenChange={() => {}}
          />
        </FlowEntry>
      </FlowTimeline>
    </div>
  ),
};
