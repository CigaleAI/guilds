import {
  Bookmark,
  CircleSlash,
  CircleX,
  Code,
  Database,
  FileText,
  Flag,
  MessageSquareText,
  type LucideIcon,
} from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Button, cn, Icon, OutcomeStrip, wakeOutcomeLabel } from "@guildsrun/ui";
import { useStudio } from "../StudioContext";
import {
  WAKE_BUCKETS,
  agentActivity,
  isActivityTriggerReason,
  reasonLabel,
  formatUsd,
  plural,
  type AgentInput,
  type MapSelection,
  type Tally,
} from "./activityModel";
import { AgentMark, AgentName, NodeMark, nodeName, type ActivityData } from "./parts";

type AgentActivityListProps = {
  data: ActivityData;
  onShowChains: (selection: MapSelection) => void;
};

/**
 * Each agent over the window: every way it was woken and what those wakes produced (inputs), and
 * everything it did (outputs). Clicking an input lists its chains in Flow.
 */
export function AgentActivityList({ data, onShowChains }: AgentActivityListProps) {
  const { go } = useStudio();
  const agents = useMemo(() => agentActivity(data.view, data.chains, data.map), [data]);
  if (!agents.length)
    return (
      <p className="rounded-lg bg-paper px-4 py-6 text-center text-sm text-muted">
        No agents in this window.
      </p>
    );
  return (
    <div className="flex flex-col gap-3">
      {agents.map(({ agent, inputs, outputs }) => {
        const most = Math.max(1, ...inputs.map((input) => input.count));
        return (
          <article
            key={agent.id}
            aria-label={agent.name}
            className="flex flex-col gap-3 rounded-xl bg-paper p-4"
          >
            <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="flex items-center gap-2">
                <AgentMark agent={agent} size={20} />
                <AgentName agent={agent} className="text-md font-semibold" />
              </span>
              <span className="text-xs text-muted">
                {plural(outputs.wakes, "wake")} · {plural(inputs.length, "trigger")} ·{" "}
                {formatUsd(outputs.cost)}
              </span>
              {outputs.wakes ? <OutcomeStrip counts={outputs.counts} className="h-2 w-40" /> : null}
              <Button
                variant="ghost"
                size="xs"
                className="ml-auto"
                onClick={() => go({ section: "agents", agent: agent.id })}
              >
                Inspect {agent.name}
              </Button>
            </header>
            <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
              <section className="flex min-w-0 flex-col">
                <h4 className="pb-1.5 type-label text-muted">Inputs</h4>
                {inputs.map((input) => (
                  <InputRow
                    key={input.id}
                    data={data}
                    input={input}
                    share={input.count / most}
                    onShow={() => onShowChains({ kind: "link", from: input.id, to: agent.id })}
                  />
                ))}
              </section>
              <section className="flex min-w-0 flex-col">
                <h4 className="pb-1.5 type-label text-muted">Outputs</h4>
                {outputs.posts ? (
                  <OutputRow
                    icon={MessageSquareText}
                    label={`Group messages, from ${plural(outputs.postingWakes, "wake")}`}
                    count={outputs.posts}
                  >
                    {outputs.woke.length ? (
                      <>
                        <span>woke</span>
                        {outputs.woke.map((item) => (
                          <Chip key={item.value} count={item.count}>
                            <AgentMark agent={data.index.agents.get(item.value)} size={14} />
                            <AgentName agent={data.index.agents.get(item.value)} />
                          </Chip>
                        ))}
                      </>
                    ) : (
                      <span>woke nobody</span>
                    )}
                  </OutputRow>
                ) : null}
                <TallyRow
                  icon={Database}
                  label={`Record writes${
                    Object.keys(outputs.recordOperations).length
                      ? ` · ${Object.entries(outputs.recordOperations)
                          .map(
                            ([operation, count]) =>
                              `${count} ${operation === "create" ? "created" : operation === "update" ? "updated" : operation}`,
                          )
                          .join(", ")}`
                      : ""
                  }`}
                  items={outputs.records}
                />
                <TallyRow icon={FileText} label="Note writes" items={outputs.notes} />
                <TallyRow icon={Code} label="Scripts run" items={outputs.scriptRuns} />
                <TallyRow icon={Code} label="Script changes" items={outputs.scriptChanges} />
                {outputs.issues ? (
                  <OutputRow icon={Flag} label="Issues reported" count={outputs.issues} />
                ) : null}
                {outputs.memory ? (
                  <OutputRow
                    icon={Bookmark}
                    label="Wakes that updated memory"
                    count={outputs.memory}
                  />
                ) : null}
                {outputs.counts.silent ? (
                  <OutputRow
                    icon={CircleSlash}
                    label="Wakes with no output"
                    count={outputs.counts.silent}
                  />
                ) : null}
                {outputs.errors.length ? (
                  <OutputRow
                    icon={CircleX}
                    label="Errors"
                    count={outputs.errors.reduce((sum, item) => sum + item.count, 0)}
                    tone="error"
                  >
                    {outputs.errors.slice(0, 4).map((item) => (
                      <span key={item.value} className="w-full truncate" title={item.value}>
                        {item.value} ×{item.count}
                      </span>
                    ))}
                  </OutputRow>
                ) : null}
                {!outputs.wakes ? (
                  <p className="py-2 text-xs text-muted">Nothing in this window.</p>
                ) : null}
              </section>
            </div>
          </article>
        );
      })}
    </div>
  );
}

