import { Link } from "@tanstack/react-router";
import { Segmented, Select, cn, tabsList, tabsTrigger } from "@guildsrun/ui";
import { studioStateKinds, studioStateViews, studioTabLabel, type StudioSearch } from "../location";
import { useStudio } from "../StudioContext";
import { StateList } from "./StateList";
import { ReferencesView } from "./ReferencesView";

const allAgents = "all";

/** The guild's notes, tables, scripts and Memory: a list to work in, or what references what. */
export function StateSection() {
  const { agents, search, goInPlace } = useStudio();
  const agent = agents.find((item) => item.id === search.agent) ?? null;
  return (
    <>
      <StateBar />
      <div className="flex min-h-0 flex-1 flex-col">
        {search.tab === "references" ? (
          <ReferencesView
            agent={agent}
            onSelect={(item) => goInPlace({ ...stateFilters(search), item })}
          />
        ) : (
          <StateList />
        )}
      </div>
    </>
  );
}

const kindLabel: Record<string, string> = {
  all: "All",
  note: "Notes",
  table: "Tables",
  script: "Scripts",
  memory: "Memory",
};

/** The view, the agent filter, and in the list which kind of item it shows. */
function StateBar() {
  const { session, agents, search, goInPlace } = useStudio();
  const view = search.tab === "references" ? "references" : "list";
  const filters = stateFilters(search);
  const setAgent = (value: string) => {
    const { agent: _agent, ...rest } = filters;
    goInPlace(value === allAgents ? rest : { ...rest, agent: value });
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
          value={search.kind ?? "all"}
          onValueChange={(value) => {
            const { kind: _kind, ...rest } = filters;
            const kind = studioStateKinds.find((entry) => entry === value);
            goInPlace(kind ? { ...rest, kind } : rest);
          }}
          options={["all", ...studioStateKinds].map((value) => ({
            value,
            label: kindLabel[value] ?? value,
          }))}
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
