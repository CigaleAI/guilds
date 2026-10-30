import {
  ChevronDown,
  Code2,
  Globe,
  PenLine,
  Plug,
  Repeat,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import type { RecipeFinding } from "../../../api/types/recipes";
import { agentLook } from "../../../app/agents";
import {
  Button,
  CopyButton,
  Markdown,
  TextAreaField,
  Banner,
  Avatar,
  cn,
  Icon,
  Tag,
  Tooltip,
} from "@guildsrun/ui";
import type { RecipePlan } from "./planModel";
import { agentCard, type AgentCapability, type PlanAgent } from "./planAgents";
import type { PlanHooks } from "./PlanView";
import { ReviewerTag } from "./ReviewerTag";

type FoldProps = {
  title: ReactNode;
  badge?: string;
  reviewer?: string | null;
  children: ReactNode;
};

/** A folded block inside a card: its title, a badge, and its body when opened. */
function Fold({ title, badge, reviewer, children }: FoldProps) {
  return (
    <details className="group rounded-lg bg-paper px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        {reviewer ? <ReviewerTag by={reviewer} /> : null}
        {badge ? <span className="font-mono text-xs text-muted">{badge}</span> : null}
        <Icon
          icon={ChevronDown}
          size={14}
          className="text-muted transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

type AgentCardViewProps = {
  agent: PlanAgent;
  plan: RecipePlan;
  findings: readonly RecipeFinding[] | undefined;
  hooks: PlanHooks;
};

export function AgentCardView({ agent, plan, findings, hooks }: AgentCardViewProps) {
  const card = agentCard(agent, plan, findings);
  const { metrics } = card;
  const [metric, setMetric] = useState<"connectors" | "routines" | "tools" | null>(null);
  const pills = [
    {
      id: "connectors" as const,
      icon: Plug,
      label: metrics.connectors.label,
      empty: metrics.connectors.empty,
      warning: null,
    },
    {
      id: "routines" as const,
      icon: Repeat,
      label: metrics.routines.label,
      empty: metrics.routines.empty,
      warning: metrics.routines.warning,
    },
    {
      id: "tools" as const,
      icon: Wrench,
      label: metrics.tools.label,
      empty: metrics.tools.empty,
      warning: null,
    },
  ];

  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-xl bg-surface p-4">
      <header className="flex items-start gap-3">
        <Avatar
          name={agent.name || agent.role}
          size={36}
          {...agentLook({ avatar_shape: agent.avatar_shape, avatar_color: agent.avatar_color })}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h4 className="truncate font-mono text-md font-semibold">{agent.name || agent.role}</h4>
          {agent.focus ? <p className="text-sm text-fg-2">{agent.focus}</p> : null}
          <p className="truncate font-mono text-xs text-muted">
            @{agent.role}
            {agent.model ? ` · ${agent.model}` : ""}
          </p>
        </div>
      </header>

      <div className="flex flex-wrap gap-1.5">
        {pills.map((pill) => {
          const button = (
            <button
              key={pill.id}
              type="button"
              aria-pressed={metric === pill.id}
              onClick={() => setMetric(metric === pill.id ? null : pill.id)}
              className={cn(
                "flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
                "bg-paper hover:bg-paper-hi selected:bg-ink-fill selected:text-on-ink",
                pill.empty && "text-muted",
              )}
            >
              <Icon icon={pill.icon} size={14} />
              {pill.label}
              {pill.warning ? (
                <Icon icon={TriangleAlert} size={14} className="text-t-ochre-fg" />
              ) : null}
            </button>
          );
          return pill.warning ? (
            <Tooltip key={pill.id} label={pill.warning}>
              {button}
            </Tooltip>
          ) : (
            button
          );
        })}
      </div>
      {metric === "connectors" ? (
        <ul className="flex flex-col gap-1 rounded-lg bg-paper px-3 py-2 text-xs">
          {metrics.connectors.entries.map((entry) => (
            <li key={entry.server}>
              <span className="font-mono font-medium">{entry.server}</span>{" "}
              <span className="text-muted">{entry.detail}</span>
            </li>
          ))}
          {metrics.connectors.empty ? <li className="text-muted">No connectors.</li> : null}
        </ul>
      ) : metric === "routines" ? (
        <ul className="flex flex-col gap-1 rounded-lg bg-paper px-3 py-2 text-xs">
          {metrics.routines.entries.map((entry) => (
            <li key={entry.key}>
              <span className="font-medium">{entry.cadence}</span>
              {entry.description ? (
                <span className="text-muted"> · {entry.description}</span>
              ) : null}
            </li>
          ))}
          {metrics.routines.empty ? <li className="text-muted">No routines.</li> : null}
        </ul>
      ) : metric === "tools" ? (
        <div className="flex flex-wrap gap-1 rounded-lg bg-paper px-3 py-2">
          {metrics.tools.nativeTools.map((tool) => (
            <Tag key={tool} tone="term">
              {tool}
            </Tag>
          ))}
          {metrics.tools.empty ? <span className="text-xs text-muted">No tools.</span> : null}
        </div>
      ) : null}

      {card.capabilities.length ? <CapabilityList capabilities={card.capabilities} /> : null}
      {card.findings.notices.map((notice, index) => (
        <Banner
          key={`${notice.path}:${index}`}
          tone={notice.severity === "error" ? "error" : "info"}
          title={notice.message}
        />
      ))}

      <TaskBlock
        role={agent.role}
        text={card.prompt.text}
        badge={card.prompt.badge}
        reviewer={card.prompt.reviewer}
        onSave={hooks.onEditTask}
      />
      {hooks.agentExtras?.(agent)}

      {card.operator?.cards.map((item, index) => (
        <div key={index} className="flex flex-col gap-1 rounded-lg bg-t-sig px-3 py-2 text-sm">
          {item.title ? <span className="font-semibold">{item.title}</span> : null}
          <p className="text-fg-2">{item.text}</p>
        </div>
      ))}

      {card.scripts.map((script) => (
        <Fold
          key={script.name}
          title={<span className="font-mono">{script.name}.py</span>}
          reviewer={script.reviewer}
        >
          <pre className="overflow-x-auto font-mono text-xs">{script.source}</pre>
        </Fold>
      ))}
    </article>
  );
}

const capabilityIcon: Record<AgentCapability["id"], LucideIcon> = {
  browser: Globe,
  coding: Code2,
};

type CapabilityListProps = { capabilities: readonly AgentCapability[] };

/** An agent's capabilities as chips; hovering one shows what apply needs for it. */
function CapabilityList({ capabilities }: CapabilityListProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="type-label mr-1 text-muted">Capabilities</span>
      {capabilities.map((capability) => (
        <Tooltip
          key={capability.id}
          label={
            <span className="flex flex-col gap-1">
              {capability.hint.map((line) => (
                <span key={line}>{line}</span>
              ))}
              {capability.reviewer ? (
                <span className="text-on-panel-muted">
                  Last written by the {capability.reviewer}
                </span>
              ) : null}
            </span>
          }
        >
          <span
            tabIndex={0}
            className={cn(
              "flex cursor-help items-center gap-1.5 rounded-full bg-paper px-2.5 py-1 text-xs font-medium",
              capability.pending && "text-muted",
            )}
          >
            <Icon icon={capabilityIcon[capability.id]} size={14} />
            {capability.label}
          </span>
        </Tooltip>
      ))}
    </div>
  );
}

type TaskBlockProps = {
  role: string;
  text: string;
  badge: string;
  reviewer: string | null;
  onSave: ((role: string, text: string) => Promise<unknown>) | undefined;
};

/** An agent's Task, folded; the operator can rewrite it when the page allows. */
function TaskBlock({ role, text, badge, reviewer, onSave }: TaskBlockProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  return (
    <Fold title="Task" badge={badge} reviewer={reviewer}>
      {draft !== null ? (
        <div className="flex flex-col gap-2">
          <TextAreaField
            tone="surface"
            font="mono"
            aria-label="Task"
            rows={10}
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={saving || draft.trim() === text}
              onClick={() => {
                if (!onSave) return;
                setSaving(true);
                onSave(role, draft.trim()).then(
                  () => {
                    setSaving(false);
                    setDraft(null);
                  },
                  () => setSaving(false),
                );
              }}
            >
              {saving ? "Saving…" : "Save Task"}
            </Button>
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {text ? (
            <Markdown density="compact">{text}</Markdown>
          ) : (
            <p className="text-sm text-muted">No Task written yet.</p>
          )}
          <div className="flex items-center gap-2">
            {onSave ? (
              <Button variant="outline" size="xs" onClick={() => setDraft(text)}>
                <Icon icon={PenLine} size={14} />
                Edit Task
              </Button>
            ) : null}
            {text ? <CopyButton text={text} what="Task" size={24} /> : null}
          </div>
        </div>
      )}
    </Fold>
  );
}
