import { useParams } from "@tanstack/react-router";
import { useAgentUsage } from "../../../api/queries";
import { messageTime } from "../../../app/format";
import { Button, StatBand, Banner, SkeletonRows } from "@guildsrun/ui";
import { DiskMeter } from "../../machines/MachineMeters";
import { formatCost } from "../runs/toolFormat";

const count = new Intl.NumberFormat();

/**
 * What the agent's model and browse calls have used since it was made, and its disk: its home
 * against its own cap, and every home on its machine against the machine's cap.
 */
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
                ...(usage.data.browser_calls > 0
                  ? [
                      {
                        label: `Browser, ${count.format(usage.data.browser_calls)} calls`,
                        value: formatCost(usage.data.browser_cost_usd),
                      },
                    ]
                  : []),
              ]}
            />
            <p className="text-xs text-muted">
              {usage.data.updated_at
                ? `Last counted ${messageTime(usage.data.updated_at)}. Total tokens are input plus output; cache reads are counted apart.`
                : "No model calls yet."}
            </p>
            <section aria-label="Disk" className="flex flex-col gap-3">
              <h3 className="type-label text-muted">Disk</h3>
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-semibold">
                  Its home, <span className="font-mono">/home/{usage.data.id}</span>
                </span>
                <DiskMeter
                  usedMib={usage.data.workspace_mib}
                  maxMib={usage.data.max_workspace_mib}
                  label="The agent's home against its cap"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-semibold">
                  Its machine, <span className="font-mono">{usage.data.machine.name}</span>
                </span>
                <DiskMeter
                  usedMib={usage.data.machine.workspace_mib}
                  maxMib={usage.data.machine.max_workspace_mib}
                  label="Every home on the machine against the machine's cap"
                />
              </div>
              <p className="text-xs text-muted">
                A generation will not start while the home or the machine is over its cap. Free space
                from the CLI tab.
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
