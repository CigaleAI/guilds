import type { StudioDraft } from "../../../api/types/studio";
import { agentLook } from "../../../app/agents";
import { relativeTime } from "../../../app/format";
import { Button, Markdown, Avatar } from "@guildsrun/ui";
import { useStudio } from "../StudioContext";
import { warningLabel } from "../warnings";

/** The guild at a glance: its description, drafts waiting on the operator, and its agents. */
export function OverviewTab({ pending }: { pending: StudioDraft[] }) {
  const { session, agents, go } = useStudio();
  const about = session.source_guild?.about;
  const objective = session.source_guild?.objective?.trim();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6">
      {about ? <p className="text-md text-fg-2">{about}</p> : null}
      {objective && objective !== about ? (
        <details className="group rounded-xl bg-surface px-4 py-3">
          <summary className="cursor-pointer text-sm font-semibold text-fg-2">
            Guild description
          </summary>
          <div className="mt-2">
            <Markdown density="compact">{objective}</Markdown>
          </div>
        </details>
      ) : null}
      {pending.length ? (
        <section className="flex flex-col gap-2">
          <h2 className="type-label text-muted">Drafts to review</h2>
          <div className="flex flex-wrap gap-2">
            {pending.map((draft) => (
              <Button
                key={draft.id}
                variant="outline"
                size="sm"
                onClick={() =>
                  go({ section: "agents", agent: draft.target_agent_id, tab: "draft" })
                }
              >
                {draft.target_snapshot?.name ?? draft.target_agent_id} · draft {draft.draft_number}
              </Button>
            ))}
          </div>
        </section>
      ) : null}
      <section className="flex flex-col gap-2">
        <h2 className="type-label text-muted">Agents</h2>
        {agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            onClick={() => go({ section: "agents", agent: agent.id })}
            className="flex cursor-pointer items-start gap-3 rounded-lg bg-surface p-3 text-left hover:bg-paper-hi"
          >
            <Avatar name={agent.name} size={32} {...agentLook(agent)} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-mono text-sm font-medium">
                {agent.name} <span className="text-xs text-muted">v{agent.task_version ?? 0}</span>
              </span>
              <span className="line-clamp-2 text-xs text-fg-2">
                {agent.task_excerpt || "Empty Task."}
              </span>
              <span className="text-xs text-muted">
                {agent.routine_count} routine{agent.routine_count === 1 ? "" : "s"}
                {agent.latest_run ? ` · last run ${relativeTime(agent.latest_run.at)}` : ""}
                {agent.warnings.length
                  ? ` · ${agent.warnings.map((warning) => warningLabel[warning]).join(", ")}`
                  : ""}
              </span>
            </div>
          </button>
        ))}
      </section>
    </div>
  );
}
