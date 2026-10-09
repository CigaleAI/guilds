import { Link, useParams } from "@tanstack/react-router";
import { useGuildUsage } from "../../../api/queries";
import { agentLook } from "../../../app/agents";
import { Button, StatBand, Banner, SkeletonRows, Avatar, Row } from "@guildsrun/ui";
import { formatCost } from "../../agent/runs/toolFormat";
import { GuildPage } from "./GuildPage";

const count = new Intl.NumberFormat();

/** What the guild's agents have used since each was made, in total and by agent. */
export function GuildUsage() {
  const { guildId } = useParams({ from: "/guilds/$guildId" });
  const usage = useGuildUsage(guildId);

  return (
    <GuildPage>
      <p className="text-sm text-fg-2">
        Totals across the guild's agents since each was made. Deleted agents' spend stays in the
        organisation's usage.
      </p>
      {usage.isPending ? (
        <SkeletonRows rows={4} label="Loading usage" />
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
          <section aria-label="By agent" className="flex flex-col gap-1.5">
            <h3 className="type-label text-muted">By agent</h3>
            {usage.data.agents.length === 0 ? (
              <p className="text-sm text-muted">No agents in this guild.</p>
            ) : (
              usage.data.agents.map((agent) => (
                <Row
                  key={agent.id}
                  asChild
                  tone="surface"
                  interactive
                  mono
                  lead={<Avatar name={agent.name} size={28} {...agentLook(agent)} />}
                  title={agent.name}
                  meta={`${count.format(agent.calls)} model calls`}
                  trail={
                    <span className="flex items-baseline gap-4 font-mono text-sm">
                      <span className="text-muted">{count.format(agent.total_tokens)} tok</span>
                      <span className="w-20 text-right font-semibold">
                        {formatCost(agent.cost_usd)}
                      </span>
                    </span>
                  }
                >
                  <Link
                    to="/guilds/$guildId/agents/$agentId/usage"
                    params={{ guildId, agentId: agent.id }}
                  />
                </Row>
              ))
            )}
          </section>
        </>
      )}
    </GuildPage>
  );
}
