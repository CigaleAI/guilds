import { Brain, ChevronDown, FolderGit2, Wrench } from "lucide-react";
import { Collapsible } from "radix-ui";
import { Fragment, useState, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";
import { Tag } from "../../primitives/Tag";
import { EffectTag, type ToolCallEffect } from "./ToolCall";

export type FlowTimelineProps = ComponentProps<"ol">;

/** A generation laid out as one line: each entry hangs off a rail, thoughts as brains, calls as wrenches (or their own mark) and answers as dots. */
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

/** How a call entry's wrench reads: settled, still waiting on a call, or holding a failure. */
export type FlowCallTone = "ok" | "running" | "failed";

export type FlowEntryProps = Omit<ComponentProps<"li">, "children"> & {
  marker: "thought" | "call" | "answer";
  /** The wrench's colour on a call entry. */
  tone?: FlowCallTone;
  /** A call entry's own mark in place of the wrench, such as the logo of the harness it runs on. */
  icon?: ReactNode;
  /** Faded out by an active generation filter. */
  dimmed?: boolean;
  children?: ReactNode;
};

/** One entry on the rail: its marker, level with the entry's first row, then the entry. */
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
      <span
        aria-hidden
        className={cn(
          "flex w-6 shrink-0 items-center justify-center",
          marker === "answer" ? "h-11" : "h-9",
        )}
      >
        {marker === "thought" ? (
          <span className="flex size-5 items-center justify-center bg-surface">
            <Icon icon={Brain} size={14} className="text-muted" />
          </span>
        ) : marker === "answer" ? (
          <span className="size-3 rounded-full bg-signal ring-4 ring-surface" />
        ) : icon ? (
          <span className="flex items-center justify-center rounded-md ring-4 ring-surface">
            {icon}
          </span>
        ) : (
          <span className="flex size-5 items-center justify-center bg-surface">
            <Icon
              icon={Wrench}
              size={14}
              className={cn(
                tone === "failed" && "text-plum-t",
                tone === "running" && "text-signal motion-safe:animate-pulse",
                tone === "ok" && "text-muted",
              )}
            />
          </span>
        )}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

/** One figure about a step, with its breakdown on hover. */
export type StepFact = { label: string; title?: string };

function Facts({ facts }: { facts: StepFact[] }) {
  return (
    <span className="flex shrink-0 items-center type-meta text-muted">
      {facts.map((fact, index) => (
        <Fragment key={fact.label}>
          {index > 0 ? (
            <span aria-hidden className="mx-1.5">
              ·
            </span>
          ) : null}
          <span title={fact.title}>{fact.label}</span>
        </Fragment>
      ))}
    </span>
  );
}

export type FlowThoughtProps = {
  /** What the line is, such as "thinking" or "said". */
  label: string;
  /** The line shown folded: the thought's opening, kept to one line. */
  summary: ReactNode;
  /** The step's call count, model time, tokens and cost; on hover, and always while open. */
  facts?: StepFact[];
  /** Why the model stopped, when that deserves a tag, such as "max tokens". */
  stop?: string;
  /** The whole thought; with it, **more** unfolds the line onto it. */
  children?: ReactNode;
  defaultOpen?: boolean;
};

/** What the model thought or said in a step: one line, unfolding onto the whole of it. */
export function FlowThought({
  label,
  summary,
  facts,
  stop,
  children,
  defaultOpen = false,
}: FlowThoughtProps) {
  const [open, setOpen] = useState(defaultOpen);
  const more = children !== undefined && children !== null;
  return (
    <div className="group/thought flex min-w-0 flex-col">
      <div className="flex min-h-9 min-w-0 items-center gap-3">
        <span className="shrink-0 font-mono text-2xs tracking-wider text-muted uppercase">
          {label}
        </span>
        <span className={cn("min-w-0 flex-1 text-sm text-fg-2", !open && "truncate")}>
          {open ? null : summary}
        </span>
        {stop ? (
          <Tag tone="ochre" font="sans">
            {stop}
          </Tag>
        ) : null}
        {facts?.length ? (
          <span
            className={cn(
              "transition-opacity",
              !open &&
                "opacity-0 group-hover/thought:opacity-100 group-focus-within/thought:opacity-100",
            )}
          >
            <Facts facts={facts} />
          </span>
        ) : null}
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

type CallsLineProps = {
  /** The bold lead, such as "2 calls". */
  lead: ReactNode;
  names: readonly string[];
  failed: number;
  effect: ToolCallEffect | null | undefined;
  duration: string | undefined;
  open: boolean;
  onToggle: () => void;
  /** Names the chevron for a screen reader. */
  what: string;
  /** The chevron itself, when a Collapsible owns it. */
  trigger?: (chevron: ReactNode) => ReactNode;
};

/** One folded line of calls: what they were, their tags and time, and a chevron. */
function CallsLine({
  lead,
  names,
  failed,
  effect,
  duration,
  open,
  onToggle,
  what,
  trigger,
}: CallsLineProps) {
  /** Clicks on the row fold it, unless they land on something that acts on its own. */
  const onRowClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest("a, button")) return;
    onToggle();
  };
  const chevron = (
    <Icon
      icon={ChevronDown}
      size={14}
      className={cn("transition-transform", !open && "-rotate-90")}
    />
  );
  return (
    <div
      onClick={onRowClick}
      className="-ml-2 flex h-9 min-w-0 cursor-pointer items-center gap-2 rounded-lg pr-1 pl-2 transition-colors hover:bg-paper"
    >
      <span className="shrink-0 font-mono text-xs font-bold text-fg">{lead}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">
        {names.join(", ")}
      </span>
      {failed > 0 ? <Tag tone="plum">{failed} failed</Tag> : null}
      {effect ? <EffectTag effect={effect} /> : null}
      {duration ? <span className="shrink-0 type-meta text-muted">{duration}</span> : null}
      {trigger ? (
        trigger(chevron)
      ) : (
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? `Fold ${what}` : `Unfold ${what}`}
          onClick={onToggle}
          className={triggerClass}
        >
          {chevron}
        </button>
      )}
    </div>
  );
}

