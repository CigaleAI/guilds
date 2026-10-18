import { Link, useParams } from "@tanstack/react-router";
import { Database, Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  useAgentDatabases,
  useGuildDatabases,
  useSetAgentDatabaseAccess,
  useSetGuildDatabaseAccess,
} from "../../api/queries";
import type { AccessMode } from "../../api/types";
import {
  Button,
  Segmented,
  Banner,
  EmptyState,
  SkeletonRows,
  toast,
  Icon,
  Tag,
} from "@guildsrun/ui";
import { CreateTableDialog } from "./CreateTableDialog";

const modeLabel: Record<AccessMode | "none", string> = {
  none: "None",
  read: "Read",
  write: "Read & write",
};

function Page({
  intro,
  action,
  children,
}: {
  intro: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-10 md:py-6">
      <div className="mx-auto flex max-w-240 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-sm text-fg-2">{intro}</p>
          {action}
        </div>
        {children}
      </div>
    </div>
  );
}

function TableName({ id, name, purpose }: { id: string; name: string; purpose: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <Link
        to="/tables/$collectionId"
        params={{ collectionId: id }}
        className="w-fit font-mono text-sm font-medium hover:underline"
      >
        {name}
      </Link>
      <span className="truncate text-xs text-muted">{purpose}</span>
    </div>
  );
}

const failed = (error: Error) =>
  toast({ kind: "error", title: "Couldn't change the access", description: error.message });

/**
 * The tables a guild reaches: its own, which its agents write, and organisation tables by
 * the grant set here. Each agent can still narrow or widen its own access.
 */
export function GuildTablesTab() {
  const { guildId } = useParams({ from: "/guilds/$guildId" });
  const rows = useGuildDatabases(guildId);
  const setAccess = useSetGuildDatabaseAccess(guildId);
  const [creating, setCreating] = useState(false);

  return (
    <Page
      intro="Tables this guild's agents reach. Its own are always read and written; organisation tables take a grant."
      action={
        <Button size="sm" onClick={() => setCreating(true)}>
          <Icon icon={Plus} size={14} />
          New table
        </Button>
      }
    >
      {rows.isPending ? (
        <SkeletonRows rows={4} label="Loading tables" />
      ) : rows.isError ? (
        <Banner tone="error" title="Couldn't load the tables" meta={rows.error.message} />
      ) : rows.data.length === 0 ? (
        <EmptyState
          icon={Database}
          title="No tables yet"
          description="Create one for this guild or the organisation."
        />
      ) : (
        <div className="flex flex-col overflow-hidden rounded-xl bg-surface">
          {rows.data.map((row) => (
            <div
              key={row.collection_id}
              className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
            >
              <TableName id={row.collection_id} name={row.name} purpose={row.purpose} />
              {row.scope === "guild" ? (
                <Tag tone="tide" font="sans">
                  Guild only · Read & write
                </Tag>
              ) : (
                <Segmented
                  size="sm"
                  label={`${row.name} access`}
                  value={row.mode ?? "none"}
                  disabled={setAccess.isPending}
                  onValueChange={(mode) =>
                    setAccess.mutate(
                      { collectionId: row.collection_id, mode: mode === "none" ? null : mode },
                      { onError: failed },
                    )
                  }
                  options={(["none", "read", "write"] as const).map((mode) => ({
                    value: mode,
                    label: modeLabel[mode],
                  }))}
                />
              )}
            </div>
          ))}
        </div>
      )}
      <CreateTableDialog open={creating} onOpenChange={setCreating} guildId={guildId} />
    </Page>
  );
}

/**
 * The tables an agent reaches: what its guild grants, the agent's own choice over it, and the
 * access that results.
 */
export function AgentTablesTab() {
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  const rows = useAgentDatabases(agentId);
  const setAgent = useSetAgentDatabaseAccess(agentId);
  const setGuild = useSetGuildDatabaseAccess(guildId);
  const busy = setAgent.isPending || setGuild.isPending;

  return (
    <Page intro="Tables this agent reaches. The guild column applies to every agent in the guild; this agent's own choice overrides it.">
      {rows.isPending ? (
        <SkeletonRows rows={4} label="Loading tables" />
      ) : rows.isError ? (
        <Banner tone="error" title="Couldn't load the tables" meta={rows.error.message} />
      ) : rows.data.length === 0 ? (
        <EmptyState
          icon={Database}
          title="No tables yet"
          description="Tables are created on the Tables page."
        />
      ) : (
        <div className="flex flex-col overflow-hidden rounded-xl bg-surface">
          {rows.data.map((row) => (
            <div
              key={row.collection_id}
              className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line px-4 py-3 last:border-b-0"
            >
              <TableName id={row.collection_id} name={row.name} purpose={row.purpose} />
              <div className="flex flex-col gap-1">
                <span className="type-label text-muted">Guild</span>
                {row.scope === "guild" ? (
                  <Tag tone="tide" font="sans">
                    Read & write
                  </Tag>
                ) : (
                  <Segmented
                    size="sm"
                    label={`${row.name} guild access`}
                    value={row.guild_mode ?? "none"}
                    disabled={busy}
                    onValueChange={(mode) =>
                      setGuild.mutate(
                        { collectionId: row.collection_id, mode: mode === "none" ? null : mode },
                        { onError: failed },
                      )
                    }
                    options={(["none", "read", "write"] as const).map((mode) => ({
                      value: mode,
                      label: modeLabel[mode],
                    }))}
                  />
                )}
              </div>
              <div className="flex flex-col gap-1">
                <span className="type-label text-muted">This agent</span>
                <Segmented
                  size="sm"
                  label={`${row.name} agent access`}
                  value={row.agent_mode ?? "inherit"}
                  disabled={busy}
                  onValueChange={(mode) =>
                    setAgent.mutate(
                      { collectionId: row.collection_id, mode: mode === "inherit" ? null : mode },
                      { onError: failed },
                    )
                  }
                  options={[
                    { value: "inherit", label: "Inherit" },
                    ...(["none", "read", "write"] as const).map((mode) => ({
                      value: mode,
                      label: modeLabel[mode],
                    })),
                  ]}
                />
              </div>
              <Tag
                tone={
                  row.effective === "write" ? "tide" : row.effective === "read" ? "signal" : "well"
                }
                font="sans"
              >
                {row.effective ? modeLabel[row.effective] : "No access"}
              </Tag>
            </div>
          ))}
        </div>
      )}
    </Page>
  );
}
