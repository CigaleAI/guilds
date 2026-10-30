import {
  Bookmark,
  CircleX,
  Code,
  Database,
  FileText,
  Flag,
  GitBranch,
  History,
  MessageSquareText,
  Pin,
  Quote,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { Button, Tooltip, cn, Icon, MarkSquare, wakeOutcomeLabel } from "@guildsrun/ui";
import { useIdentity } from "../../../app/identity";
import { useStudio } from "../StudioContext";
import {
  clockWithDay,
  clockWithSeconds,
  formatActivityDuration,
  formatUsd,
  plural,
  operatorAuthor,
  toMs,
  triggerReasonLabel,
  wakeBucket,
  type Chain,
  type ChainStep,
} from "./activityModel";
import {
  AgentMark,
  AgentName,
  DetailHead,
  nodeName,
  Quoted,
  Section,
  type ActivityData,
} from "./parts";
import { tally, wakeEffects, type WriteGroup } from "./wakeEffects";

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

type StepDetailProps = {
  data: ActivityData;
  chain: Chain;
  runId: string;
  onClose: () => void;
};

export function StepDetail({ data, chain, runId, onClose }: StepDetailProps) {
  const { openStep, ask } = useStudio();
  const { user } = useIdentity();
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
  const reason = triggerReasonLabel(wake.trigger);
  const wokenBy = step.post
    ? `woken by ${nodeName(index, step.from)}'s post #${step.post.seq}${reason ? ` (${reason})` : ""}`
    : chain.start.kind === "routine"
      ? `woken by ${nodeName(index, chain.source)}`
      : chain.start.kind === "direct"
        ? "woken by a direct chat"
        : chain.start.kind === "operator"
          ? `woken by ${operatorAuthor(chain.start.message, user.id)} message #${chain.start.message.seq}${reason ? ` (${reason})` : ""}`
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
          {clockWithSeconds(start)}–{clockWithSeconds(end)} · {formatActivityDuration(end - start)}{" "}
          · {formatUsd(wake.cost_usd)}
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
                label: `${agent?.name ?? "agent"} · ${clockWithDay(start)}`,
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
