import { useMemo } from "react";
import { Waypoints } from "lucide-react";
import { Banner, EmptyState, SkeletonRows } from "@guildsrun/ui";
import { useStudioReferences, useStudioState } from "../../../api/queries/studio";
import type { StudioAgent, StudioReferences } from "../../../api/types/studio";
import { Empty } from "../MasterDetail";
import { useStudio } from "../StudioContext";
import { ReferenceDetail } from "./ReferenceDetail";
import { ReferencesMap } from "./ReferencesMap";
import { NodeRow, ReferenceSection } from "./referenceParts";
import { referenceMapView, shownIds, standoutGroups } from "./referencesModel";
import { storedStateHours } from "./StateList";

/** What each Task and file in the guild's state embeds or names, filtered to one agent's runs. */
export function ReferencesView({
  agent,
  onSelect,
}: {
  agent: StudioAgent | null;
  onSelect: (id: string) => void;
}) {
  const { session, search } = useStudio();
  const references = useStudioReferences(session.id);
  if (references.isPending) {
    return <SkeletonRows rows={5} label="Loading references" className="p-5" />;
  }
  if (references.isError) {
    return (
      <div className="p-5">
        <Banner tone="error" title="Couldn't load the references" meta={references.error.message} />
      </div>
    );
  }
  return (
    <ReferencesBody
      data={references.data}
      agent={agent}
      selectedId={search.item ?? null}
      onSelect={onSelect}
    />
  );
}

function ReferencesBody({
  data,
  agent,
  selectedId,
  onSelect,
}: {
  data: StudioReferences;
  agent: StudioAgent | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const view = useMemo(() => referenceMapView(data, agent?.id), [data, agent?.id]);
  const shown = useMemo(() => shownIds(view), [view]);
  if (!shown.size) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Waypoints}
          title="Nothing to draw"
          description={
            agent
              ? `${agent.name}'s Task embeds nothing, and it has no notes of its own.`
              : "The guild has no Tasks or files yet."
          }
        />
      </div>
    );
  }
  const selected = data.nodes.find((node) => node.id === selectedId && shown.has(node.id)) ?? null;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-5">
      <section className="flex flex-col gap-3">
        <ReferencesMap
          data={data}
          view={view}
          selected={selected?.id ?? null}
          onSelect={onSelect}
        />
        <p className="text-xs text-muted">
          A solid line is an embed, a dotted line a path named in the text. Red is not reachable for
          a run that inlines it; ochre stays text because a run does not inline that deep.
        </p>
        {view.deeper.length ? (
          <ReferenceSection title="Deeper than the map">
            {view.deeper.map((node) => (
              <NodeRow
                key={node.id}
                node={node}
                meta={`${node.depth} hops from a Task`}
                onSelect={onSelect}
              />
            ))}
          </ReferenceSection>
        ) : null}
      </section>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Standouts data={data} shown={shown} onSelect={onSelect} />
        {selected ? (
          <ReferenceDetail key={selected.id} data={data} node={selected} onSelect={onSelect} />
        ) : (
          <Empty>
            Select a Task or file on the map to see what it pulls in and what pulls it in.
          </Empty>
        )}
      </div>
    </div>
  );
}

/** Broken embeds, Tasks over budget, shared notes, notes too deep, and files nothing points to. */
function Standouts({
  data,
  shown,
  onSelect,
}: {
  data: StudioReferences;
  shown: ReadonlySet<string>;
  onSelect: (id: string) => void;
}) {
  const { session } = useStudio();
  const state = useStudioState(session.id, storedStateHours(), null, null);
  const read = new Set(
    (state.data ?? []).filter((row) => row.reads > 0).map((row) => row.display_path),
  );
  const groups = standoutGroups(data, shown, read);
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">What stands out</h2>
      {groups.length ? (
        groups.map((group) => (
          <ReferenceSection key={group.title} title={group.title}>
            {group.rows.map(({ node, meta }) => (
              <NodeRow key={node.id} node={node} meta={meta} onSelect={onSelect} />
            ))}
          </ReferenceSection>
        ))
      ) : (
        <Empty>Every embed resolves and every file is in use.</Empty>
      )}
    </section>
  );
}
