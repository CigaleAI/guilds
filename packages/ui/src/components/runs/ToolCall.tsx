import { cva } from "class-variance-authority";
import { ArrowUpRight, ChevronDown, PenLine, Play } from "lucide-react";
import { useId, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import { cn } from "../../cn";
import { ResultGlyph } from "../../primitives/Dot";
import { Icon } from "../../primitives/Icon";
import { Pill } from "../../primitives/Pill";
import { Tag } from "../../primitives/Tag";

/** What a tool call does, as the orchestrator classifies it. */
export type ToolKind =
  "memory" | "read" | "write" | "execute" | "act" | "post" | "connected" | "unknown";

/** Which artifact level a call touched; `all` is a search across every level. */
export type ToolLevel = "local" | "guild" | "org" | "all";

/** Lookups read in cyan, mutations in plum, connected servers in tide. */
export const toolKindFill = {
  memory: "plum-tint",
  read: "signal-tint",
  write: "plum-tint",
  execute: "plum-tint",
  act: "plum-tint",
  post: "plum-tint",
  connected: "tide-tint",
  unknown: "sand",
} as const satisfies Record<ToolKind, "signal-tint" | "plum-tint" | "tide-tint" | "sand">;

export const toolLevelLabel: Record<ToolLevel, string> = {
  local: "local",
  guild: "guild",
  org: "org",
  all: "all levels",
};

export type ToolCallStatus = "ok" | "failed" | "running";

/** What a call did beyond reading: `wrote` changed tracked state, `ran` ran a script. */
export type ToolCallEffect = "wrote" | "ran";

const effectLabel: Record<ToolCallEffect, string> = { wrote: "wrote", ran: "ran script" };

/** A tag saying a call, or a group of calls, wrote tracked state (tide, like the Writes filter) or ran a script. */
export function EffectTag({ effect, className }: { effect: ToolCallEffect; className?: string }) {
  return (
    <Tag tone={effect === "wrote" ? "tide" : "well"} className={cn("gap-1 pl-1.5", className)}>
      <Icon icon={effect === "wrote" ? PenLine : Play} size={14} />
      {effectLabel[effect]}
    </Tag>
  );
}

/** A call's kind and the level it touched, as its open detail lists them. */
export function ToolCallTags({ kind, level }: { kind: ToolKind; level?: ToolLevel | null }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <Pill fill={toolKindFill[kind]} className="h-4.5 px-2 font-mono text-2xs font-bold">
        {kind}
      </Pill>
      {level ? <Tag tone="term">{toolLevelLabel[level]}</Tag> : null}
    </span>
  );
}

export const toolCall = cva("flex w-full min-w-0 flex-col rounded-lg bg-paper text-left text-fg", {
  variants: {
    dimmed: {
      true: "opacity-40",
      false: "",
    },
    expanded: {
      true: "ring-1 ring-rule",
      false: "",
    },
  },
  defaultVariants: { dimmed: false, expanded: false },
});

export type ToolCallProps = Omit<ComponentProps<"article">, "onClick"> & {
  name: string;
  /** A mark before the name, such as the logo of the harness a call runs on. */
  icon?: ReactNode;
  kind: ToolKind;
  /** Connected server that served the call, when its name does not already say so. */
  server?: string | null;
  /** Position among the calls its step requested, from 1; omit for a call requested alone. */
  index?: number;
  /** One-line summary of the arguments, such as "List schedules" or "cron 0 0 * * *". */
  hint?: string;
  /** What the call did beyond reading, as an outlined tag. */
  effect?: ToolCallEffect | null;
  status: ToolCallStatus;
  /** First line of the failure. */
  error?: string;
  /** Run time, formatted ("22ms"). */
  duration?: string;
  /** Faded out by an active generation filter. */
  dimmed?: boolean;
  /** This call is open; its detail sits in the same card, under the summary. */
  expanded?: boolean;
  /** Arguments, result and metadata, shown under the summary while expanded. */
  detail?: ReactNode;
  /** Where what the call touched lives, as a ToolCallLink. */
  link?: ReactNode;
  /** Opens or closes the call; the row and its chevron both call it. */
  onClick?: () => void;
};

