import {
  ArrowRight,
  Bot,
  ChevronDown,
  Code2,
  Database,
  FileText,
  GitBranch,
  Globe,
  KeyRound,
  PenLine,
  Plug,
  Repeat,
  Server,
  Trash2,
  TriangleAlert,
  Undo2,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import type { RecipeFinding } from "../../../api/types/recipes";
import { agentLook } from "../../../app/agents";
import {
  Button,
  CopyButton,
  Markdown,
  TextAreaField,
  ToolRow,
  Banner,
  Avatar,
  cn,
  Icon,
  Tag,
  Tooltip,
} from "@guildsrun/ui";
import { connectorLogo } from "../../access/connectorLogo";
import { sizingNote } from "../../machines/machines";
import {
  accessSection,
  agentCard,
  type AgentCapability,
  blockingSummary,
  collectionView,
  connectionCard,
  externalCard,
  guildHero,
  handoffChart,
  noteCard,
  planIssues,
  planMachineMinimum,
  planSections,
  planTally,
  routineView,
  secretCard,
  type CatalogEntry,
  type PendingAccess,
  type PlanAgent,
  type PlanIssue,
  type PlanSection,
  type PlanSectionId,
  type RecipePlan,
} from "./planModel";

/** Tool switches and connector removals, when the viewer may change a recipe's access. */
export type PlanAccessEditing = {
  pending: PendingAccess;
  onToolChange: (server: string, role: string, tool: string, enabled: boolean) => void;
  onRemoveConnection: (server: string, removed: boolean) => void;
  disabled?: boolean;
};

type PlanViewProps = {
  plan: RecipePlan;
  findings?: readonly RecipeFinding[] | undefined;
  catalog?: readonly CatalogEntry[] | undefined;
  access?: PlanAccessEditing | undefined;
  /** Saves an agent's Task as the operator wrote it; omit to show Tasks read-only. */
  onEditTask?: ((role: string, text: string) => Promise<unknown>) | undefined;
  /** More to show inside an agent's card, such as the name apply gives it. */
  agentExtras?: ((agent: PlanAgent) => ReactNode) | undefined;
  /** More to show inside a connector's card, such as which login apply uses. */
  connectionExtras?: ((server: string) => ReactNode) | undefined;
  /** Leaves out sections with nothing in them. */
  hideEmpty?: boolean;
  /** Leaves the guild's name out of the header, for a page whose own title already names it. */
  hideName?: boolean;
};

/** What a plan's cards can do besides showing it. */
type PlanHooks = Pick<PlanViewProps, "access" | "onEditTask" | "agentExtras" | "connectionExtras">;

const sectionIcon: Record<PlanSectionId, LucideIcon> = {
  agents: Bot,
  routines: Repeat,
  connectors: Plug,
  repositories: GitBranch,
  collections: Database,
  notes: FileText,
  handoffs: ArrowRight,
  external: Globe,
};

/**
 * Everything a recipe creates and needs: the guild, its agents with their Tasks, routines,
 * scripts and operator steps, the connectors, secrets and systems they reach, the collections and
 * notes apply writes, how work passes between agents, and what to set up outside the platform.
 */
export function PlanView({
  plan,
  findings,
  catalog,
  hideEmpty = false,
  hideName = false,
  ...hooks
}: PlanViewProps) {
  const prefix = useId();
  const hero = guildHero(plan);
  const blocking = blockingSummary(findings);
  const issues = planIssues(findings);
  const sections = planSections(plan, hideEmpty);
  const minimum = planMachineMinimum(plan);
  const [open, setOpen] = useState<ReadonlySet<PlanSectionId>>(
    () => new Set(sections.filter((section) => section.open).map((section) => section.id)),
  );
  const toggle = (id: PlanSectionId, next?: boolean) =>
    setOpen((current) => {
      const copy = new Set(current);
      if (next ?? !copy.has(id)) copy.add(id);
      else copy.delete(id);
      return copy;
    });

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <header className="flex flex-col gap-3">
        {!hideName || hero.about || hero.goal ? (
          <div className="flex flex-col gap-1">
            {hideName ? null : <h2 className="font-mono text-xl font-semibold">{hero.name}</h2>}
            {hero.about ? <p className="text-md text-fg-2">{hero.about}</p> : null}
            {hero.goal ? <p className="text-sm text-muted">{hero.goal}</p> : null}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {planTally(plan).map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                toggle(item.section, true);
                document
                  .getElementById(`${prefix}-${item.section}`)
                  ?.scrollIntoView({ block: "start", behavior: "smooth" });
              }}
              className="flex cursor-pointer items-baseline gap-1.5 rounded-full bg-surface px-3 py-1.5 text-sm hover:bg-paper"
            >
              <span className="font-semibold">{item.count}</span>
              <span className="text-fg-2">{item.label}</span>
            </button>
          ))}
          {minimum ? (
            <Tooltip label={sizingNote}>
              <span
                tabIndex={0}
                className="flex cursor-help items-center gap-1.5 rounded-full px-3 py-1.5 text-sm text-muted"
              >
                <Icon icon={Server} size={14} />
                Needs a machine of at least {minimum}
              </span>
            </Tooltip>
          ) : null}
          {hero.groupLimit ? (
            <span className="flex items-baseline gap-1.5 rounded-full px-3 py-1.5 text-sm text-muted">
              {hero.groupLimit} group messages per agent
            </span>
          ) : null}
        </div>
      </header>

      {blocking ? (
        <Banner tone="error" title={blocking.label}>
          {blocking.hint}
        </Banner>
      ) : null}

      {sections.map((section) => (
        <PlanSectionBlock
          key={section.id}
          id={`${prefix}-${section.id}`}
          section={section}
          open={open.has(section.id)}
          onToggle={() => toggle(section.id)}
        >
          <SectionBody
            id={section.id}
            plan={plan}
            findings={findings}
            catalog={catalog}
            hooks={hooks}
          />
        </PlanSectionBlock>
      ))}
      {issues ? <IssuesList title={issues.title} items={issues.items} /> : null}
    </div>
  );
}

