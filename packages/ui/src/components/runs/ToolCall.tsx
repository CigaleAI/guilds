import { cva } from "class-variance-authority";
import { ChevronDown } from "lucide-react";
import { Slot } from "radix-ui";
import { useId, type ComponentProps, type ReactNode } from "react";
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

/** Kinds that change state; the Mutations filter keeps these in focus. */
export const mutatingKinds: ReadonlySet<ToolKind> = new Set([
  "write",
  "memory",
  "execute",
  "act",
  "post",
]);

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

export const toolCall = cva("flex w-full min-w-0 flex-col rounded-lg bg-paper text-left text-fg", {
  variants: {
    dimmed: {
      true: "opacity-40",
      false: "",
    },
    expanded: {
      true: "col-span-full ring-1 ring-rule",
      false: "",
    },
  },
  defaultVariants: { dimmed: false, expanded: false },
});

export type ToolCallProps = Omit<ComponentProps<"div">, "onClick"> & {
  name: string;
  kind: ToolKind;
  level?: ToolLevel | null;
  /** Connected server that served the call, when its name does not already say so. */
  server?: string | null;
  /** Position in its batch, from 1; omit for a call requested alone. */
  index?: number;
  /** One-line summary of the arguments, such as "List schedules" or "cron 0 0 * * *". */
  hint?: string;
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
  /** Makes the summary a button, to expand or inspect it. */
  onClick?: ComponentProps<"button">["onClick"];
  /** Render the child element (a link or button) as the call. */
  asChild?: boolean;
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

/** One tool call the model requested: what it touched, how it ended and how long it took. Opening it keeps the detail in this card. */
export function ToolCall({
  name,
  kind,
  level,
  server,
  index,
  hint,
  status,
  error,
  duration,
  dimmed,
  expanded = false,
  detail,
  onClick,
  asChild,
  className,
  children,
  ...props
}: ToolCallProps) {
  const bodyId = useId();
  const interactive = Boolean(onClick) || Boolean(asChild);
  const showDetail = expanded && detail !== undefined && detail !== null;
  const summary = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        {index !== undefined ? (
          <Tag tone="well" className="size-5 justify-center px-0 py-0">
            {index}
          </Tag>
        ) : null}
        <span className="min-w-0 shrink truncate font-mono text-xs font-medium">{name}</span>
        <Pill fill={toolKindFill[kind]} className="h-4.5 px-2 text-2xs font-bold">
          {kind}
        </Pill>
        {server ? <Tag tone="well">{server}</Tag> : null}
        {level ? (
          <Tag tone="term" className="font-sans">
            {toolLevelLabel[level]}
          </Tag>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-xs text-muted">{hint}</span>
        <Outcome status={status} />
        {duration ? <span className="shrink-0 type-meta text-muted">{duration}</span> : null}
        {interactive ? (
          <Icon
            icon={ChevronDown}
            size={14}
            className={cn("text-muted transition-transform", !expanded && "-rotate-90")}
          />
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
    </>
  );
  const headerClass = cn(
    "flex w-full min-w-0 flex-col gap-1 px-2.5 py-2 text-left",
    interactive &&
      "cursor-pointer transition-colors hover:bg-paper-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
    showDetail ? "rounded-t-lg border-b border-line" : "rounded-lg",
  );
  const frameClass = cn(toolCall({ dimmed: dimmed ?? false, expanded }), className);

  if (asChild) {
    return (
      <Slot.Root className={cn(frameClass, headerClass)} {...props}>
        <Slot.Slottable>{children}</Slot.Slottable>
        {summary}
      </Slot.Root>
    );
  }

  return (
    <article data-expanded={expanded ? "true" : undefined} className={frameClass} {...props}>
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className={headerClass}
          aria-expanded={expanded}
          aria-controls={showDetail ? bodyId : undefined}
        >
          {summary}
        </button>
      ) : (
        <div className={headerClass}>{summary}</div>
      )}
      {showDetail ? (
        <div id={bodyId} className="px-2.5 pt-2.5 pb-3">
          {detail}
        </div>
      ) : null}
    </article>
  );
}
