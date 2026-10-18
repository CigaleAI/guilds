import { useDatabase, useDatabases } from "../../../api/queries";
import type { StudioAgent } from "../../../api/types";
import { Select, Banner, SkeletonRows } from "@guildsrun/ui";
import { RecordsPanel } from "../../tables/RecordsPanel";
import { FileBrowser, type FileScope } from "../../files/FileBrowser";
import { useStudio } from "../StudioContext";
import { Empty } from "../MasterDetail";

const enc = encodeURIComponent;

/** The notes an agent reads, or the guild's and organisation's, with changes opened in Studio. */
export function FilesTab({ agent }: { agent: StudioAgent | null }) {
  const { session, search, openStep, ask } = useStudio();
  const guildId = session.source_guild_id;
  const shared: FileScope[] = [
    { id: "guild", title: "Guild", prefix: `/api/guilds/${enc(guildId)}/files` },
    { id: "org", title: "Org", prefix: "/api/org/files" },
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FileBrowser
        key={`${agent?.id ?? "guild"}:${search.item ?? ""}`}
        guildId={guildId}
        {...(agent ? { agentId: agent.id } : {})}
        scopes={
          agent
            ? [
                {
                  id: "agent",
                  title: "Agent",
                  prefix: `/api/agents/${enc(agent.id)}/files`,
                },
                ...shared,
              ]
            : shared
        }
        initialPath={search.item}
        onAsk={(item) =>
          ask({
            kind: "file",
            ...(agent ? { agent_id: agent.id } : {}),
            display_path: item.display_path,
            label: `File · ${item.path}`,
          })
        }
        onOpenStep={(change) =>
          openStep({
            agentId: change.run.agent_id,
            runId: change.run.id,
            call: change.tool?.call_id ?? null,
          })
        }
      />
    </div>
  );
}

/** The organisation's tables, one at a time, with its records to search and edit. */
export function TablesTab({ agent }: { agent: StudioAgent | null }) {
  const { search, go } = useStudio();
  const tables = useDatabases();
  const id = search.item ?? tables.data?.[0]?.id;
  const table = useDatabase(id);

  if (tables.isPending)
    return <SkeletonRows rows={4} label="Loading tables" className="p-5" />;
  if (tables.isError) {
    return (
      <div className="p-5">
        <Banner tone="error" title="Couldn't load the tables" meta={tables.error.message} />
      </div>
    );
  }
  if (!tables.data.length) return <Empty>The organisation has no tables yet.</Empty>;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
      <Select
        tone="surface"
        label="Table"
        mono
        className="max-w-sm"
        value={id ?? ""}
        onValueChange={(value) =>
          go(
            { ...(agent ? { agent: agent.id } : {}), tab: "tables", item: value },
            { replace: true },
          )
        }
        options={tables.data.map((item) => ({ value: item.id, label: item.name }))}
      />
      {table.data ? (
        <RecordsPanel key={table.data.id} collection={table.data} />
      ) : table.isError ? (
        <Banner tone="error" title="Couldn't open the table" meta={table.error.message} />
      ) : (
        <SkeletonRows rows={5} label="Loading the table" />
      )}
    </div>
  );
}