type PlanSectionBlockProps = {
  id: string;
  section: PlanSection;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
};

function PlanSectionBlock({ id, section, open, onToggle, children }: PlanSectionBlockProps) {
  return (
    <section id={id} className="flex scroll-mt-4 flex-col gap-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex cursor-pointer items-center gap-2 text-left"
      >
        <Icon icon={sectionIcon[section.id]} size={16} className="text-muted" />
        <h3 className="text-md font-semibold">{section.title}</h3>
        {section.count !== null ? <Tag tone="well">{section.count}</Tag> : null}
        <Icon
          icon={ChevronDown}
          size={16}
          className={cn("ml-auto text-muted transition-transform", open && "rotate-180")}
        />
      </button>
      {open ? section.empty ? <p className="text-sm text-muted">None.</p> : children : null}
    </section>
  );
}

type SectionBodyProps = {
  id: PlanSectionId;
  plan: RecipePlan;
  findings: readonly RecipeFinding[] | undefined;
  catalog: readonly CatalogEntry[] | undefined;
  hooks: PlanHooks;
};

function SectionBody({ id, plan, findings, catalog, hooks }: SectionBodyProps) {
  switch (id) {
    case "agents":
      return (
        <div className="grid gap-3 xl:grid-cols-2">
          {plan.agents.map((agent) => (
            <AgentCardView
              key={agent.role}
              agent={agent}
              plan={plan}
              findings={findings}
              hooks={hooks}
            />
          ))}
        </div>
      );
    case "routines":
      return (
        <ul className="flex flex-col gap-1.5">
          {plan.routines.map((routine) => {
            const view = routineView(routine);
            const agent = plan.agents.find((item) => item.role === routine.role);
            return (
              <li
                key={`${view.role}:${view.key}`}
                className="flex items-start gap-3 rounded-lg bg-surface px-4 py-3"
              >
                <Icon icon={Repeat} size={16} className="mt-0.5 shrink-0 text-muted" />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-semibold">{view.description || view.key}</span>
                  <span className="text-xs text-muted">
                    {view.cadence} · {agent?.name || view.role}
                    {view.cron ? <span className="font-mono"> · {view.cron}</span> : null}
                  </span>
                </div>
                <Tag tone="well" font="sans">
                  {view.status}
                </Tag>
                {view.reviewer ? <ReviewerTag by={view.reviewer} /> : null}
              </li>
            );
          })}
        </ul>
      );
    case "connectors":
      return <ConnectorsBody plan={plan} catalog={catalog} hooks={hooks} />;
    case "collections":
      return (
        <div className="flex flex-col gap-3">
          {plan.collections.map((collection) => {
            const view = collectionView(collection);
            return (
              <article
                key={collection.name}
                className="flex flex-col gap-2.5 rounded-xl bg-surface p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Icon icon={Database} size={16} className="text-muted" />
                  <span className="font-mono text-sm font-semibold">{collection.name}</span>
                  {view.chip ? (
                    <Tag
                      tone={
                        view.chip.tone === "warn"
                          ? "plum"
                          : view.chip.tone === "ok"
                            ? "tide"
                            : "signal"
                      }
                      font="sans"
                    >
                      {view.chip.label}
                    </Tag>
                  ) : null}
                  <span className="text-xs text-muted">{view.access}</span>
                </div>
                <p className="text-sm text-fg-2">{view.snippet}</p>
                <p className="text-xs text-muted">{view.meta}</p>
                {view.conflict ? (
                  <Banner tone="error" title={view.conflict.headline}>
                    {view.conflict.differences.length ? (
                      <ul className="list-disc pl-4">
                        {view.conflict.differences.map((difference) => (
                          <li key={difference}>{difference}</li>
                        ))}
                      </ul>
                    ) : null}
                  </Banner>
                ) : null}
                {view.columns.length ? (
                  <ul className="flex flex-col divide-y divide-line rounded-lg bg-paper">
                    {view.columns.map((column) => (
                      <li
                        key={column.name}
                        className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2"
                      >
                        <span className="font-mono text-xs font-medium">{column.name}</span>
                        <span className="font-mono text-xs text-muted">{column.typeLabel}</span>
                        {column.rules.map((rule) => (
                          <Tag key={rule} tone="well" font="sans">
                            {rule}
                          </Tag>
                        ))}
                        {column.description ? (
                          <span className="w-full text-xs text-fg-2">{column.description}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </article>
            );
          })}
        </div>
      );
    case "notes":
      return (
        <div className="flex flex-col gap-2">
          {plan.notes.map((note, index) => {
            const card = noteCard(note);
            return (
              <details
                key={`${card.destination}:${index}`}
                className="group rounded-xl bg-surface px-4 py-3"
              >
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2">
                  <Icon icon={FileText} size={16} className="text-muted" />
                  <span className="font-mono text-sm font-semibold">{card.title}</span>
                  <Tag tone="well" font="sans">
                    {card.owner}
                  </Tag>
                  <span className="text-xs text-muted">{card.access}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-fg-2">{card.snippet}</span>
                  <Icon
                    icon={ChevronDown}
                    size={16}
                    className="text-muted transition-transform group-open:rotate-180"
                  />
                </summary>
                <div className="mt-3 flex flex-col gap-2">
                  <span className="font-mono text-xs text-muted">Writes {card.destination}</span>
                  <div className="rounded-lg bg-paper px-3 py-2">
                    <Markdown density="compact">{card.body || "_Empty note_"}</Markdown>
                  </div>
                </div>
              </details>
            );
          })}
        </div>
      );
    case "handoffs": {
      const chart = handoffChart(plan);
      return (
        <ul className="flex flex-col gap-1.5">
          {chart.rows.map((row) => (
            <li
              key={`${row.from.role}>${row.to.role}`}
              className="flex flex-wrap items-center gap-2 rounded-lg bg-surface px-4 py-3 text-sm"
            >
              <span className="font-mono font-medium">{row.from.name}</span>
              <Icon icon={ArrowRight} size={14} className="text-muted" />
              <span className="font-mono font-medium">{row.to.name}</span>
              <span className="flex flex-wrap gap-1">
                {row.vias.map((via, index) => (
                  <Tag key={index} tone={via.kind === "collection" ? "tide" : "well"}>
                    {via.label}
                  </Tag>
                ))}
              </span>
            </li>
          ))}
        </ul>
      );
    }
    case "repositories":
      return (
        <ul className="flex flex-col gap-1.5">
          {plan.repositories.map((repository) => (
            <li
              key={repository.name}
              className="flex flex-wrap items-baseline gap-2 rounded-lg bg-surface px-4 py-3 text-sm"
            >
              <span className="font-mono font-medium">{repository.name}</span>
              {repository.purpose ? <span className="text-fg-2">{repository.purpose}</span> : null}
            </li>
          ))}
          <li className="px-1 text-xs text-muted">
            After apply, connect GitHub and add each repository in the guild&apos;s Settings.
          </li>
        </ul>
      );
    case "external":
      return (
        <div className="flex flex-col gap-2">
          {plan.external.map((item, index) => {
            const card = externalCard(item);
            return (
              <article key={index} className="flex flex-col gap-2 rounded-xl bg-surface p-4">
                <span className="text-sm font-semibold">{card.title || "External setup"}</span>
                {card.setup ? <Markdown density="compact">{card.setup}</Markdown> : null}
              </article>
            );
          })}
        </div>
      );
  }
}

type ReviewerTagProps = { by: string };

function ReviewerTag({ by }: ReviewerTagProps) {
  return (
    <Tag tone="tide" font="sans" title={`Last written by the ${by}`}>
      {by} edit
    </Tag>
  );
}

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

function AgentCardView({ agent, plan, findings, hooks }: AgentCardViewProps) {
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

type ConnectorsBodyProps = {
  plan: RecipePlan;
  catalog: readonly CatalogEntry[] | undefined;
  hooks: PlanHooks;
};

function ConnectorsBody({ plan, catalog, hooks }: ConnectorsBodyProps) {
  const { access } = hooks;
  const { systems } = accessSection(plan);
  return (
    <div className="flex flex-col gap-3">
      {plan.connections.map((connection) => {
        const card = connectionCard(connection, plan, catalog, access?.pending ?? null);
        const removed = access?.pending.removed.has(card.server) ?? false;
        return (
          <article
            key={card.server}
            className={cn(
              "flex flex-col gap-2.5 rounded-xl bg-surface p-4",
              removed && "opacity-60",
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              {connectorLogo(
                catalog?.find((entry) => (entry.slug ?? entry.server) === card.server)?.logo_url,
                "size-4 text-muted",
              ) ?? <Icon icon={Plug} size={16} className="text-muted" />}
              <span className="font-mono text-sm font-semibold">{card.server}</span>
              <Tag tone={card.chip.tone === "ok" ? "tide" : "signal"} font="sans">
                {removed ? "removed" : card.chip.label}
              </Tag>
              {card.reviewer ? <ReviewerTag by={card.reviewer} /> : null}
              {access ? (
                <Button
                  variant="ghost"
                  size="xs"
                  className="ml-auto"
                  disabled={access.disabled}
                  onClick={() => access.onRemoveConnection(card.server, !removed)}
                >
                  <Icon icon={removed ? Undo2 : Trash2} size={14} />
                  {removed ? "Keep" : "Remove"}
                </Button>
              ) : null}
            </div>
            {card.description ? (
              <Markdown density="compact">{card.description}</Markdown>
            ) : card.snippet ? (
              <p className="text-sm text-fg-2">{card.snippet}</p>
            ) : null}
            <p className="text-xs text-muted">{card.meta}</p>
            {hooks.connectionExtras?.(card.server)}
            {card.resources.length ? (
              <ul className="flex flex-col gap-0.5 text-xs text-fg-2">
                {card.resources.map((resource) => (
                  <li key={resource}>{resource}</li>
                ))}
              </ul>
            ) : null}
            {!removed ? (
              card.tools.groups.length ? (
                card.tools.groups.map((group) => (
                  <details key={group.role} className="group rounded-lg bg-paper">
                    <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 text-sm">
                      <span className="font-medium">{group.title}</span>
                      <span className="text-xs text-muted">
                        {group.tools.filter((tool) => tool.enabled).length} of {group.tools.length}{" "}
                        on
                      </span>
                      <Icon
                        icon={ChevronDown}
                        size={14}
                        className="ml-auto text-muted transition-transform group-open:rotate-180"
                      />
                    </summary>
                    <div className="border-t border-line">
                      {group.tools.map((tool) => (
                        <ToolRow
                          key={tool.name}
                          name={tool.name}
                          enabled={tool.enabled}
                          disabled={!access || Boolean(access.disabled)}
                          onEnabledChange={(enabled) =>
                            access?.onToolChange(card.server, group.role, tool.name, enabled)
                          }
                        />
                      ))}
                    </div>
                  </details>
                ))
              ) : card.tools.empty ? (
                <p className="text-xs text-muted">{card.tools.empty}</p>
              ) : null
            ) : null}
          </article>
        );
      })}
      {plan.secrets.map((secret) => {
        const card = secretCard(secret);
        return (
          <article
            key={card.name}
            className="flex items-center gap-3 rounded-xl bg-surface px-4 py-3"
          >
            <Icon icon={KeyRound} size={16} className="shrink-0 text-muted" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="font-mono text-sm font-semibold">{card.name}</span>
              {card.snippet ? <span className="text-xs text-fg-2">{card.snippet}</span> : null}
            </div>
            <Tag tone="well" font="sans">
              secret
            </Tag>
          </article>
        );
      })}
      {systems.map((system) => (
        <article
          key={`${system.name}:${system.server ?? ""}`}
          className="flex flex-col gap-1 rounded-xl bg-surface px-4 py-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Icon icon={Globe} size={16} className="text-muted" />
            <span className="text-sm font-semibold">{system.name}</span>
            <Tag tone="well" font="sans">
              {system.resolution}
            </Tag>
          </div>
          {system.reason ? <p className="text-sm text-fg-2">{system.reason}</p> : null}
        </article>
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

const issuesShown = 5;

type IssuesListProps = { title: string; items: PlanIssue[] };

/** The findings no card shows, most blocking first; long lists fold after a few. */
function IssuesList({ title, items }: IssuesListProps) {
  const [all, setAll] = useState(false);
  const sorted = [...items].sort((a, b) => Number(b.blocking) - Number(a.blocking));
  const shown = all ? sorted : sorted.slice(0, issuesShown);
  return (
    <section className="flex flex-col gap-2 rounded-xl bg-surface p-4">
      <h3 className="type-label text-muted">
        {title} · {items.length}
      </h3>
      <ul className="flex flex-col gap-1.5">
        {shown.map((issue, index) => (
          <li key={`${issue.finding.path}:${index}`} className="flex items-start gap-2 text-sm">
            <Tag tone={issue.blocking ? "plum" : "well"} font="sans" className="shrink-0">
              {issue.label}
            </Tag>
            <span className="min-w-0 text-fg-2">{issue.finding.message}</span>
          </li>
        ))}
      </ul>
      {sorted.length > issuesShown ? (
        <Button variant="ghost" size="xs" className="self-start" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${sorted.length}`}
        </Button>
      ) : null}
    </section>
  );
}
