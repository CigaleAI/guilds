import { Link } from "@tanstack/react-router";
import { ExternalLink, Pin } from "lucide-react";
import { useAgentScripts } from "../../../api/queries/scripts";
import type { Script, StudioAgent } from "../../../api/types";
import { Button, Banner, SkeletonRows, Icon, Row, Tag } from "@guildsrun/ui";
import { DetailHeader, Empty, MasterDetail } from "../MasterDetail";
import { useStudio } from "../StudioContext";
import { ChangeBar } from "./ChangeBar";

/** The agent's scripts: what each does, its tool parameters, its source and who changed it last. */
export function ScriptsTab({ agent }: { agent: StudioAgent }) {
  const { search, go } = useStudio();
  const scripts = useAgentScripts(agent.id);

  if (scripts.isPending) return <SkeletonRows rows={4} label="Loading scripts" className="p-5" />;
  if (scripts.isError) {
    return (
      <div className="p-5">
        <Banner tone="error" title="Couldn't load the scripts" meta={scripts.error.message} />
      </div>
    );
  }

  const selected = scripts.data.find((script) => script.name === search.item) ?? scripts.data[0];

  return (
    <MasterDetail
      listLabel={`${agent.name}'s scripts`}
      toolbar={
        <span className="type-meta text-muted">
          {scripts.data.length} script{scripts.data.length === 1 ? "" : "s"}
        </span>
      }
      list={
        scripts.data.length ? (
          scripts.data.map((script) => {
            const isSelected = script.name === selected?.name;
            return (
              <Row
                key={script.name}
                asChild
                density="compact"
                interactive
                selected={isSelected}
                mono
                title={script.name}
                meta={script.description}
                trail={
                  script.parameters ? (
                    <Tag tone={isSelected ? "on-plum" : "well"} font="sans">
                      tool
                    </Tag>
                  ) : null
                }
              >
                <button
                  type="button"
                  aria-current={isSelected ? "true" : undefined}
                  onClick={() =>
                    go(
                      { section: "agents", agent: agent.id, tab: "scripts", item: script.name },
                      { replace: true },
                    )
                  }
                />
              </Row>
            );
          })
        ) : (
          <Empty>No scripts.</Empty>
        )
      }
      detail={
        selected ? (
          <ScriptDetail agent={agent} script={selected} />
        ) : (
          <Empty>
            This agent has no scripts. Scripts are the only way it runs code on its machine.
          </Empty>
        )
      }
    />
  );
}

function ScriptDetail({ agent, script }: { agent: StudioAgent; script: Script }) {
  const { session, ask } = useStudio();
  return (
    <>
      <DetailHeader
        title={<span className="font-mono">{script.name}</span>}
        meta={
          script.parameters
            ? "Offered to the agent as a tool of its own."
            : "Run through script_run."
        }
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link
                to="/guilds/$guildId/agents/$agentId/state/scripts"
                params={{ guildId: session.source_guild_id, agentId: agent.id }}
              >
                <Icon icon={ExternalLink} size={14} />
                Edit in agent
              </Link>
            </Button>
            {script.display_path ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  ask({
                    kind: "file",
                    agent_id: agent.id,
                    display_path: script.display_path,
                    label: `${agent.name} · script · ${script.name}`,
                  })
                }
              >
                <Icon icon={Pin} size={14} />
                Ask the coach
              </Button>
            ) : null}
          </>
        }
      />
      {script.description ? <p className="text-sm text-fg-2">{script.description}</p> : null}
      {script.display_path ? <ChangeBar displayPath={script.display_path} /> : null}
      {script.parameters ? (
        <section className="flex flex-col gap-2">
          <h3 className="type-label text-muted">Parameters</h3>
          <pre className="overflow-x-auto rounded-lg bg-surface px-4 py-3 font-mono text-xs">
            {JSON.stringify(script.parameters, null, 2)}
          </pre>
        </section>
      ) : null}
      <section className="flex flex-col gap-2">
        <h3 className="type-label text-muted">Source · scripts/{script.name}.py</h3>
        <pre className="overflow-x-auto rounded-lg bg-surface px-4 py-3 font-mono text-xs">
          {script.source}
        </pre>
      </section>
    </>
  );
}
