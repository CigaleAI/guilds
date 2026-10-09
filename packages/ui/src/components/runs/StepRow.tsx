import { ChevronDown } from "lucide-react";
import { Collapsible } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";
import { Tag } from "../../primitives/Tag";
import type { StepOutcome } from "./stepOutcome";

const labelColor: Record<StepOutcome, string> = {
  ok: "text-signal-t",
  wrote: "text-tide-t",
  failed: "text-plum-t",
  running: "text-muted",
};

const dotFill: Record<StepOutcome, string> = {
  ok: "bg-signal",
  wrote: "bg-tide",
  failed: "bg-plum",
  running: "bg-mauve motion-safe:animate-pulse",
};

const outcomeLabel: Record<StepOutcome, string> = {
  ok: "succeeded",
  wrote: "succeeded with changes",
  failed: "failed",
  running: "running",
};

export type StepRowProps = {
  /** Step number within the generation; null for a tool result no step requested. */
  step: number | null;
  outcome: StepOutcome;
  /** Lead sentence, set bold, such as the reasoning's first line. */
  title?: ReactNode;
  /** The rest of the reasoning or message, truncated to one line. */
  detail?: ReactNode;
  /** Model latency, formatted ("4.2s"). */
  duration?: string;
  /** Input plus output tokens, formatted ("14k tok"). */
  tokens?: string;
  /** The model stopped at its max_tokens budget. */
  hitMaxTokens?: boolean;
  /** Faded out by an active generation filter. */
  dimmed?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** What unfolds under the step: its call batch or single call, reasoning, model facts. */
  children?: ReactNode;
  className?: string;
};

/** One model step of a generation, folding open onto the calls it requested. */
export function StepRow({
  step,
  outcome,
  title,
  detail,
  duration,
  tokens,
  hitMaxTokens,
  dimmed,
  open,
  defaultOpen,
  onOpenChange,
  children,
  className,
}: StepRowProps) {
  const expandable = children !== undefined && children !== null;
  const row = (
    <>
      <span
        className={cn(
          "flex shrink-0 items-center gap-1.5 font-mono text-2xs font-medium",
          labelColor[outcome],
        )}
      >
        <span className={cn("size-2 rounded-full", dotFill[outcome])} aria-hidden />
        {step === null ? "RESULT" : `STEP ${step}`}
        <span className="sr-only">{outcomeLabel[outcome]}</span>
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-fg-2">
        {title !== undefined ? <b className="font-bold text-fg">{title}</b> : null}
        {title !== undefined && detail !== undefined ? " " : null}
        {detail}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {hitMaxTokens ? (
          <Tag tone="ochre" title="This step used the full max_tokens budget">
            max tokens
          </Tag>
        ) : null}
        {duration ? (
          <Tag tone="surface" className="text-xs" title="Model latency">
            {duration}
          </Tag>
        ) : null}
        {tokens ? (
          <Tag tone="surface" className="text-xs" title="Input plus output tokens">
            {tokens}
          </Tag>
        ) : null}
        {expandable ? (
          <Icon
            icon={ChevronDown}
            size={14}
            className="transition-transform group-data-[state=closed]/step:-rotate-90"
          />
        ) : null}
      </span>
    </>
  );
  const rowClass =
    "flex w-full min-w-0 items-center gap-3 rounded-lg bg-paper px-3.5 py-2.5 text-left text-fg";

  if (!expandable) {
    return <div className={cn(rowClass, dimmed && "opacity-40", className)}>{row}</div>;
  }

  return (
    <Collapsible.Root
      {...(open !== undefined ? { open } : {})}
      {...(defaultOpen !== undefined ? { defaultOpen } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
      className={cn("group/step flex min-w-0 flex-col gap-2.5", dimmed && "opacity-40", className)}
    >
      <Collapsible.Trigger
        className={cn(rowClass, "cursor-pointer transition-colors hover:bg-paper-hi")}
      >
        {row}
      </Collapsible.Trigger>
      <Collapsible.Content className="pl-5">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}
