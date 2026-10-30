import { Link, useParams } from "@tanstack/react-router";
import { Database, Plus } from "lucide-react";
import { useState } from "react";
import { useCollections } from "../../api/queries/tables";
import { useReach } from "../../api/queries/access";
import type { Column } from "../../api/types/tables";
import type { AccessMode, ReachSubject, ReachedTable } from "../../api/types/access";
import { Banner, Button, EmptyState, Icon, SkeletonRows, Tag } from "@guildsrun/ui";
import { CreateTableDialog } from "./CreateTableDialog";

const intros: Record<ReachSubject["type"], string> = {
  guild:
    "The tables this guild's agents read or write, with the columns they see in State. An agent's own row on a table can widen or narrow it.",
  agent:
    "The tables this agent reads or writes, with the columns it sees in State. Change who reaches a table on its Access tab.",
};

const emptyDescriptions: Record<ReachSubject["type"], string> = {
  guild: "No table is placed in this guild or open to its agents. Create one here.",
  agent:
    "This agent reaches no table. Create one, or give the agent a row on a table's Access tab.",
};

const modeLabel: Record<AccessMode, string> = { read: "Read", write: "Read & write" };

/** The agent's State sub-tab: the tables it reaches. */
export function AgentTablesTab() {
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  return <StateTables subject={{ type: "agent", id: agentId }} guildId={guildId} />;
}

/** The guild's State sub-tab: the tables its agents reach. */
export function GuildTablesTab() {
  const { guildId } = useParams({ from: "/guilds/$guildId" });
  return <StateTables subject={{ type: "guild", id: guildId }} guildId={guildId} />;
}

/** The tables a guild's agents, or one agent, reach, each with its columns; empty, it says so. */
function StateTables({ subject, guildId }: { subject: ReachSubject; guildId: string }) {
  const reach = useReach(subject);
  const collections = useCollections();
  const [creating, setCreating] = useState(false);
  const columnsOf = (id: string): Column[] =>
    collections.data?.find((collection) => collection.id === id)?.columns ?? [];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-10 md:py-6">
      <div className="mx-auto flex max-w-240 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-sm text-fg-2">{intros[subject.type]}</p>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Icon icon={Plus} size={14} />
            New table
          </Button>
        </div>
        {reach.isPending ? (
          <SkeletonRows rows={4} label="Loading tables" />
        ) : reach.isError ? (
          <Banner tone="error" title="Couldn't load the tables" meta={reach.error.message} />
        ) : reach.data.tables.length === 0 ? (
          <EmptyState
            icon={Database}
            title="No tables yet"
            description={emptyDescriptions[subject.type]}
          />
        ) : (
          reach.data.tables.map((table) => (
            <TableCard key={table.id} table={table} columns={columnsOf(table.id)} />
          ))
        )}
      </div>
      <CreateTableDialog open={creating} onOpenChange={setCreating} guildId={guildId} />
    </div>
  );
}

function TableCard({ table, columns }: { table: ReachedTable; columns: Column[] }) {
  return (
    <section className="flex flex-col overflow-hidden rounded-xl bg-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <Link
            to="/tables/$collectionId"
            params={{ collectionId: table.id }}
            className="w-fit font-mono text-sm font-medium hover:underline"
          >
            {table.name}
          </Link>
          <span className="text-xs text-muted">
            {table.guild ? `Guild · ${table.guild.name}` : "Organisation"} · {table.purpose}
          </span>
        </div>
        <Tag tone={table.mode === "write" ? "tide" : "signal"} font="sans">
          {modeLabel[table.mode]}
        </Tag>
      </div>
      {columns.map((column) => (
        <div
          key={column.name}
          className="flex flex-col gap-0.5 border-b border-line px-4 py-2 last:border-b-0"
        >
          <span className="font-mono text-xs font-medium">
            {column.name} <span className="text-muted">· {column.type}</span>
          </span>
          <span className="text-xs whitespace-pre-line text-fg-2">{column.description}</span>
        </div>
      ))}
    </section>
  );
}
