import { ArrowLeft, Code, MessageCircleQuestion, Pencil, Table } from "lucide-react";
import { useState } from "react";
import { useStudioReferences, useStudioStateItem } from "../../../api/queries/studio";
import type { StateHistoryEntry, StateItemRow, StateTally } from "../../../api/types/studio";
import { relativeTime } from "../../../app/format";
import { Banner, Button, Icon, Segmented, SkeletonRows, StatBand, Tag } from "@guildsrun/ui";
import { DetailHeader, Empty } from "../MasterDetail";
import { useStudio } from "../StudioContext";
import { FileDetail } from "./ReferenceDetail";
import { ReferenceSection as Section } from "./referenceParts";
import { NoteEditor, TableRecords } from "./StateEditors";
import { itemSize, linkLabel, readHow, stateFlagLabels } from "./stateModel";

type Operation = "all" | "create" | "update" | "delete";

/**
 * One item of the guild's state: its numbers, who changes it and who reads it, what references
 * it, and its history; it opens in the notes browser, the records panel, or its agent's Scripts.
 */
export function StateItemDetail({
  row,
  hours,
  pending,
}: {
  row: StateItemRow;
  hours: number;
  pending: boolean;
}) {
  const { session, search, go } = useStudio();
  const [op, setOp] = useState<Operation>("all");
  const [editing, setEditing] = useState(false);
  const detail = useStudioStateItem(
    session.id,
    row.display_path,
    hours,
    op === "all" ? null : op,
  );
  const first = detail.data?.pages[0];
  const history = detail.data?.pages.flatMap((page) => page.history) ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() =>
          go({
            section: "state",
            ...(search.agent ? { agent: search.agent } : {}),
            tab: "list",
            ...(search.kind ? { kind: search.kind } : {}),
          })
        }
      >
        <Icon icon={ArrowLeft} size={14} />
        All items
      </Button>
      <DetailHeader
        title={row.title}
        meta={
          <span className="flex flex-col gap-1">
            <span className="font-mono break-all">{row.display_path}</span>
            <span className="flex flex-wrap items-center gap-1.5">
              {row.kind} · {row.level} · {itemSize(row)}
              {stateFlagLabels(row, pending).map((label) => (
                <Tag key={label} tone={label === "needs approval" ? "signal" : "ochre"} font="sans">
                  {label}
                </Tag>
              ))}
            </span>
          </span>
        }
        actions={<ItemActions row={row} editing={editing} onEdit={() => setEditing(!editing)} />}
      />
      {editing ? <ItemEditor row={row} /> : null}
      <StatBand
        className="rounded-lg"
        stats={[
          {
            value: row.kind === "table" ? itemSize(row) : `v${row.version ?? 1}`,
            label: row.kind === "table" ? "records" : "version",
          },
          { value: row.changes, label: "changes" },
          { value: row.reads, label: "reads" },
          {
            value: relativeTime(row.created_at),
            label: row.created_by ? `created by ${row.created_by}` : "created",
          },
        ]}
      />
      {detail.isError ? (
        <Banner tone="error" title="Couldn't load this item" meta={detail.error.message} />
      ) : !first ? (
        <SkeletonRows rows={4} label="Loading the item" />
      ) : (
        <>
          <TallySection title="Who changes it" tallies={first.changes} describe={(how) => how} />
          <TallySection title="Who reads it" tallies={first.reads} describe={readHow} />
          <ItemReferences path={row.display_path} />
          <Section title="History">
            <Segmented
              size="sm"
              label="Operation"
              value={op}
              onValueChange={setOp}
              options={[
                { value: "all", label: "All" },
                { value: "create", label: "Created" },
                { value: "update", label: "Changed" },
                { value: "delete", label: "Deleted" },
              ]}
            />
            {history.length ? (
              <ul className="flex flex-col gap-1">
                {history.map((entry) => (
                  <HistoryRow
                    key={`${entry.at}:${entry.record ?? ""}:${entry.operation}`}
                    entry={entry}
                  />
                ))}
              </ul>
            ) : (
              <Empty>No change is recorded.</Empty>
            )}
            {detail.hasNextPage ? (
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                disabled={detail.isFetchingNextPage}
                onClick={() => void detail.fetchNextPage()}
              >
                Load older changes
              </Button>
            ) : null}
          </Section>
        </>
      )}
    </div>
  );
}

