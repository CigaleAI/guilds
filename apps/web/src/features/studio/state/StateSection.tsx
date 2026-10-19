import { Link } from "@tanstack/react-router";
import { Waypoints } from "lucide-react";
import { EmptyState, Segmented, Select, cn, tabsList, tabsTrigger } from "@guildsrun/ui";
import {
  studioStateViews,
  studioTabLabel,
  type StudioSearch,
  type StudioStateKind,
} from "../location";
import { useStudio } from "../StudioContext";
import { StateNotes, StateTables } from "./StateList";

const allAgents = "all";

/** The guild's notes, tables, scripts and Memory: a list to work in, or what references what. */
export function StateSection() {
  const { agents, search } = useStudio();
  const agent = agents.find((item) => item.id === search.agent) ?? null;
  const kind: StudioStateKind = search.kind ?? "notes";
  return (
    <>
      <StateBar kind={kind} />
      <div className="flex min-h-0 flex-1 flex-col">
        {search.tab === "references" ? (
          <div className="p-6">
            <EmptyState
              icon={Waypoints}
              title="References"
              description="What each Task and note embeds or names shows here."
            />
          </div>
        ) : kind === "tables" ? (
          <StateTables agent={agent} />
        ) : (
          <StateNotes agent={agent} />
        )}
      </div>
    </>
  );
}

/** The view, the agent filter, and in the list which kind of item it shows. */
function StateBar({ kind }: { kind: StudioStateKind }) {
  const { session, agents, search, go } = useStudio();
  const view = search.tab === "references" ? "references" : "list";
  const filters = stateFilters(search);
  const setAgent = (value: string) => {
    const { agent: _agent, ...rest } = filters;
    go(value === allAgents ? rest : { ...rest, agent: value }, { replace: true });
  };
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
      <nav aria-label="State views" className={cn(tabsList({ look: "track" }), "w-auto")}>
        {studioStateViews.map((value) => (
          <Link
            key={value}
            to="/studio/$sessionId"
            params={{ sessionId: session.id }}
            search={{ ...filters, tab: value }}
            aria-current={value === view ? "page" : undefined}
            className={tabsTrigger({ look: "track" })}
          >
            {studioTabLabel[value]}
          </Link>
        ))}
      </nav>
      <Select
        tone="surface"
        aria-label="Agent"
        className="w-48"
        value={search.agent ?? allAgents}
        onValueChange={setAgent}
        options={[
          { value: allAgents, label: "All agents" },
          ...agents.map((item) => ({ value: item.id, label: item.name })),
        ]}
      />
      {view === "list" ? (
        <Segmented
          size="sm"
          label="Show"
          value={kind}
          onValueChange={(value) => go({ ...filters, kind: value }, { replace: true })}
          options={[
            { value: "notes", label: "Notes" },
            { value: "tables", label: "Tables" },
          ]}
        />
      ) : null}
    </div>
  );
}

/** What State keeps when its view or filters change; the selection is dropped. */
function stateFilters(search: StudioSearch): StudioSearch {
  return {
    section: "state",
    ...(search.agent ? { agent: search.agent } : {}),
    ...(search.tab ? { tab: search.tab } : {}),
    ...(search.kind ? { kind: search.kind } : {}),
  };
}
