import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { useAgentTask } from "../../../api/queries/notes";
import type { StudioAgent } from "../../../api/types/studio";
import { relativeTime } from "../../../app/format";
import { Button, DiffView, diffLines, Banner, SkeletonRows, Icon, Row } from "@guildsrun/ui";
import { DetailHeader, Empty, MasterDetail } from "../MasterDetail";
import { useStudio } from "../StudioContext";

type TaskVersion = {
  version: number;
  content: string;
  /** When and by whom a later save replaced it; the live version has neither. */
  replaced?: { at: string; by: string | null };
};

type VersionsTabProps = { agent: StudioAgent };

/** The agent's Task versions, live first, each compared with the one it replaced. */
export function VersionsTab({ agent }: VersionsTabProps) {
  const { search, goInPlace } = useStudio();
  const task = useAgentTask(agent.id);

  if (task.isPending)
    return <SkeletonRows rows={4} label="Loading Task versions" className="p-5" />;
  if (task.isError) {
    return (
      <div className="p-5">
        <Banner tone="error" title="Couldn't load the Task" meta={task.error.message} />
      </div>
    );
  }

  const versions: TaskVersion[] = [
    { version: task.data.version ?? 0, content: task.data.content },
    ...(task.data.revisions ?? []).map((revision) => ({
      version: revision.version,
      content: revision.content,
      replaced: { at: revision.replaced_at, by: revision.replaced_by_name },
    })),
  ];
  const index = Math.max(
    0,
    versions.findIndex((entry) => String(entry.version) === search.item),
  );
  const selected = versions[index];
  const previous = versions[index + 1];

  return (
    <MasterDetail
      listLabel={`${agent.name}'s Task versions`}
      toolbar={
        <span className="type-meta text-muted">
          {versions.length} version{versions.length === 1 ? "" : "s"}
        </span>
      }
      list={versions.map((entry, position) => (
        <Row
          key={entry.version}
          asChild
          density="compact"
          interactive
          selected={position === index}
          mono
          title={`v${entry.version}${entry.replaced ? "" : " · live"}`}
          meta={
            entry.replaced
              ? `replaced ${relativeTime(entry.replaced.at)}${entry.replaced.by ? ` by ${entry.replaced.by}` : ""}`
              : "what new runs receive"
          }
        >
          <button
            type="button"
            aria-current={position === index ? "true" : undefined}
            onClick={() =>
              goInPlace({
                section: "agents",
                agent: agent.id,
                tab: "versions",
                item: String(entry.version),
              })
            }
          />
        </Row>
      ))}
      detail={
        selected ? (
          <VersionDetail agentId={agent.id} version={selected} previous={previous} />
        ) : (
          <Empty>No Task yet.</Empty>
        )
      }
    />
  );
}

type VersionDetailProps = {
  agentId: string;
  version: TaskVersion;
  /** The version it replaced; none for the first. */
  previous: TaskVersion | undefined;
};

/** One Task version: when a later save replaced it, and its text against the one it replaced. */
function VersionDetail({ agentId, version, previous }: VersionDetailProps) {
  const { session } = useStudio();
  return (
    <>
      <DetailHeader
        title={`Task v${version.version}${version.replaced ? "" : " · live"}`}
        meta={
          version.replaced
            ? `Replaced ${relativeTime(version.replaced.at)}${version.replaced.by ? ` by ${version.replaced.by}` : ""}`
            : "The Task as new runs receive it."
        }
        actions={
          version.replaced ? (
            <Button asChild variant="outline" size="sm">
              <Link
                to="/guilds/$guildId/agents/$agentId/prompt"
                params={{ guildId: session.source_guild_id, agentId }}
              >
                <Icon icon={ExternalLink} size={14} />
                Restore from Prompt
              </Link>
            </Button>
          ) : null
        }
      />
      {previous ? (
        <DiffView
          lines={diffLines(previous.content, version.content)}
          title={`task · v${previous.version} → v${version.version}`}
        />
      ) : (
        <pre className="rounded-lg bg-surface px-4 py-3 font-mono text-xs whitespace-pre-wrap">
          {version.content || "(Empty Task)"}
        </pre>
      )}
    </>
  );
}