function Outcome({ status }: { status: ToolCallStatus }) {
  if (status === "running") {
    return (
      <span
        role="img"
        aria-label="Running"
        className="inline-flex size-4.5 shrink-0 items-center justify-center"
      >
        <span className="size-2 rounded-full bg-signal motion-safe:animate-pulse" />
      </span>
    );
  }
  return <ResultGlyph result={status} />;
}

export type ToolCallLinkProps = ComponentProps<"a">;

/** A chip on a call naming the note, memory or script it touched, and leading there. */
export function ToolCallLink({ className, children, ...props }: ToolCallLinkProps) {
  return (
    <a
      className={cn(
        "inline-flex max-w-48 shrink-0 items-center gap-0.5 rounded-sm px-1.5 py-0.5 font-mono text-2xs text-fg inset-ring inset-ring-line-3 transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
        className,
      )}
      {...props}
    >
      <span className="min-w-0 truncate">{children}</span>
      <Icon icon={ArrowUpRight} size={14} className="text-muted" />
    </a>
  );
}

/** One tool call the model requested: what it touched, how it ended and how long it took. Opening it keeps the detail in this card. */
export function ToolCall({
  name,
  icon,
  kind,
  server,
  index,
  hint,
  effect,
  status,
  error,
  duration,
  dimmed,
  expanded = false,
  detail,
  link,
  onClick,
  className,
  ...props
}: ToolCallProps) {
  const bodyId = useId();
  const showDetail = expanded && detail !== undefined && detail !== null;
  /** Clicks on the summary open the call, unless they land on something that acts on its own. */
  const onSummaryClick = onClick
    ? (event: MouseEvent<HTMLDivElement>) => {
        if ((event.target as Element).closest("a, button")) return;
        onClick();
      }
    : undefined;

  return (
    <article
      data-expanded={expanded ? "true" : undefined}
      className={cn(toolCall({ dimmed: dimmed ?? false, expanded }), className)}
      {...props}
    >
      <div
        onClick={onSummaryClick}
        className={cn(
          "flex min-h-9 w-full min-w-0 flex-col justify-center gap-1 px-3 py-1.5 text-left",
          onClick && "cursor-pointer transition-colors hover:bg-paper-hi",
          showDetail ? "rounded-t-lg border-b border-line" : "rounded-lg",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          {index !== undefined ? (
            <Tag tone="well" className="size-5 justify-center px-0 py-0">
              {index}
            </Tag>
          ) : null}
          {icon}
          <span className="min-w-0 shrink truncate font-mono text-xs font-bold">{name}</span>
          <Pill fill={toolKindFill[kind]} className="h-4.5 px-2 font-mono text-2xs font-bold">
            {kind}
          </Pill>
          {server ? <Tag tone="well">{server}</Tag> : null}
          {effect ? <EffectTag effect={effect} /> : null}
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-2">{hint}</span>
          {link}
          <Outcome status={status} />
          {duration ? <span className="shrink-0 type-meta text-muted">{duration}</span> : null}
          {onClick ? (
            <button
              type="button"
              onClick={onClick}
              aria-expanded={expanded}
              aria-controls={showDetail ? bodyId : undefined}
              aria-label={expanded ? `Close ${name}` : `Open ${name}`}
              className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <Icon
                icon={ChevronDown}
                size={14}
                className={cn("transition-transform", !expanded && "-rotate-90")}
              />
            </button>
          ) : null}
        </span>
        {error ? (
          <span
            className={cn("truncate text-xs text-plum-t", index !== undefined && "pl-7")}
            title={error}
          >
            {error}
          </span>
        ) : null}
      </div>
      {showDetail ? (
        <div id={bodyId} className="px-2.5 pt-2.5 pb-3">
          {detail}
        </div>
      ) : null}
    </article>
  );
}
