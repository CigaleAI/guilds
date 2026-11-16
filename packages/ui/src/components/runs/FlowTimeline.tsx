import { ChevronDown, Layers, Wrench } from "lucide-react";
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
  /** Faded out by an active generation filter. */
  dimmed?: boolean;
  children?: ReactNode;
};

/** One entry on the rail: its mark, level with the entry's first row, then the entry. */
export function FlowEntry({
  marker,
  tone = "ok",
  dimmed,
  className,
  children,
  ...props
}: FlowEntryProps) {
  return (
    <li className={cn("relative flex min-w-0 gap-2", dimmed && "opacity-40", className)} {...props}>
      <span aria-hidden className="flex h-9 w-6 shrink-0 items-center justify-center">
        {marker === "steps" ? (
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
  /** What shows under the note while open: its reasoning and calls, in that order. */
  children?: ReactNode;
};

/**
 * One step: a header naming what its calls did, with cues on them, and what the model said under it.
 * Open, its reasoning and everything it did show below.
 */
export function FlowStepBlock({
  label,
  title,
  note,
  open,
  onOpenChange,
  children,
  ...cues
}: FlowStepBlockProps) {
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
      {open && children ? (
        <div className="flex min-w-0 flex-col gap-1.5 pb-2">{children}</div>
      ) : null}
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
