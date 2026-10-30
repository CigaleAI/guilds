import { MessageSquareText, type LucideIcon } from "lucide-react";
import { Fragment, useState } from "react";
import { Button, Checkbox, Tooltip, cn, Icon, MarkSquare, wakeOutcomeLabel } from "@guildsrun/ui";
import {
  chainLines,
  chainMatches,
  clock,
  clockWithDay,
  clockWithSeconds,
  dayLabel,
  formatActivityDuration,
  formatUsd,
  plural,
  stepMatches,
  toMs,
  triggerReasonLabel,
  wakeBucket,
  type ActivityIndex,
  type Chain,
  type ChainStart,
  type ChainStartOf,
  type ChainStep,
  type MapSelection,
} from "./activityModel";
import { AgentMark, AgentName, nodeName, sourceIcon, useWidth, type ActivityData } from "./parts";
import { StepDetail } from "./StepDetail";
import { TriggerDetail } from "./TriggerDetail";

const PAGE = 40;

/** What a chain row has opened: its trigger, or one of its wakes by run id. */
type Opened = { chain: string; target: "start" | string };

type ChainListProps = {
  data: ActivityData;
  selection: MapSelection | null;
  onClear: () => void;
};

/**
 * Every chain of the window, or those the map selection passes through, newest first: one row per
 * chain from what started it through each agent it woke. Clicking the trigger or an agent opens
 * what it carried or did under the row.
 */
