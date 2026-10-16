import { ChevronDown, FolderGit2, Layers, Wrench } from "lucide-react";
import { Fragment, useState, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";
import { Pill } from "../../primitives/Pill";
import { Tag } from "../../primitives/Tag";
import { EffectTag, toolKindFill, type ToolCallEffect, type ToolKind } from "./ToolCall";

export type FlowTimelineProps = ComponentProps<"ol">;

/** A generation laid out as one line of steps: each hangs off a rail as a dot, and compacted steps as a stack. */
export function FlowTimeline({ className, ...props }: FlowTimelineProps) {
  return (
    <ol
      className={cn(
        "relative flex min-w-0 flex-col gap-1 before:absolute before:inset-y-4 before:left-3 before:w-px before:-translate-x-1/2 before:bg-rule",
        className,
      )}
      {...props}
    />
  );
}

/** How an entry's mark reads: settled, still waiting on a call, or holding a failure. */
export type FlowCallTone = "ok" | "running" | "failed";

const dotTone: Record<FlowCallTone, string> = {
  ok: "bg-muted",
  running: "bg-signal motion-safe:animate-pulse",
  failed: "bg-plum",
};

const iconTone: Record<FlowCallTone, string> = {
  ok: "text-muted",
  running: "text-signal motion-safe:animate-pulse",
  failed: "text-plum-t",
};

export type FlowEntryProps = Omit<ComponentProps<"li">, "children"> & {
  /** One step as a dot, or several compacted steps as a stack. */
  marker: "step" | "steps";
  /** The mark's colour. */
  tone?: FlowCallTone;
  /** A step's own mark in place of the dot, such as the logo of the harness its code task runs on. */
  icon?: ReactNode;
  /** Faded out by an active generation filter. */
  dimmed?: boolean;
  children?: ReactNode;
};

/** One entry on the rail: its mark, level with the entry's first row, then the entry. */
export function FlowEntry({
  marker,
  tone = "ok",
  icon,
  dimmed,
  className,
  children,
  ...props
}: FlowEntryProps) {
  return (
    <li className={cn("relative flex min-w-0 gap-2", dimmed && "opacity-40", className)} {...props}>
      <span aria-hidden className="flex h-9 w-6 shrink-0 items-center justify-center">
        {icon ? (
          <span className="flex items-center justify-center rounded-md ring-4 ring-surface">
            {icon}
          </span>
        ) : marker === "steps" ? (
          <span className="flex size-5 items-center justify-center bg-surface">
            <Icon icon={Layers} size={14} className={iconTone[tone]} />
          </span>
        ) : (
          <span className={cn("size-2.5 rounded-full ring-4 ring-surface", dotTone[tone])} />
        )}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

/** One figure about a step, with its breakdown on hover. */
export type StepFact = { label: string; title?: string };

export type FlowThoughtProps = {
  /** What the line is, such as "thinking". */
  label: string;
  /** The line shown folded: the thought's opening, kept to one line. */
  summary: ReactNode;
  /** The whole thought; with it, **more** unfolds the line onto it. */
  children?: ReactNode;
  defaultOpen?: boolean;
};

/** What the model thought in a step: one line, unfolding onto the whole of it. */
export function FlowThought({ label, summary, children, defaultOpen = false }: FlowThoughtProps) {
  const [open, setOpen] = useState(defaultOpen);
  const more = children !== undefined && children !== null;
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex min-h-9 min-w-0 items-center gap-3">
        <span className="shrink-0 font-mono text-2xs tracking-wider text-muted uppercase">
          {label}
        </span>
        <span className={cn("min-w-0 flex-1 text-sm text-fg-2", !open && "truncate")}>
          {open ? null : summary}
        </span>
        {more ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="shrink-0 cursor-pointer rounded-sm px-1 font-mono text-2xs text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {open ? "less" : "more"}
          </button>
        ) : null}
      </div>
      {open && more ? <div className="pb-2">{children}</div> : null}
    </div>
  );
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const triggerClass =
  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

/** What a step's calls did, for its header without naming them. */
export type FlowStepCues = {
  /** The kinds of its calls, each once, such as read or write. */
  kinds: readonly ToolKind[];
  /** Whether a call wrote tracked state or ran a script. */
  effect?: ToolCallEffect | null;
  /** How many calls failed. */
  failed?: number;
  /** How many calls in all. */
  calls: number;
  /** The time it took, with its breakdown on hover. */
  duration?: StepFact;
  /** Tokens and cost, shown on hover. */
  facts?: StepFact[];
  /** Why the model stopped, when that deserves a tag, such as "max tokens". */
  stop?: string;
};

type StepLineProps = FlowStepCues & {
  /** What leads the line: what the step's calls did, or how many steps. */
  lead: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** Names the chevron for a screen reader. */
  what: string;
  className?: string | undefined;
};

/** A step's header: what leads it, then cues on what its calls did, their count and time, and a chevron. */
function StepLine({
  lead,
  kinds,
  effect,
  failed = 0,
  calls,
  duration,
  facts,
  stop,
  open,
  onToggle,
  what,
  className,
}: StepLineProps) {
  /** Clicks on the row fold it, unless they land on something that acts on its own. */
  const onRowClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest("a, button")) return;
    onToggle();
  };
  return (
    <div
      onClick={onRowClick}
      className={cn(
        "group/step flex h-9 min-w-0 cursor-pointer items-center gap-2 pr-1",
        className,
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-3">{lead}</span>
      {stop ? (
        <Tag tone="ochre" font="sans">
          {stop}
        </Tag>
      ) : null}
      {kinds.map((kind) => (
        <Pill
          key={kind}
          fill={toolKindFill[kind]}
          className="h-4.5 shrink-0 px-2 font-mono text-2xs font-bold"
        >
          {kind}
        </Pill>
      ))}
      {effect ? <EffectTag effect={effect} /> : null}
      {failed > 0 ? <Tag tone="plum">{failed} failed</Tag> : null}
      <span className="flex shrink-0 items-center type-meta text-muted">
        {facts?.map((fact) => (
          <span
            key={fact.label}
            title={fact.title}
            className="mr-1.5 hidden group-hover/step:inline group-focus-within/step:inline"
          >
            {fact.label} ·
          </span>
        ))}
        <span title={plural(calls, "tool call")} className="flex items-center gap-0.5">
          <Icon icon={Wrench} size={14} />
          {calls}
        </span>
        {duration ? (
          <Fragment>
            <span aria-hidden className="mx-1.5">
              ·
            </span>
            <span title={duration.title}>{duration.label}</span>
          </Fragment>
        ) : null}
      </span>
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? `Fold ${what}` : `Unfold ${what}`}
        onClick={onToggle}
        className={triggerClass}
      >
        <Icon
          icon={ChevronDown}
          size={14}
          className={cn("transition-transform", !open && "-rotate-90")}
        />
      </button>
    </div>
  );
}

const leadLabel = "shrink-0 font-mono text-2xs tracking-wider uppercase";

export type FlowStepBlockProps = FlowStepCues & {
  /** The step's name, such as "Step 3", which prefixes its header while open. */
  label: string;
  /** What its calls did, such as "Read a.md, b.md · Run ls": its header. */
  title: ReactNode;
  /** What the model said alongside its calls: two lines while folded, whole while open. */
  note?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What shows under the note while folded: its code tasks. */
  outputs?: ReactNode;
  /** What shows under the note while open: its reasoning, calls and code tasks, in that order. */
  children?: ReactNode;
};

/**
 * One step: a header naming what its calls did, with cues on them, and what the model said under it.
 * Folded, only its code tasks show below; open, its reasoning and everything it did.
 */
export function FlowStepBlock({
  label,
  title,
  note,
  open,
  onOpenChange,
  outputs,
  children,
  ...cues
}: FlowStepBlockProps) {
  const body = open ? children : outputs;
  return (
    <section aria-label={label} className="flex min-w-0 flex-col">
      <StepLine
        {...cues}
        lead={
          <>
            {open ? <span className={cn(leadLabel, "text-muted")}>{label}</span> : null}
            <span className="min-w-0 truncate text-sm text-fg">{title}</span>
          </>
        }
        open={open}
        onToggle={() => onOpenChange(!open)}
        what={label}
      />
      {note ? (
        <div data-note="" className={cn("min-w-0 pb-2 text-sm text-fg-2", !open && "line-clamp-2")}>
          {note}
        </div>
      ) : null}
      {body ? <div className="flex min-w-0 flex-col gap-1.5 pb-2">{body}</div> : null}
    </section>
  );
}

export type FlowBatchProps = {
  /** The calls, as ToolCall cards numbered in the order they ran. */
  children: ReactNode;
};

/**
 * Calls a step requested together, held by one bracket: the model asked for them in one turn, and
 * they ran one after another with no model turn between them.
 */
export function FlowBatch({ children }: FlowBatchProps) {
  return (
    <div className="relative flex min-w-0 flex-col gap-1.5 pl-3 before:absolute before:inset-y-2 before:left-0 before:w-1.5 before:rounded-l-md before:border-y-2 before:border-l-2 before:border-rule-2">
      {children}
    </div>
  );
}

export type FlowStepRunProps = FlowStepCues & {
  /** How many steps it compacts. */
  steps: number;
  /** Whether it shows its steps, framed under its header. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Its steps, as a FlowTimeline of FlowStepBlocks. */
  children?: ReactNode;
};

/**
 * Consecutive steps that produced nothing but calls, compacted to one header (how many steps, and
 * cues on what their calls did); open, it frames them on a rail of their own.
 */
export function FlowStepRun({ steps, open, onOpenChange, children, ...cues }: FlowStepRunProps) {
  return (
    <div className={cn("flex min-w-0 flex-col", open && "rounded-xl inset-ring inset-ring-line-2")}>
      <StepLine
        {...cues}
        className={open ? "pl-3" : undefined}
        lead={<span className="font-mono text-xs font-bold text-fg">{plural(steps, "step")}</span>}
        open={open}
        onToggle={() => onOpenChange(!open)}
        what="these steps"
      />
      {open && children ? (
        <div className="min-w-0 border-t border-line px-2 pt-2 pb-2">{children}</div>
      ) : null}
    </div>
  );
}

/** Where a harness task stands. */
export type FlowHarnessStatus = "running" | "done" | "failed";

const harnessStatusLook: Record<FlowHarnessStatus, { pill: string; dot: string }> = {
  running: { pill: "bg-t-sig text-t-sig-fg", dot: "bg-signal motion-safe:animate-pulse" },
  done: { pill: "bg-t-tide text-t-tide-fg", dot: "bg-tide" },
  failed: { pill: "bg-t-plum text-plum-t", dot: "bg-plum" },
};

export type FlowHarnessTaskProps = Omit<ComponentProps<"article">, "children"> & {
  /** The harness's name, such as "Codex". */
  harness: string;
  /** What the agent asked the harness to do. */
  prompt: string;
  /** The repository the harness works in. */
  repository?: string;
  status: FlowHarnessStatus;
  /** How the status reads, such as "Running…", "Done", or "Timed out". */
  statusLabel: string;
  /** What it changed, such as "9 files · +1559 −0". */
  changes?: string;
  /** Whether it changed tracked state, for the **wrote** tag. */
  effect?: ToolCallEffect | null;
  /** Its run time, formatted. */
  duration?: string;
  /** The first line of a failure. */
  error?: string;
  /** What it has reported while running, under the prompt. */
  progress?: ReactNode;
  /** Arguments, result, metadata, diff and log, while open. */
  detail?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * A task delegated to the coding harness, as its own block on the rail: the harness, what it was
 * asked, where it works, how it ended and what it changed; opening it shows its detail.
 */
export function FlowHarnessTask({
  harness,
  prompt,
  repository,
  status,
  statusLabel,
  changes,
  effect,
  duration,
  error,
  progress,
  detail,
  open,
  onOpenChange,
  className,
  ...props
}: FlowHarnessTaskProps) {
  const look = harnessStatusLook[status];
  /** Clicks on the card's head open it, unless they land on something that acts on its own. */
  const onHeadClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest("a, button")) return;
    onOpenChange(!open);
  };
  return (
    <article
      className={cn(
        "flex min-w-0 flex-col rounded-xl bg-paper text-fg inset-ring inset-ring-line-2",
        className,
      )}
      {...props}
    >
      <div
        onClick={onHeadClick}
        className="flex min-w-0 cursor-pointer flex-col gap-2 rounded-xl px-4 py-3 transition-colors hover:bg-paper-hi"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-sm font-bold">{harness}</span>
          <span className="shrink-0 type-meta text-muted">coding task</span>
          <span
            className={cn(
              "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-2xs font-semibold",
              look.pill,
            )}
          >
            <span aria-hidden className={cn("size-1.5 rounded-full", look.dot)} />
            {statusLabel}
          </span>
          {effect ? <EffectTag effect={effect} /> : null}
          <span className="flex-1" />
          {duration ? <span className="shrink-0 type-meta text-muted">{duration}</span> : null}
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? `Close the ${harness} task` : `Open the ${harness} task`}
            onClick={() => onOpenChange(!open)}
            className={triggerClass}
          >
            <Icon
              icon={ChevronDown}
              size={14}
              className={cn("transition-transform", !open && "-rotate-90")}
            />
          </button>
        </div>
        <p className="line-clamp-2 text-sm whitespace-pre-wrap text-fg-2">{prompt}</p>
        {repository || changes ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-muted">
            {repository ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <Icon icon={FolderGit2} size={14} />
                <span className="truncate">{repository}</span>
              </span>
            ) : null}
            {changes ? <span className="shrink-0">{changes}</span> : null}
          </div>
        ) : null}
        {error ? (
          <span className="truncate text-xs text-plum-t" title={error}>
            {error}
          </span>
        ) : null}
      </div>
      {progress && !open ? <div className="px-4 pb-3">{progress}</div> : null}
      {open && detail ? <div className="border-t border-line px-4 pt-3 pb-4">{detail}</div> : null}
    </article>
  );
}
