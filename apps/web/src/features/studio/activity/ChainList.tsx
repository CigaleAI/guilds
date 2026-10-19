import { Link } from "@tanstack/react-router";
import {
  Bookmark,
  CircleX,
  Code,
  Database,
  ExternalLink,
  FileText,
  Flag,
  GitBranch,
  History,
  MessageSquareText,
  Pin,
  Quote,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import {
  Button,
  IconButton,
  Checkbox,
  Tooltip,
  cn,
  Icon,
  MarkSquare,
  wakeOutcomeLabel,
} from "@guildsrun/ui";
import { useStudio } from "../StudioContext";
import {
  chainLines,
  chainMatches,
  clock,
  dayLabel,
  formatActivityDuration,
  formatUsd,
  plural,
  stepMatches,
  tally,
  toMs,
  wakeBucket,
  wakeEffects,
  type Chain,
  type ChainStep,
  type MapSelection,
  type WriteGroup,
} from "./activityModel";
import {
  AgentMark,
  AgentName,
  nodeName,
  reasonLabel,
  sourceIcon,
  useWidth,
  type ActivityData,
} from "./parts";

const PAGE = 40;

/** What a chain row has opened: its trigger, or one of its wakes by run id. */
type Opened = { chain: string; target: "start" | string };

/**
 * Every chain of the window, or those the map selection passes through, newest first: one row per
 * chain from what started it through each agent it woke. Clicking the trigger or an agent opens
 * what it carried or did under the row.
 */
export function ChainList({
  data,
  selection,
  onClear,
}: {
  data: ActivityData;
  selection: MapSelection | null;
  onClear: () => void;
}) {
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

function ChainRow({
  data,
  chain,
  selection,
  opened,
  onOpen,
}: {
  data: ActivityData;
  chain: Chain;
  selection: MapSelection | null;
  opened: string | null;
  onOpen: (target: string) => void;
}) {
  const lines = chainLines(chain);
  const time = (
    <Tooltip
      label={`${clock(chain.start.at, { day: true })} · ${plural(chain.wakes, "wake")} · ${formatActivityDuration(chain.end - chain.start.at)} · ${formatUsd(chain.cost)}`}
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
                  label={
                    item.wake.trigger.type === "message"
                      ? reasonLabel[item.wake.trigger.reason]
                      : null
                  }
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

function Connector({
  label,
  posted,
  matched,
}: {
  label: string | null;
  posted: boolean;
  matched: boolean;
}) {
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

function TriggerChip({
  data,
  chain,
  selected,
  onOpen,
}: {
  data: ActivityData;
  chain: Chain;
  selected: boolean;
  onOpen: () => void;
}) {
  const { start } = chain;
  const { index } = data;
  let label: string;
  let hint: string;
  let icon: LucideIcon = sourceIcon.message;
  if (start.kind === "routine") {
    const routine = start.scheduleId ? index.routines.get(start.scheduleId) : undefined;
    label = routine?.description || "A routine no longer listed";
    hint = routine ? `Routine · ${routine.label}` : "Routine";
    icon = sourceIcon.routine;
  } else if (start.kind === "operator") {
    label = `You · #${start.message.seq}`;
    hint = start.message.preview.slice(0, 160);
    icon = sourceIcon.operator;
  } else if (start.kind === "direct") {
    label = "Direct chat";
    hint = chain.steps[0]?.wake.opening?.slice(0, 160) ?? "A direct chat";
    icon = sourceIcon.direct;
  } else if (start.kind === "earlier") {
    label = `${nodeName(index, start.message.author_agent_id ?? "")} · #${start.message.seq}`;
    hint = `A post from before this window: ${start.message.preview.slice(0, 140)}`;
    icon = MessageSquareText;
  } else {
    label = "Unknown message";
    hint = "The message that started this chain isn't in the window";
  }
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

function AgentBox({
  data,
  step,
  selected,
  matched,
  onOpen,
}: {
  data: ActivityData;
  step: ChainStep;
  selected: boolean;
  matched: boolean;
  onOpen: () => void;
}) {
  const { wake } = step;
  const agent = data.index.agents.get(wake.agent_id);
  const bucket = wakeBucket(wake);
  const start = toMs(wake.started_at) ?? 0;
  const took = formatActivityDuration((toMs(wake.ended_at) ?? start) - start);
  return (
    <Tooltip
      label={`${agent?.name ?? "agent"} · ${wakeOutcomeLabel[bucket]} · ${clock(start, { seconds: true })} · ${took} · ${formatUsd(wake.cost_usd)}`}
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

/* ---------- Details ---------- */

function DetailHead({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2">
      {children}
      <IconButton
        icon={X}
        label="Close"
        variant="ghost"
        size={28}
        className="ml-auto"
        onClick={onClose}
      />
    </div>
  );
}

function Section({
  title,
  highlighted,
  children,
}: {
  title: string;
  highlighted?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-md",
        highlighted && "-m-2 p-2 ring-2 ring-signal-t",
      )}
    >
      <h4 className="type-label text-muted">{title}</h4>
      {children}
    </section>
  );
}

function Quoted({ children }: { children: string }) {
  return (
    <p className="max-h-56 overflow-y-auto rounded-md bg-surface px-3 py-2 font-mono text-xs whitespace-pre-wrap text-fg-2 [overflow-wrap:anywhere]">
      {children}
    </p>
  );
}

function TriggerDetail({
  data,
  chain,
  onClose,
}: {
  data: ActivityData;
  chain: Chain;
  onClose: () => void;
}) {
  const { go, openStep, session } = useStudio();
  const { start } = chain;
  const { index } = data;
  const first = chain.steps[0]?.wake;
  if (start.kind === "routine") {
    const routine = start.scheduleId ? index.routines.get(start.scheduleId) : undefined;
    return (
      <div className="flex max-w-3xl flex-col gap-2">
        <DetailHead onClose={onClose}>
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Icon icon={sourceIcon.routine} size={16} className="text-muted" />
            {routine?.description || "A routine no longer listed"}
          </span>
          <span className="text-xs text-muted">
            {[routine?.label, `fired ${clock(start.at, { day: true })}`]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {routine ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() =>
                go({
                  section: "agents",
                  agent: routine.agent_id,
                  tab: "routines",
                  item: routine.id,
                })
              }
            >
              Open routine
            </Button>
          ) : null}
        </DetailHead>
        <Section title="Instruction">
          {routine?.instruction ? (
            <Quoted>{routine.instruction}</Quoted>
          ) : (
            <p className="text-xs text-muted">Not listed any more.</p>
          )}
        </Section>
      </div>
    );
  }
  if (start.kind === "direct") {
    return (
      <div className="flex max-w-3xl flex-col gap-2">
        <DetailHead onClose={onClose}>
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Icon icon={sourceIcon.direct} size={16} className="text-muted" />
            Direct chat with {nodeName(index, first?.agent_id ?? "")}
          </span>
          <span className="text-xs text-muted">{clock(start.at, { day: true })}</span>
          {first ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() => openStep({ agentId: first.agent_id, runId: first.run_id })}
            >
              <Icon icon={History} size={14} />
              Open in History
            </Button>
          ) : null}
        </DetailHead>
        <Section title="Opening message">
          {first?.opening ? (
            <Quoted>{first.opening}</Quoted>
          ) : (
            <p className="text-xs text-muted">Not in this window.</p>
          )}
        </Section>
      </div>
    );
  }
  const message = start.kind === "operator" || start.kind === "earlier" ? start.message : null;
  return (
    <div className="flex max-w-3xl flex-col gap-2">
      <DetailHead onClose={onClose}>
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Icon
            icon={start.kind === "operator" ? sourceIcon.operator : MessageSquareText}
            size={16}
            className="text-muted"
          />
          {start.kind === "operator"
            ? `Your message #${start.message.seq}`
            : start.kind === "earlier"
              ? `${start.message.author_name}'s post #${start.message.seq}, from before this window`
              : "A message outside the window"}
        </span>
        <span className="text-xs text-muted">
          {[
            clock(start.at, { day: true }),
            message?.tagged.length
              ? `tagged ${message.tagged.map((name) => `@${name}`).join(" ")}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {start.kind === "operator" ? (
          <Button asChild variant="outline" size="xs">
            <Link to="/guilds/$guildId" params={{ guildId: session.source_guild_id }}>
              <Icon icon={ExternalLink} size={14} />
              Open group chat
            </Link>
          </Button>
        ) : start.kind === "earlier" &&
          start.message.source_run_id &&
          start.message.author_agent_id ? (
          <Button
            variant="outline"
            size="xs"
            onClick={() =>
              start.message.source_run_id &&
              start.message.author_agent_id &&
              openStep({
                agentId: start.message.author_agent_id,
                runId: start.message.source_run_id,
              })
            }
          >
            <Icon icon={History} size={14} />
            Open the post
          </Button>
        ) : null}
      </DetailHead>
      {message ? (
        <Section title="Message">
          <Quoted>{message.preview}</Quoted>
          {message.length > message.preview.length ? (
            <span className="text-xs text-muted">
              Shortened here; the group chat has all of it.
            </span>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}

type SectionKey = "tools" | "effects" | "errors" | "output";

function writeLine(group: WriteGroup, label: string) {
  const operations = Object.entries(group.operations)
    .map(
      ([operation, count]) =>
        `${count} ${operation === "create" ? "created" : operation === "update" ? "updated" : operation}`,
    )
    .join(", ");
  const ids = group.ids.length
    ? ` · #${group.ids.slice(0, 8).join(", #")}${group.ids.length > 8 ? ` +${group.ids.length - 8}` : ""}`
    : "";
  return (
    <>
      {label} <span className="font-mono text-fg">{group.target}</span>
      <span className="text-muted">
        {" "}
        · {operations}
        {ids}
      </span>
    </>
  );
}

function StepDetail({
  data,
  chain,
  runId,
  onClose,
}: {
  data: ActivityData;
  chain: Chain;
  runId: string;
  onClose: () => void;
}) {
  const { openStep, ask } = useStudio();
  const [section, setSection] = useState<SectionKey | null>(null);
  const { index } = data;
  const step = findStep(chain.steps, runId);
  if (!step) return null;
  const { wake } = step;
  const agent = index.agents.get(wake.agent_id);
  const bucket = wakeBucket(wake);
  const effects = wakeEffects(wake);
  const start = toMs(wake.started_at) ?? 0;
  const end = toMs(wake.ended_at) ?? start;
  const open = (call: string | null) =>
    openStep({ agentId: wake.agent_id, runId: wake.run_id, call });
  const reason = wake.trigger.type === "message" ? reasonLabel[wake.trigger.reason] : null;
  const wokenBy = step.post
    ? `woken by ${nodeName(index, step.from)}'s post #${step.post.seq}${reason ? ` (${reason})` : ""}`
    : chain.start.kind === "routine"
      ? `woken by ${nodeName(index, chain.source)}`
      : chain.start.kind === "direct"
        ? "woken by a direct chat"
        : chain.start.kind === "operator"
          ? `woken by your message #${chain.start.message.seq}${reason ? ` (${reason})` : ""}`
          : "woken by an earlier message";
  const errors = tally([
    ...wake.errors.map((error) => `${error.operation ?? "error"}: ${error.message ?? "unknown"}`),
    ...effects.failedCalls.map((call) => `${call.name}: ${call.error ?? ""}`),
  ]);

  const chips: Array<{
    key: SectionKey;
    icon: LucideIcon;
    count: string;
    hint: string;
    tone?: "error" | "post";
  }> = [];
  if (effects.calls.length)
    chips.push({
      key: "tools",
      icon: Wrench,
      count: String(effects.calls.length),
      hint: plural(effects.calls.length, "tool call"),
    });
  const recordWrites = effects.records.reduce((sum, group) => sum + group.count, 0);
  if (recordWrites)
    chips.push({
      key: "effects",
      icon: Database,
      count: String(recordWrites),
      hint: plural(recordWrites, "record write"),
    });
  const noteWrites = effects.notes.reduce((sum, group) => sum + group.count, 0);
  if (noteWrites)
    chips.push({
      key: "effects",
      icon: FileText,
      count: String(noteWrites),
      hint: plural(noteWrites, "note write"),
    });
  const scripts =
    effects.scriptRuns.reduce((sum, run) => sum + run.count, 0) +
    effects.scripts.reduce((sum, group) => sum + group.count, 0);
  if (scripts)
    chips.push({
      key: "effects",
      icon: Code,
      count: String(scripts),
      hint: "Scripts run or changed",
    });
  const codeFiles = effects.code.reduce((sum, write) => sum + (write.code?.files_changed ?? 0), 0);
  if (codeFiles)
    chips.push({
      key: "effects",
      icon: GitBranch,
      count: String(codeFiles),
      hint: `${plural(codeFiles, "file")} changed in ${plural(effects.code.length, "repository", "repositories")}`,
    });
  if (effects.issues.length)
    chips.push({
      key: "effects",
      icon: Flag,
      count: String(effects.issues.length),
      hint: plural(effects.issues.length, "issue") + " reported",
    });
  if (effects.memory)
    chips.push({ key: "effects", icon: Bookmark, count: "", hint: "Updated its memory" });
  const errorCount = errors.reduce((sum, item) => sum + item.count, 0);
  if (errorCount)
    chips.push({
      key: "errors",
      icon: CircleX,
      count: String(errorCount),
      hint: plural(errorCount, "error"),
      tone: "error",
    });
  if (!wake.posts.length && wake.reply)
    chips.push({ key: "output", icon: Quote, count: "", hint: "Its last reply, not posted" });
  for (const post of wake.posts)
    chips.push({
      key: "output",
      icon: MessageSquareText,
      count: `#${post.seq}`,
      hint: `Posted #${post.seq}`,
      tone: "post",
    });

  return (
    <div className="flex flex-col gap-3">
      <DetailHead onClose={onClose}>
        <span className="flex items-center gap-2 text-sm font-semibold">
          <AgentMark agent={agent} size={20} />
          <AgentName agent={agent} />
        </span>
        <span className="flex items-center gap-1.5 text-xs text-fg-2">
          <MarkSquare outcome={bucket} className="size-2.5" />
          {wakeOutcomeLabel[bucket]}
        </span>
        <span className="font-mono text-2xs text-muted">
          {clock(start, { seconds: true })}–{clock(end, { seconds: true })} ·{" "}
          {formatActivityDuration(end - start)} · {formatUsd(wake.cost_usd)}
        </span>
        <span className="text-xs text-muted">{wokenBy}</span>
        <span className="flex gap-2">
          <Button size="xs" onClick={() => open(null)}>
            <Icon icon={History} size={14} />
            Open in History
          </Button>
          <Button
            variant="outline"
            size="xs"
            onClick={() =>
              ask({
                kind: "run",
                agent_id: wake.agent_id,
                run_id: wake.run_id,
                label: `${agent?.name ?? "agent"} · ${clock(start, { day: true })}`,
              })
            }
          >
            <Icon icon={Pin} size={14} />
            Ask the coach
          </Button>
        </span>
      </DetailHead>
      {chips.length ? (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((chip, position) => (
            <Tooltip key={position} label={chip.hint}>
              <button
                type="button"
                onClick={() => setSection(section === chip.key ? null : chip.key)}
                className={cn(
                  "flex h-6 cursor-pointer items-center gap-1 rounded-sm bg-surface px-2 text-xs text-fg-2 hover:bg-well",
                  chip.tone === "error" && "text-outcome-failed",
                  section === chip.key && "ring-1 ring-signal-t",
                )}
              >
                <Icon
                  icon={chip.icon}
                  size={14}
                  className={chip.tone === "post" ? "text-outcome-posted" : undefined}
                />
                {chip.count ? <span className="tabular-nums">{chip.count}</span> : null}
              </button>
            </Tooltip>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted">It called no tools and changed nothing.</p>
      )}
      <div className="grid gap-x-6 gap-y-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <Section title={`Tool calls · ${wake.tool_call_count}`} highlighted={section === "tools"}>
          {wake.tool_calls.length ? (
            <ol className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
              {wake.tool_calls.map((call, position) => (
                <li key={call.call_id ?? position}>
                  <button
                    type="button"
                    title={call.arguments}
                    onClick={() => open(call.call_id)}
                    className="grid w-full cursor-pointer grid-cols-[1.5rem_auto_minmax(0,1fr)_auto] items-baseline gap-2 rounded-sm px-1 py-0.5 text-left text-xs hover:bg-surface"
                  >
                    <span className="text-right font-mono text-2xs text-faint">{position + 1}</span>
                    <span className="font-mono font-medium text-fg">{call.name}</span>
                    <span className="truncate font-mono text-2xs text-muted">{call.arguments}</span>
                    <span className="font-mono text-2xs text-faint">
                      {call.duration_ms !== null ? `${call.duration_ms}ms` : ""}
                    </span>
                    {call.error ? (
                      <span className="col-start-2 col-end-5 text-outcome-failed">
                        {call.error}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
              {wake.tool_call_count > wake.tool_calls.length ? (
                <li className="px-1 text-2xs text-muted">
                  The first {wake.tool_calls.length} of {wake.tool_call_count}; History has them
                  all.
                </li>
              ) : null}
            </ol>
          ) : (
            <p className="text-xs text-muted">No tool calls.</p>
          )}
        </Section>
        <div className="flex min-w-0 flex-col gap-4">
          <Section title="Side effects" highlighted={section === "effects"}>
            {[
              ...effects.records.map((group) => ({ group, label: "Records in" })),
              ...effects.notes.map((group) => ({ group, label: "Note" })),
              ...effects.scripts.map((group) => ({ group, label: "Script" })),
            ].map(({ group, label }) => (
              <button
                key={`${group.kind}:${group.target}`}
                type="button"
                onClick={() => open(group.first.call_id)}
                className="cursor-pointer rounded-sm px-1 text-left text-xs text-fg-2 hover:bg-surface"
              >
                {writeLine(group, label)}
              </button>
            ))}
            {effects.code.map((write) => (
              <span key={`code:${write.target}`} className="px-1 text-xs text-fg-2">
                Changed <span className="font-mono text-fg">{write.target}</span>
                <span className="text-muted">
                  {" "}
                  · {plural(write.code?.files_changed ?? 0, "file")}, +{write.code?.insertions ?? 0}{" "}
                  −{write.code?.deletions ?? 0}
                  {write.code?.branch ? ` on ${write.code.branch}` : ""}
                </span>
              </span>
            ))}
            {effects.scriptRuns.map((run) => (
              <span key={run.value} className="px-1 text-xs text-fg-2">
                Ran script <span className="font-mono text-fg">{run.value}</span>
                {run.count > 1 ? ` ×${run.count}` : ""}
              </span>
            ))}
            {effects.issues.map((issue, position) => (
              <span key={position} className="px-1 text-xs text-fg-2">
                Reported an issue: {issue}
              </span>
            ))}
            {effects.memory ? (
              <span className="px-1 text-xs text-muted">Updated its memory</span>
            ) : null}
            {!effects.records.length &&
            !effects.notes.length &&
            !effects.scripts.length &&
            !effects.code.length &&
            !effects.scriptRuns.length &&
            !effects.issues.length &&
            !effects.memory ? (
              <p className="px-1 text-xs text-muted">None.</p>
            ) : null}
          </Section>
          {errors.length ? (
            <Section title="Errors" highlighted={section === "errors"}>
              {errors.map((error) => (
                <span key={error.value} className="px-1 text-xs text-outcome-failed">
                  {error.value}
                  {error.count > 1 ? ` ×${error.count}` : ""}
                </span>
              ))}
            </Section>
          ) : null}
        </div>
        <Section title="Output" highlighted={section === "output"}>
          {wake.posts.map((post) => {
            const message = index.messages.get(post.seq);
            const woke = step.next.filter((next) => next.post?.seq === post.seq);
            return (
              <div key={post.seq} className="flex flex-col gap-1">
                <span className="flex flex-wrap items-center gap-1.5 text-xs text-fg-2">
                  Posted #{post.seq}
                  {woke.length ? (
                    <>
                      <span className="text-muted">· woke</span>
                      {woke.map((next) => (
                        <span key={next.wake.run_id} className="flex items-center gap-1">
                          <AgentMark agent={index.agents.get(next.wake.agent_id)} size={14} />
                          <AgentName agent={index.agents.get(next.wake.agent_id)} />
                        </span>
                      ))}
                    </>
                  ) : (
                    <span className="text-muted">· woke nobody</span>
                  )}
                  <Button variant="ghost" size="xs" onClick={() => open(post.call_id)}>
                    Open step
                  </Button>
                </span>
                {message ? <Quoted>{message.preview}</Quoted> : null}
              </div>
            );
          })}
          {!wake.posts.length && wake.reply ? (
            <>
              <span className="text-xs text-muted">Its last reply, not posted to the group:</span>
              <Quoted>{wake.reply}</Quoted>
            </>
          ) : null}
          {!wake.posts.length && !wake.reply ? (
            <p className="text-xs text-muted">Nothing.</p>
          ) : null}
        </Section>
      </div>
    </div>
  );
}

function findStep(steps: readonly ChainStep[], runId: string): ChainStep | null {
  for (const item of steps) {
    if (item.wake.run_id === runId) return item;
    const found = findStep(item.next, runId);
    if (found) return found;
  }
  return null;
}
