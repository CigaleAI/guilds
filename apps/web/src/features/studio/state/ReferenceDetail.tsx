import { ExternalLink, Pin } from "lucide-react";
import { Banner, Button, cn, Icon } from "@guildsrun/ui";
import type { ReferenceNode, StudioReferences } from "../../../api/types";
import { DetailHeader, Empty } from "../MasterDetail";
import { useStudio } from "../StudioContext";
import { NodeRow, ReferenceSection as Section } from "./referenceParts";
import {
  formatSize,
  isOverBudget,
  linkLabel,
  reachedAgents,
  referenceColumnLabels,
  referenceLinks,
  stateListLocation,
  taskPulls,
  type ReferenceLink,
} from "./referencesModel";

/** The selected Task or file: what it pulls in, what pulls it in, and where to open it. */
export function ReferenceDetail({
  data,
  node,
  onSelect,
}: {
  data: StudioReferences;
  node: ReferenceNode;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="flex flex-col gap-4">
      <DetailHeader
        title={node.label}
        meta={<span className="font-mono break-all">{node.id}</span>}
        actions={<DetailActions node={node} />}
      />
      {node.kind === "task" ? (
        <TaskDetail data={data} node={node} onSelect={onSelect} />
      ) : (
        <FileDetail data={data} node={node} onSelect={onSelect} />
      )}
    </section>
  );
}

function DetailActions({ node }: { node: ReferenceNode }) {
  const { go, ask } = useStudio();
  const location = stateListLocation(node);
  return (
    <>
      {node.kind === "task" && node.agent_id ? <OpenPrompt agentId={node.agent_id} /> : null}
      {location ? (
        <Button variant="outline" size="sm" onClick={() => go(location)}>
          <Icon icon={ExternalLink} size={14} />
          Open in State
        </Button>
      ) : null}
      {location ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            ask({
              kind: "file",
              ...(node.agent_id ? { agent_id: node.agent_id } : {}),
              display_path: node.id,
              label: `${node.kind === "table" ? "Table" : "File"} · ${node.label}`,
            })
          }
        >
          <Icon icon={Pin} size={14} />
          Ask the coach
        </Button>
      ) : null}
    </>
  );
}

function OpenPrompt({ agentId, label = "Open Prompt" }: { agentId: string; label?: string }) {
  const { go } = useStudio();
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => go({ section: "agents", agent: agentId, tab: "prompt" })}
    >
      <Icon icon={ExternalLink} size={14} />
      {label}
    </Button>
  );
}

/** A Task's embed budget, and everything it pulls into every run. */
function TaskDetail({
  data,
  node,
  onSelect,
}: {
  data: StudioReferences;
  node: ReferenceNode;
  onSelect: (id: string) => void;
}) {
  const used = node.inlined_bytes ?? 0;
  const over = isOverBudget(node, data.budget);
  const labels = referenceColumnLabels(data.depth);
  const pulls = taskPulls(data, node);
  const named = referenceLinks(data, node.id).out.filter((link) => link.edge.kind === "name");
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <div className="h-2 overflow-hidden rounded-full bg-well">
          <div
            className={cn("h-full rounded-full", over ? "bg-outcome-failed" : "bg-signal")}
            style={{ width: `${Math.min(100, (used / data.budget) * 100)}%` }}
          />
        </div>
        <span className="text-xs text-muted">
          {formatSize(used)} of the {formatSize(data.budget)} each run may inline
        </span>
      </div>
      {over ? (
        <Banner tone="error" title="Runs can't start: the Task inlines more than the budget" />
      ) : null}
      <Section title="Pulled into every run">
        {pulls.length ? (
          pulls.map(({ node: pulled, hop, inlined }) => (
            <NodeRow
              key={pulled.id}
              node={pulled}
              meta={
                inlined ? `${labels[hop]} · ${formatSize(pulled.bytes)}` : "Too deep · stays text"
              }
              onSelect={onSelect}
            />
          ))
        ) : (
          <Empty>This Task embeds nothing.</Empty>
        )}
      </Section>
      {named.length ? (
        <Section title="Named without embedding">
          <LinkRows links={named} onSelect={onSelect} />
        </Section>
      ) : null}
    </>
  );
}

/** What a file embeds or names, what embeds or names it, and the prompts it reaches. */
/** What a file embeds or names, what embeds or names it, and which agents' prompts it reaches. */
export function FileDetail({
  data,
  node,
  onSelect,
}: {
  data: StudioReferences;
  node: ReferenceNode;
  onSelect: (id: string) => void;
}) {
  const { agents } = useStudio();
  const links = referenceLinks(data, node.id);
  const reached = reachedAgents(node, data.depth);
  return (
    <>
      {node.kind === "unresolved" ? (
        <Banner tone="error" title="This link does not resolve" meta={node.reason ?? undefined} />
      ) : null}
      {node.kind === "note" ? (
        <Section title="Embeds or names">
          {links.out.length ? (
            <LinkRows links={links.out} onSelect={onSelect} />
          ) : (
            <Empty>It embeds or names nothing.</Empty>
          )}
        </Section>
      ) : null}
      <Section title="Embedded or named by">
        {links.in.length ? (
          <LinkRows links={links.in} onSelect={onSelect} />
        ) : (
          <Empty>Nothing points here.</Empty>
        )}
      </Section>
      <Section title="Reaches the prompts of">
        {reached.length ? (
          <div className="flex flex-wrap gap-2">
            {reached.map((agentId) => (
              <OpenPrompt
                key={agentId}
                agentId={agentId}
                label={agents.find((agent) => agent.id === agentId)?.name ?? agentId}
              />
            ))}
          </div>
        ) : (
          <Empty>No agent's run inlines it.</Empty>
        )}
      </Section>
    </>
  );
}

function LinkRows({ links, onSelect }: { links: ReferenceLink[]; onSelect: (id: string) => void }) {
  return links.flatMap((link) =>
    link.node ? (
      <NodeRow
        key={`${link.edge.kind}:${link.id}`}
        node={link.node}
        meta={linkLabel(link.edge)}
        onSelect={onSelect}
      />
    ) : (
      []
    ),
  );
}