export function ChainList({ data, selection, onClear }: ChainListProps) {
  const [hideQuiet, setHideQuiet] = useState(!selection);
  const [shown, setShown] = useState(PAGE);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [measure, width] = useWidth();

  const scoped = data.chains.filter((chain) => chainMatches(chain, selection));
  const quiet = scoped.filter((chain) => chain.quiet).length;
  const listed = hideQuiet ? scoped.filter((chain) => !chain.quiet) : scoped;
  const open = (next: Opened) =>
    setOpened(opened && opened.chain === next.chain && opened.target === next.target ? null : next);

  const page = listed.slice(0, shown);
  const days = page.map((chain) => dayLabel(chain.start.at));
  return (
    <section aria-label="Chains" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h3 className="text-md font-semibold">Chains</h3>
        {selection ? (
          <span className="flex items-center gap-1.5 rounded-full bg-t-sig py-0.5 pr-1 pl-3 text-xs text-t-sig-fg">
            {selection.kind === "link"
              ? `${nodeName(data.index, selection.from)} → ${nodeName(data.index, selection.to)}`
              : nodeName(data.index, selection.id)}
            <Button variant="ghost" size="xs" onClick={onClear}>
              Show all
            </Button>
          </span>
        ) : null}
        <Checkbox
          checked={hideQuiet}
          onCheckedChange={(checked) => setHideQuiet(checked === true)}
          label="Hide chains that produced nothing"
        />
      </div>
      <p className="text-xs text-muted">
        {plural(listed.length, "chain")}, newest first.
        {hideQuiet && quiet
          ? ` ${plural(quiet, "chain")} that produced nothing ${quiet === 1 ? "is" : "are"} hidden.`
          : ""}
      </p>
      {listed.length ? (
        <div ref={measure} className="overflow-x-auto border-t border-line">
          <div className="w-max min-w-full">
            {page.map((chain, position) => {
              const header =
                position === 0 || days[position] !== days[position - 1] ? days[position] : null;
              return (
                <Fragment key={chain.id}>
                  {header ? (
                    <div className="sticky left-0 w-max pt-3 pb-1 type-label text-muted">
                      {header}
                    </div>
                  ) : null}
                  <ChainRow
                    data={data}
                    chain={chain}
                    selection={selection}
                    opened={opened?.chain === chain.id ? opened.target : null}
                    onOpen={(target) => open({ chain: chain.id, target })}
                  />
                  {opened?.chain === chain.id ? (
                    <div
                      className="sticky left-0 border-b border-line bg-paper px-3 pt-1 pb-4"
                      style={{ width: width || undefined }}
                    >
                      {opened.target === "start" ? (
                        <TriggerDetail data={data} chain={chain} onClose={() => setOpened(null)} />
                      ) : (
                        <StepDetail
                          data={data}
                          chain={chain}
                          runId={opened.target}
                          onClose={() => setOpened(null)}
                        />
                      )}
                    </div>
                  ) : null}
                </Fragment>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="rounded-lg bg-paper px-4 py-6 text-center text-sm text-muted">
          {scoped.length
            ? "Every chain here produced nothing. Untick the filter to see them."
            : "No chains in this window."}
        </p>
      )}
      {listed.length > shown ? (
        <Button
          variant="secondary"
          size="sm"
          className="self-center"
          onClick={() => setShown(shown + PAGE)}
        >
          Show {Math.min(PAGE, listed.length - shown)} more of {listed.length - shown}
        </Button>
      ) : null}
    </section>
  );
}

type ChainRowProps = {
  data: ActivityData;
  chain: Chain;
  selection: MapSelection | null;
  opened: string | null;
  onOpen: (target: string) => void;
};

function ChainRow({ data, chain, selection, opened, onOpen }: ChainRowProps) {
  const lines = chainLines(chain);
  const time = (
    <Tooltip
      label={`${clockWithDay(chain.start.at)} · ${plural(chain.wakes, "wake")} · ${formatActivityDuration(chain.end - chain.start.at)} · ${formatUsd(chain.cost)}`}
    >
      <span
        tabIndex={0}
        className="sticky left-0 z-10 flex w-14 shrink-0 items-center self-stretch bg-surface font-mono text-2xs text-muted"
      >
        {clock(chain.start.at)}
      </span>
    </Tooltip>
  );
  return (
    <div className={cn("border-b border-line", opened && "bg-paper")}>
      {lines.map((line, position) => (
        <div key={position} className="flex min-h-10 items-center">
          {position === 0 ? (
            time
          ) : (
            <span className="sticky left-0 z-10 w-14 shrink-0 self-stretch bg-surface" />
          )}
          <div className="flex items-center py-1.5 pr-4">
            {line.lead === "start" ? (
              <TriggerChip
                data={data}
                chain={chain}
                selected={opened === "start"}
                onOpen={() => onOpen("start")}
              />
            ) : (
              <span className="text-xs whitespace-nowrap text-muted">
                {line.lead === "sibling"
                  ? "↳ the same message also woke"
                  : `↳ ${nodeName(data.index, line.from?.wake.agent_id ?? "")}'s post #${line.steps[0]?.post?.seq ?? ""} also woke`}
              </span>
            )}
            {line.steps.map((item) => (
              <Fragment key={item.wake.run_id}>
                <Connector
                  label={triggerReasonLabel(item.wake.trigger)}
                  posted={item.post !== null}
                  matched={
                    selection !== null && selection.kind === "link" && stepMatches(selection, item)
                  }
                />
                <AgentBox
                  data={data}
                  step={item}
                  selected={opened === item.wake.run_id}
                  matched={selection?.kind === "node" && item.wake.agent_id === selection.id}
                  onOpen={() => onOpen(item.wake.run_id)}
                />
              </Fragment>
            ))}
            <span aria-hidden className="ml-2 h-4 w-0.75 shrink-0 rounded-full bg-rule" />
          </div>
        </div>
      ))}
    </div>
  );
}

type ConnectorProps = {
  label: string | null;
  posted: boolean;
  matched: boolean;
};

function Connector({ label, posted, matched }: ConnectorProps) {
  const color = matched ? "bg-signal-t" : posted ? "bg-outcome-posted" : "bg-rule";
  return (
    <span aria-hidden className="relative flex h-6.5 w-10 shrink-0 items-center">
      {label ? (
        <span className="absolute inset-x-0 -top-1.5 text-center font-mono text-[9.5px] leading-none text-muted">
          {label}
        </span>
      ) : null}
      <span className={cn("ml-1 flex-1", matched ? "h-0.75" : "h-px", color)} />
      <span
        className={cn(
          "mr-1 size-0 border-y-4 border-l-[5px] border-y-transparent",
          matched ? "border-l-signal-t" : posted ? "border-l-outcome-posted" : "border-l-rule",
        )}
      />
    </span>
  );
}

const chipClass = (selected: boolean, matched = false) =>
  cn(
    "flex h-6.5 shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-paper px-2 text-xs text-fg-2 hover:bg-paper-hi",
    matched && "ring-1 ring-signal-t",
    selected && "ring-2 ring-signal-t",
  );

type TriggerChipProps = {
  data: ActivityData;
  chain: Chain;
  selected: boolean;
  onOpen: () => void;
};

/** How a chain's start shows as a chip: its words, the hint under the pointer, and its icon. */
type TriggerLook = { label: string; hint: string; icon: LucideIcon };

/** How each kind of start shows as a chip. */
const triggerLooks: {
  [Kind in ChainStart["kind"]]: (
    start: ChainStartOf<Kind>,
    chain: Chain,
    index: ActivityIndex,
  ) => TriggerLook;
} = {
  routine: (start, _chain, index) => {
    const routine = start.scheduleId ? index.routines.get(start.scheduleId) : undefined;
    return {
      label: routine?.description || "A routine no longer listed",
      hint: routine ? `Routine · ${routine.label}` : "Routine",
      icon: sourceIcon.routine,
    };
  },
  operator: (start) => ({
    label: `You · #${start.message.seq}`,
    hint: start.message.preview.slice(0, 160),
    icon: sourceIcon.operator,
  }),
  direct: (_start, chain) => ({
    label: "Direct chat",
    hint: chain.steps[0]?.wake.opening?.slice(0, 160) ?? "A direct chat",
    icon: sourceIcon.direct,
  }),
  earlier: (start, _chain, index) => ({
    label: `${nodeName(index, start.message.author_agent_id ?? "")} · #${start.message.seq}`,
    hint: `A post from before this window: ${start.message.preview.slice(0, 140)}`,
    icon: MessageSquareText,
  }),
  unknown: () => ({
    label: "Unknown message",
    hint: "The message that started this chain isn't in the window",
    icon: sourceIcon.message,
  }),
};

/** How a chain's start of the kind named shows as a chip. */
function triggerLook<Kind extends ChainStart["kind"]>(
  kind: Kind,
  start: ChainStartOf<Kind>,
  chain: Chain,
  index: ActivityIndex,
): TriggerLook {
  return triggerLooks[kind](start, chain, index);
}

function TriggerChip({ data, chain, selected, onOpen }: TriggerChipProps) {
  const { label, hint, icon } = triggerLook(chain.start.kind, chain.start, chain, data.index);
  return (
    <Tooltip label={hint}>
      <button
        type="button"
        aria-expanded={selected}
        onClick={onOpen}
        className={cn(chipClass(selected), "max-w-60 text-fg")}
      >
        <Icon icon={icon} size={14} className="text-muted" />
        <span className="truncate">{label}</span>
      </button>
    </Tooltip>
  );
}

type AgentBoxProps = {
  data: ActivityData;
  step: ChainStep;
  selected: boolean;
  matched: boolean;
  onOpen: () => void;
};

function AgentBox({ data, step, selected, matched, onOpen }: AgentBoxProps) {
  const { wake } = step;
  const agent = data.index.agents.get(wake.agent_id);
  const bucket = wakeBucket(wake);
  const start = toMs(wake.started_at) ?? 0;
  const took = formatActivityDuration((toMs(wake.ended_at) ?? start) - start);
  return (
    <Tooltip
      label={`${agent?.name ?? "agent"} · ${wakeOutcomeLabel[bucket]} · ${clockWithSeconds(start)} · ${took} · ${formatUsd(wake.cost_usd)}`}
    >
      <button
        type="button"
        aria-expanded={selected}
        onClick={onOpen}
        className={chipClass(selected, matched)}
      >
        <AgentMark agent={agent} />
        <AgentName agent={agent} className="text-xs font-medium" />
        <MarkSquare outcome={bucket} className="size-2.5" />
        <span className="font-mono text-2xs text-muted">{took}</span>
      </button>
    </Tooltip>
  );
}
