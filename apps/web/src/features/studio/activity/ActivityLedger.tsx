import { RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { useStudioActivity } from "../../../api/queries";
import {
  IconButton,
  Segmented,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Banner,
  SkeletonRows,
  OutcomeLegend,
  wakeOutcomeLabel,
} from "@guildsrun/ui";
import { useStudio } from "../StudioContext";
import {
  ACTIVITY_DEFAULT_HOURS,
  ACTIVITY_WINDOW_HOURS,
  WAKE_BUCKETS,
  buildActivityMap,
  buildChains,
  emptyCounts,
  formatUsd,
  indexActivity,
  plural,
  sameSelection,
  selectionExists,
  selectionFromItem,
  selectionItem,
  wakeBucket,
  windowLabel,
  type MapSelection,
} from "./activityModel";
import { ActivityMap } from "./ActivityMap";
import { AgentActivityList } from "./AgentActivity";
import { ChainList } from "./ChainList";
import type { ActivityData } from "./parts";

const hoursKey = "studio.activity.hours";
const tabKey = "studio.activity.tab";
type ActivityTab = "flow" | "agents";

function stored<T>(key: string, read: (value: string | null) => T): T {
  try {
    return read(localStorage.getItem(key));
  } catch {
    return read(null);
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Without storage the choice resets on the next visit.
  }
}

/**
 * The guild's activity over a window of hours. Flow maps who woke whom and lists every chain of
 * wakes, from what started it to where it stopped; a line or box selected on the map narrows the
 * chains to those passing through it. Agents adds up what woke each agent and what it did.
 */
export function ActivityLedger() {
  const { session, search, go } = useStudio();
  const [hours, setHours] = useState(() =>
    stored(hoursKey, (value) =>
      ACTIVITY_WINDOW_HOURS.includes(Number(value)) ? Number(value) : ACTIVITY_DEFAULT_HOURS,
    ),
  );
  const [tab, setTab] = useState<ActivityTab>(() =>
    stored(tabKey, (value) => (value === "agents" ? "agents" : "flow")),
  );
  const activity = useStudioActivity(session.id, hours);

  const data = useMemo<ActivityData | null>(() => {
    if (!activity.data) return null;
    const index = indexActivity(activity.data);
    const chains = buildChains(activity.data, index);
    return { view: activity.data, index, chains, map: buildActivityMap(activity.data, chains) };
  }, [activity.data]);

  const wanted = selectionFromItem(search.item);
  const selection = data && wanted && selectionExists(data.map, wanted) ? wanted : null;
  const select = (next: MapSelection | null) =>
    go(
      {
        tab: "overview",
        ...(next && !sameSelection(selection, next) ? { item: selectionItem(next) } : {}),
      },
      { replace: true },
    );
  const switchTab = (next: ActivityTab) => {
    setTab(next);
    store(tabKey, next);
  };

  const wakes = data?.view.wakes ?? [];
  const counts = emptyCounts();
  for (const wake of wakes) counts[wakeBucket(wake)] += 1;
  const cost = wakes.reduce((sum, wake) => sum + wake.cost_usd, 0);

  return (
    <section
      aria-label="Activity"
      className="flex min-w-0 flex-col gap-3"
      onKeyDown={(event) => {
        if (event.key === "Escape" && selection) select(null);
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="type-label text-muted">Activity</h2>
        <Segmented
          size="sm"
          label="Window"
          value={String(hours)}
          onValueChange={(value) => {
            setHours(Number(value));
            store(hoursKey, value);
          }}
          options={ACTIVITY_WINDOW_HOURS.map((value) => ({
            value: String(value),
            label: windowLabel(value),
          }))}
        />
        <span className="min-w-0 flex-1 truncate text-xs text-muted">
          {data && wakes.length
            ? [
                plural(data.chains.length, "chain"),
                plural(wakes.length, "wake"),
                ...WAKE_BUCKETS.filter((outcome) => counts[outcome]).map(
                  (outcome) => `${counts[outcome]} ${wakeOutcomeLabel[outcome]}`,
                ),
                formatUsd(cost),
              ].join(" · ")
            : ""}
        </span>
        <IconButton
          icon={RefreshCw}
          label="Refresh"
          variant="ghost"
          size={28}
          disabled={activity.isFetching}
          onClick={() => void activity.refetch()}
        />
      </div>

      {activity.isError ? (
        <Banner tone="error" title="Couldn't load the activity" meta={activity.error.message} />
      ) : !data ? (
        <SkeletonRows rows={5} label="Loading activity" />
      ) : !wakes.length && !data.map.sources.length ? (
        <p className="rounded-lg bg-surface px-4 py-6 text-center text-sm text-muted">
          Nothing ran in the last {windowLabel(hours)}. Pick a longer window.
        </p>
      ) : (
        <Tabs
          value={tab}
          onValueChange={(value) => switchTab(value === "agents" ? "agents" : "flow")}
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <TabsList>
              <TabsTrigger value="flow">Flow</TabsTrigger>
              <TabsTrigger value="agents">Agents</TabsTrigger>
            </TabsList>
            <OutcomeLegend lead="Each wake:" />
          </div>
          <TabsContent value="flow" className="mt-3 flex flex-col gap-4 rounded-xl bg-surface p-4">
            <header className="flex flex-col gap-1">
              <h3 className="text-md font-semibold">Who woke whom</h3>
              <p className="text-xs text-muted">
                Routines, your messages and direct chats on the left; agents to the right. A grey
                line is a wake a routine or you started, a blue one a wake an agent&apos;s post
                started; thicker lines happened more often. Click a line or a box to list only those
                chains.
              </p>
            </header>
            <ActivityMap data={data} selection={selection} onSelect={select} />
            <ChainList
              key={selection ? selectionItem(selection) : "all"}
              data={data}
              selection={selection}
              onClear={() => select(null)}
            />
          </TabsContent>
          <TabsContent value="agents" className="mt-3">
            <AgentActivityList
              data={data}
              onShowChains={(next) => {
                switchTab("flow");
                if (!sameSelection(selection, next)) select(next);
              }}
            />
          </TabsContent>
        </Tabs>
      )}
    </section>
  );
}
