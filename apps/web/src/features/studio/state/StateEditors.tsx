import { useDatabase } from "../../../api/queries/tables";
import type { StudioAgent } from "../../../api/types";
import { Banner, SkeletonRows } from "@guildsrun/ui";
import { RecordsPanel } from "../../tables/RecordsPanel";
import { NotesBrowser, type NoteScope } from "../../notes/NotesBrowser";
import { useStudio } from "../StudioContext";

const enc = encodeURIComponent;

/**
 * The notes browser opened at one note: the agent's notes when it belongs to one, the guild's
 * and the organisation's, with changes opened in Studio.
 */
export function NoteEditor({ agent, path }: { agent: StudioAgent | null; path: string }) {
  const { session, openStep, ask } = useStudio();
  const guildId = session.source_guild_id;
  const shared: NoteScope[] = [
    { id: "guild", title: "Guild", prefix: `/api/guilds/${enc(guildId)}/notes` },
    { id: "org", title: "Org", prefix: "/api/org/notes" },
  ];
  const scopes: NoteScope[] = agent
    ? [{ id: "agent", title: "Agent", prefix: `/api/agents/${enc(agent.id)}/notes` }, ...shared]
    : shared;
  return (
    <div className="flex min-h-[32rem] flex-col rounded-lg border border-line">
      <NotesBrowser
        key={`${agent?.id ?? "guild"}:${path}`}
        guildId={guildId}
        {...(agent ? { agentId: agent.id } : {})}
        scopes={scopes}
        initialPath={path}
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

/** One table's records, to search and edit. */
export function TableRecords({ collectionId }: { collectionId: string }) {
  const table = useDatabase(collectionId);
  if (table.isError) {
    return <Banner tone="error" title="Couldn't open the table" meta={table.error.message} />;
  }
  if (!table.data) return <SkeletonRows rows={5} label="Loading the table" />;
  return (
    <div className="flex min-h-[32rem] flex-col">
      <RecordsPanel key={table.data.id} collection={table.data} />
    </div>
  );
}
