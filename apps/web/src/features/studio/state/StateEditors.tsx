import { useDatabase } from "../../../api/queries/tables";
import type { ReachSubject } from "../../../api/types/access";
import { Banner, SkeletonRows } from "@guildsrun/ui";
import { RecordsPanel } from "../../tables/RecordsPanel";
import { itemBrowserKey } from "../../access/listedItems";
import { NotesBrowser } from "../../notes/NotesBrowser";
import { useStudio } from "../StudioContext";

type NoteEditorProps = { path: string };

/**
 * The notes browser of the session's guild opened at one note: the guild's own notes and those
 * shared with it, with changes opened in Studio.
 */
export function NoteEditor({ path }: NoteEditorProps) {
  const { session, openStep, ask } = useStudio();
  const guildId = session.source_guild_id;
  const page: ReachSubject = { type: "guild", id: guildId };
  return (
    <div className="flex min-h-[32rem] flex-col rounded-lg border border-line">
      <NotesBrowser
        key={itemBrowserKey(page, path)}
        guildId={guildId}
        page={page}
        initialPath={path}
        onAsk={(item) =>
          ask({
            kind: "file",
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

type TableRecordsProps = { collectionId: string };

/** One table's records, to search and edit. */
export function TableRecords({ collectionId }: TableRecordsProps) {
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
