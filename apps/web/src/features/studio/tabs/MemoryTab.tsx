import { Pin } from "lucide-react";
import { useState } from "react";
import { useMemoryTimeline } from "../../../api/queries/studio";
import type { MemoryVersion } from "../../../api/types/notes";
import type { StudioAgent } from "../../../api/types/studio";
import { Button, Select, Banner, SkeletonRows, Icon } from "@guildsrun/ui";
import {
  MemoryStepButton,
  MemoryVersionRow,
  MemoryVersionView,
  memoryAuthorLabel,
  memoryChangeLabel,
  memoryVersionId,
  memoryVersionName,
} from "../../agent/memory/memoryVersions";
import { Empty, MasterDetail } from "../../../app/MasterDetail";
import { useStudio } from "../StudioContext";

const any = "all";

type MemoryTabProps = { agent: StudioAgent };

/**
 * Every version of the agent's memory, newest first, filtered by author: who wrote each,
 * what it changed against the one before, and the run step that wrote it.
 */
export function MemoryTab({ agent }: MemoryTabProps) {
  const { session, search, goInPlace } = useStudio();
  const timeline = useMemoryTimeline(session.id, agent.id);
  const [author, setAuthor] = useState<string>(any);

  if (timeline.isPending) return <SkeletonRows rows={6} label="Loading memory" className="p-5" />;
  if (timeline.isError) {
    return (
      <div className="p-5">
        <Banner tone="error" title="Couldn't load the memory" meta={timeline.error.message} />
      </div>
    );
  }

  const entries = timeline.data.entries;
  const listed = entries.filter((entry) => author === any || entry.actor.type === author);
  const selected = entries.find((entry) => memoryVersionId(entry) === search.item) ?? entries[0];

  return (
    <MasterDetail
      listLabel={`${agent.name}'s memory versions`}
      toolbar={
        <>
          <Select
            tone="surface"
            aria-label="Author"
            className="w-32"
            value={author}
            onValueChange={setAuthor}
            options={[
              { value: any, label: "Any author" },
              { value: "run", label: "Runs" },
              { value: "user", label: "People" },
            ]}
          />
          <span className="ml-auto type-meta text-muted">
            {entries.length} version{entries.length === 1 ? "" : "s"}
          </span>
        </>
      }
      list={
        listed.length ? (
          listed.map((entry) => (
            <MemoryVersionRow
              key={memoryVersionId(entry)}
              entry={entry}
              selected={
                selected !== undefined && memoryVersionId(entry) === memoryVersionId(selected)
              }
              meta={`${memoryAuthorLabel(entry)} · ${memoryChangeLabel(entry)}`}
              onSelect={() =>
                goInPlace({
                  section: "agents",
                  agent: agent.id,
                  tab: "memory",
                  item: memoryVersionId(entry),
                })
              }
            />
          ))
        ) : (
          <Empty>{entries.length ? "No versions match." : "No memory yet."}</Empty>
        )
      }
      detail={
        selected ? (
          <MemoryDetail key={memoryVersionId(selected)} agent={agent} entry={selected} />
        ) : (
          <Empty>This agent has no memory yet.</Empty>
        )
      }
    />
  );
}

type MemoryDetailProps = { agent: StudioAgent; entry: MemoryVersion };

/** One version with Studio's actions: open the step that wrote it, or ask the coach about it. */
function MemoryDetail({ agent, entry }: MemoryDetailProps) {
  const { ask, openStep } = useStudio();
  return (
    <MemoryVersionView
      entry={entry}
      actions={
        <>
          <MemoryStepButton
            entry={entry}
            onOpen={({ runId, call }) => openStep({ agentId: agent.id, runId, call })}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              ask({
                kind: "memory_version",
                agent_id: agent.id,
                revision_id: entry.revision_id,
                version_index: entry.index,
                label: `${agent.name} · memory ${memoryVersionName(entry)}`,
              })
            }
          >
            <Icon icon={Pin} size={14} />
            Ask the coach
          </Button>
        </>
      }
    />
  );
}