const editLabels: Record<string, { label: string; icon: typeof Pencil }> = {
  note: { label: "Open text", icon: Pencil },
  memory: { label: "Open text", icon: Pencil },
  table: { label: "Open records", icon: Table },
};

function ItemActions({
  row,
  editing,
  onEdit,
}: {
  row: StateItemRow;
  editing: boolean;
  onEdit: () => void;
}) {
  const { go, ask } = useStudio();
  const edit = editLabels[row.kind];
  return (
    <>
      {edit ? (
        <Button variant={editing ? "primary" : "outline"} size="sm" onClick={onEdit}>
          <Icon icon={edit.icon} size={14} />
          {editing ? "Close" : edit.label}
        </Button>
      ) : null}
      {row.kind === "script" ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            go({ section: "agents", agent: row.owner_id, tab: "scripts", item: row.title })
          }
        >
          <Icon icon={Code} size={14} />
          Open source
        </Button>
      ) : null}
      {row.kind !== "table" ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            ask({
              kind: "file",
              ...(row.level === "agent" ? { agent_id: row.owner_id } : {}),
              display_path: row.display_path,
              label: `File · ${row.title}`,
            })
          }
        >
          <Icon icon={MessageCircleQuestion} size={14} />
          Ask the coach
        </Button>
      ) : null}
    </>
  );
}

/** Today's notes browser or records panel, opened on the item, so editing stays in State. */
function ItemEditor({ row }: { row: StateItemRow }) {
  const { agents } = useStudio();
  if (row.kind === "table" && row.collection_id) {
    return <TableRecords collectionId={row.collection_id} />;
  }
  const agent =
    row.level === "agent" ? (agents.find((item) => item.id === row.owner_id) ?? null) : null;
  return <NoteEditor agent={agent} path={row.display_path} />;
}

function TallySection({
  title,
  tallies,
  describe,
}: {
  title: string;
  tallies: StateTally[];
  describe: (how: string) => string;
}) {
  return (
    <Section title={title}>
      {tallies.length ? (
        <ul className="flex flex-col gap-1">
          {tallies.map((tally) => (
            <li
              key={`${tally.actor.kind}:${tally.actor.id}:${tally.how}`}
              className="flex items-center gap-3 rounded-md bg-surface px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{tally.actor.name}</span>
              <span className="text-xs text-fg-2">{describe(tally.how)}</span>
              <span className="w-10 text-right font-mono text-xs">{tally.count}×</span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>None in this window.</Empty>
      )}
    </Section>
  );
}

/** What the item embeds or names and what embeds or names it, from the References view. */
function ItemReferences({ path }: { path: string }) {
  const { session, search, go } = useStudio();
  const references = useStudioReferences(session.id);
  const node = references.data?.nodes.find((entry) => entry.id === path);
  if (!references.data || !node) return null;
  return (
    <FileDetail
      data={references.data}
      node={node}
      onSelect={(id) =>
        go({
          section: "state",
          ...(search.agent ? { agent: search.agent } : {}),
          tab: "list",
          item: id,
        })
      }
    />
  );
}

function HistoryRow({ entry }: { entry: StateHistoryEntry }) {
  const { session, openStep } = useStudio();
  const link = entry.link;
  const label = linkLabel(link, session.id);
  return (
    <li className="flex items-center gap-3 rounded-md bg-surface px-3 py-2 text-sm">
      <span className="w-20 shrink-0 text-xs text-muted" title={entry.at}>
        {relativeTime(entry.at)}
      </span>
      <Tag tone={entry.operation === "delete" ? "plum" : "well"} font="sans">
        {entry.operation}
      </Tag>
      <span className="w-28 shrink-0 truncate font-mono text-xs">{entry.actor.name}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-fg-2">
        {entry.summary ?? entry.record?.split("/").pop() ?? ""}
      </span>
      {link?.kind === "run" && link.agent_id && label ? (
        <Button
          variant="ghost"
          size="xs"
          onClick={() =>
            openStep({ agentId: link.agent_id ?? "", runId: link.run_id, call: link.call_id })
          }
        >
          {label}
        </Button>
      ) : label ? (
        <span className="text-xs text-muted">{label}</span>
      ) : null}
    </li>
  );
}
