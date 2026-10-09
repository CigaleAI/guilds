import { useDatabase, useDatabases } from "../../../api/queries";
import type { StudioAgent } from "../../../api/types";
import { Select, Banner, SkeletonRows } from "@guildsrun/ui";
import { RecordsPanel } from "../../databases/RecordsPanel";
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

/** The organisation's databases, one at a time, with its records to search and edit. */
export function DatabasesTab({ agent }: { agent: StudioAgent | null }) {
  const { search, go } = useStudio();
  const databases = useDatabases();
  const id = search.item ?? databases.data?.[0]?.id;
  const database = useDatabase(id);

  if (databases.isPending)
    return <SkeletonRows rows={4} label="Loading databases" className="p-5" />;
  if (databases.isError) {
    return (
      <div className="p-5">
        <Banner tone="error" title="Couldn't load the databases" meta={databases.error.message} />
      </div>
    );
  }
  if (!databases.data.length) return <Empty>The organisation has no databases yet.</Empty>;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
      <Select
        tone="surface"
        label="Database"
        mono
        className="max-w-sm"
        value={id ?? ""}
        onValueChange={(value) =>
          go(
            { ...(agent ? { agent: agent.id } : {}), tab: "databases", item: value },
            { replace: true },
          )
        }
        options={databases.data.map((item) => ({ value: item.id, label: item.name }))}
      />
      {database.data ? (
        <RecordsPanel key={database.data.id} collection={database.data} />
      ) : database.isError ? (
        <Banner tone="error" title="Couldn't open the database" meta={database.error.message} />
      ) : (
        <SkeletonRows rows={5} label="Loading the database" />
      )}
    </div>
  );
}
