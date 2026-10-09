import { useParams } from "@tanstack/react-router";
import { useAgentUsage } from "../../../api/queries";
import { messageTime } from "../../../app/format";
import { Button, StatBand, Banner, SkeletonRows } from "@guildsrun/ui";
import { formatCost } from "../runs/toolFormat";
import { formatMib } from "./AgentSettings";

const count = new Intl.NumberFormat();

/** What the agent's model calls and workspace have used since it was made. */
export function AgentUsage() {
  const { agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  const usage = useAgentUsage(agentId);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
      <div className="mx-auto flex max-w-240 flex-col gap-4">
        <p className="text-sm text-fg-2">
          Totals since the agent was made, across every session. Cost is what the provider reported,
          or the catalog rate when it reported none.
        </p>
        {usage.isPending ? (
          <SkeletonRows rows={2} label="Loading usage" />
        ) : usage.isError ? (
          <Banner
            tone="error"
            title="Couldn't load usage"
            meta={usage.error.message}
            action={
              <Button variant="outline" size="sm" onClick={() => void usage.refetch()}>
                Retry
              </Button>
            }
          />
        ) : (
          <>
            <StatBand
              stats={[
                { label: "Cost", value: formatCost(usage.data.cost_usd) },
                { label: "Model calls", value: count.format(usage.data.calls) },
                { label: "Input tokens", value: count.format(usage.data.input_tokens) },
                { label: "Output tokens", value: count.format(usage.data.output_tokens) },
                { label: "Total tokens", value: count.format(usage.data.total_tokens) },
                { label: "Cache reads", value: count.format(usage.data.cache_read_tokens) },
              ]}
            />
            <p className="text-xs text-muted">
              {usage.data.updated_at
                ? `Last counted ${messageTime(usage.data.updated_at)}. Total tokens are input plus output; cache reads are counted apart.`
                : "No model calls yet."}
            </p>
            <section aria-label="Disk" className="flex flex-col gap-1.5">
              <h3 className="type-label text-muted">Disk</h3>
              <StatBand
                stats={[
                  {
                    label: "Used",
                    value:
                      usage.data.workspace_mib === null
                        ? "—"
                        : formatMib(usage.data.workspace_mib),
                  },
                  { label: "Max", value: formatMib(usage.data.max_workspace_mib) },
                ]}
              />
              <p className="text-xs text-muted">
                {usage.data.workspace_mib === null
                  ? "Not measured yet. Disk is measured after a generation. Free space from the CLI tab."
                  : `The workspace holds ${formatMib(usage.data.workspace_mib)} of ${formatMib(usage.data.max_workspace_mib)}. Measured after the last generation. Free space from the CLI tab.`}
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