export type FlowCallGroupProps = {
  /** The names of the calls the step requested together, in order. */
  names: string[];
  /** How many of them failed, for the tag. */
  failed?: number;
  /** What the calls did beyond reading: wrote tracked state, or ran a script. */
  effect?: ToolCallEffect | null;
  /** Their summed run time, formatted. */
  duration?: string;
  defaultOpen?: boolean;
  /** The calls, as ToolCall cards. */
  children?: ReactNode;
};

/** The calls a step requested, folded to one line naming them. */
export function FlowCallGroup({
  names,
  failed = 0,
  effect,
  duration,
  defaultOpen = false,
  children,
}: FlowCallGroupProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="flex min-w-0 flex-col gap-1.5">
      <CallsLine
        lead={plural(names.length, "call")}
        names={names}
        failed={failed}
        effect={effect}
        duration={duration}
        open={open}
        onToggle={() => setOpen(!open)}
        what="the calls"
        trigger={(chevron) => (
          <Collapsible.Trigger
            aria-label={open ? "Fold the calls" : "Unfold the calls"}
            className={triggerClass}
          >
            {chevron}
          </Collapsible.Trigger>
        )}
      />
      <Collapsible.Content className="flex flex-col gap-1.5 pb-1">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}

export type FlowStretchProps = {
  /** How many steps called tools in the stretch. */
  steps: number;
  /** The names of the tools they called, each once, in the order first called. */
  names: string[];
  /** How many calls in all. */
  calls: number;
  failed?: number;
  /** What the calls did beyond reading: wrote tracked state, or ran a script. */
  effect?: ToolCallEffect | null;
  /** Their summed run time, formatted. */
  duration?: string;
  /** Whether the stretch's steps show under it, as entries on the same rail. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** The work between two answers, folded to one line: how many calls in how many steps. */
export function FlowStretch({
  steps,
  names,
  calls,
  failed = 0,
  effect,
  duration,
  open,
  onOpenChange,
}: FlowStretchProps) {
  return (
    <CallsLine
      lead={`${plural(calls, "tool call")} in ${plural(steps, "step")}`}
      names={names}
      failed={failed}
      effect={effect}
      duration={duration}
      open={open}
      onToggle={() => onOpenChange(!open)}
      what="these steps"
    />
  );
}

export type FlowAnswerProps = Omit<ComponentProps<"article">, "children"> & {
  /** What the card is, such as "Answer". */
  label?: string;
  /** Who wrote it, usually the agent's name. */
  author?: string;
  /** When it was written, formatted. */
  time?: string;
  /** The same moment as an ISO timestamp, for the time element. */
  dateTime?: string;
  /** Why the model stopped, when that deserves a tag, such as "max tokens". */
  stop?: string;
  /** Right of the header, such as a copy button. */
  actions?: ReactNode;
  /** The text the model wrote, rendered whole. */
  children: ReactNode;
};

/** What the model said to the reader: always whole, never folded or dimmed. */
export function FlowAnswer({
  label = "Answer",
  author,
  time,
  dateTime,
  stop,
  actions,
  children,
  className,
  ...props
}: FlowAnswerProps) {
  return (
    <article
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-xl bg-paper px-5 py-3.5 text-md text-fg inset-ring inset-ring-line-2",
        className,
      )}
      {...props}
    >
      <header className="flex min-w-0 items-center gap-2">
        <span className="text-sm font-bold text-tide-t">{label}</span>
        {author || time ? (
          <span className="min-w-0 truncate type-meta text-muted">
            {author}
            {author && time ? " · " : null}
            {time ? <time {...(dateTime ? { dateTime } : {})}>{time}</time> : null}
          </span>
        ) : null}
        {stop ? (
          <Tag tone="ochre" font="sans">
            {stop}
          </Tag>
        ) : null}
        {actions ? <span className="ml-auto flex shrink-0 items-center">{actions}</span> : null}
      </header>
      <div className="min-w-0">{children}</div>
    </article>
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