type InputRowProps = {
  data: ActivityData;
  input: AgentInput;
  share: number;
  onShow: () => void;
};

function InputRow({ data, input, share, onShow }: InputRowProps) {
  const { index } = data;
  const routine = input.kind === "routine" ? index.routines.get(input.id.slice(8)) : undefined;
  const reasons = Object.entries(input.reasons)
    .flatMap(([reason, count]) =>
      isActivityTriggerReason(reason) ? [`${count} ${reasonLabel[reason]}`] : [],
    )
    .join(" · ");
  const detail =
    input.kind === "routine"
      ? `${routine?.label ?? "routine"}${input.count ? "" : " · didn't fire"}`
      : input.kind === "agent"
        ? `its posts · ${reasons}`
        : input.kind === "direct"
          ? "private chats"
          : reasons;
  const outcomes = WAKE_BUCKETS.filter((outcome) => input.counts[outcome] > 0)
    .map((outcome) => `${input.counts[outcome]} ${wakeOutcomeLabel[outcome]}`)
    .join(", ");
  const name =
    input.kind === "agent" ? `${nodeName(index, input.id)}'s posts` : nodeName(index, input.id);
  return (
    <button
      type="button"
      disabled={!input.count}
      onClick={onShow}
      title={
        input.count
          ? `${outcomes} · ${formatUsd(input.cost)} · click to list these chains`
          : undefined
      }
      className="grid cursor-pointer grid-cols-[minmax(0,1fr)_2.5rem_minmax(3rem,7rem)] items-center gap-3 border-t border-line py-1.5 text-left hover:bg-surface disabled:cursor-default disabled:hover:bg-transparent"
    >
      <span className="flex min-w-0 items-center gap-2">
        <NodeMark index={index} id={input.id} kind={input.kind} />
        <span className="flex min-w-0 flex-col">
          <span className={cn("truncate text-sm", !input.count && "text-faint")}>{name}</span>
          <span className="truncate text-2xs text-muted">{detail}</span>
        </span>
      </span>
      <span
        className={cn(
          "text-right text-sm font-semibold tabular-nums",
          !input.count && "text-faint",
        )}
      >
        {input.count}
      </span>
      {input.count ? (
        <OutcomeStrip
          counts={input.counts}
          className="h-2.5"
          style={{ width: `${Math.max(4, share * 100)}%` }}
        />
      ) : (
        <span className="text-2xs text-faint">idle</span>
      )}
    </button>
  );
}

type OutputRowProps = {
  icon: LucideIcon;
  label: string;
  count: number;
  tone?: "error";
  children?: ReactNode;
};

function OutputRow({ icon, label, count, tone, children }: OutputRowProps) {
  return (
    <div className="grid grid-cols-[1rem_minmax(0,1fr)_2.5rem] items-start gap-x-2 gap-y-1 border-t border-line py-1.5">
      <Icon
        icon={icon}
        size={14}
        className={cn("mt-0.5", tone === "error" ? "text-outcome-failed" : "text-muted")}
      />
      <span className={cn("text-sm", tone === "error" && "text-outcome-failed")}>{label}</span>
      <span className="text-right text-sm font-semibold tabular-nums">{count}</span>
      {children ? (
        <span className="col-start-2 col-end-4 flex flex-wrap items-center gap-1.5 text-xs text-muted">
          {children}
        </span>
      ) : null}
    </div>
  );
}

type TallyRowProps = { icon: LucideIcon; label: string; items: Tally[] };

function TallyRow({ icon, label, items }: TallyRowProps) {
  if (!items.length) return null;
  return (
    <OutputRow icon={icon} label={label} count={items.reduce((sum, item) => sum + item.count, 0)}>
      {items.map((item) => (
        <Chip key={item.value} count={item.count}>
          <span className="max-w-40 truncate font-mono">{item.value}</span>
        </Chip>
      ))}
    </OutputRow>
  );
}

type ChipProps = { count: number; children: ReactNode };

function Chip({ count, children }: ChipProps) {
  return (
    <span className="flex items-center gap-1 rounded-sm bg-surface px-1.5 py-0.5 text-fg-2">
      {children}
      <span className="text-muted tabular-nums">×{count}</span>
    </span>
  );
}
