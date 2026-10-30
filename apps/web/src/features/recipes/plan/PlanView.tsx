import {
  ArrowRight,
  Bot,
  ChevronDown,
  Database,
  FileText,
  GitBranch,
  Globe,
  Plug,
  Repeat,
  Server,
  type LucideIcon,
} from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import type { RecipeFinding } from "../../../api/types/recipes";
import { Button, Markdown, Banner, cn, Icon, Tag, Tooltip } from "@guildsrun/ui";
import { sizingNote } from "../../machines/machines";
import type { RecipePlan } from "./planModel";
import type { PlanAgent } from "./planAgents";
import { routineView } from "./planRoutines";
import type { CatalogEntry } from "./planConnectors";
import type { PendingAccess } from "./pendingAccess";
import { collectionView } from "./planCollections";
import { noteCard } from "./planNotes";
import { blockingSummary, planIssues, type PlanIssue } from "./planFindings";
import { handoffChart } from "./planHandoffs";
import { externalCard } from "./planActions";
import {
  guildHero,
  planMachineMinimum,
  planSections,
  planTally,
  type PlanSection,
  type PlanSectionId,
} from "./planSections";
import { ReviewerTag } from "./ReviewerTag";
import { AgentCardView } from "./AgentCardView";
import { ConnectorsBody } from "./ConnectorsBody";

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
  /** The sections to show, in order; every section of the plan when omitted. */
  sections?: readonly PlanSection[] | undefined;
  /** Leaves the guild's name out of the header, for a page whose own title already names it. */
  hideName?: boolean;
};

/** What a plan's cards can do besides showing it. */
export type PlanHooks = Pick<
  PlanViewProps,
  "access" | "onEditTask" | "agentExtras" | "connectionExtras"
>;

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
  sections = planSections(plan),
  hideName = false,
  ...hooks
}: PlanViewProps) {
  const prefix = useId();
  const blocking = blockingSummary(findings);
  const issues = planIssues(findings);
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
      <PlanHeader
        plan={plan}
        hideName={hideName}
        onOpenSection={(section) => {
          toggle(section, true);
          document
            .getElementById(`${prefix}-${section}`)
            ?.scrollIntoView({ block: "start", behavior: "smooth" });
        }}
      />

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

type PlanHeaderProps = {
  plan: RecipePlan;
  /** Leaves the guild's name out, for a page whose own title already names it. */
  hideName: boolean;
  /** Opens a section and brings it into view, from its count tile. */
  onOpenSection: (section: PlanSectionId) => void;
};

/**
 * The plan's header: the guild's name, about text and goal, a count tile per kind that opens its
 * section, the smallest machine the agents need, and the group message cap.
 */
function PlanHeader({ plan, hideName, onOpenSection }: PlanHeaderProps) {
  const hero = guildHero(plan);
  const minimum = planMachineMinimum(plan);
  return (
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
            onClick={() => onOpenSection(item.section)}
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
