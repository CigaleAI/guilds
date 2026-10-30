import { useBlocker, useParams } from "@tanstack/react-router";
import { Brain } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  agentNotesPrefix,
  useAgentMemory,
  useNote,
  useSaveMemory,
} from "../../../api/queries/notes";
import type { MemoryVersion } from "../../../api/types";
import { relativeTime } from "../../../app/format";
import {
  Button,
  TaskEditor,
  Banner,
  EmptyState,
  SkeletonRows,
  ConfirmDialog,
  toast,
} from "@guildsrun/ui";
import { LatestChange, useOpenRunStep } from "../../notes/LatestChange";
import { DetailHeader, MasterDetail } from "../../studio/MasterDetail";
import {
  MemoryStepButton,
  MemoryVersionRow,
  MemoryVersionView,
  memoryAuthorLabel,
  memoryVersionId,
  memoryVersionName,
} from "./memoryVersions";

const liveId = "live";

const memoryHint =
  "What the agent writes to remember between runs. The Prompt tab holds the operator's purpose.";

/** A version's caption: who wrote it, and when. */
function versionMeta(entry: MemoryVersion): string {
  const author = memoryAuthorLabel(entry);
  return entry.written_at ? `${author} · ${relativeTime(entry.written_at)}` : author;
}

/**
 * The agent's memory: the live version to edit, and every earlier one, newest first, with what it
 * changed and the run step that wrote it. Saving archives the text it replaces.
 */
export function AgentMemory() {
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  const timeline = useAgentMemory(agentId);
  const openRunStep = useOpenRunStep();
  const [selectedId, setSelectedId] = useState(liveId);
  const [draft, setDraft] = useState<string | null>(null);
  const unsaved = draft !== null;

  const blocker = useBlocker({
    shouldBlockFn: () => unsaved,
    enableBeforeUnload: () => unsaved,
    withResolver: true,
  });

  let content: ReactNode;
  if (!timeline.data) {
    content = timeline.isError ? (
      <div className="p-5">
        <Banner
          tone="error"
          title="Couldn't load the memory"
          meta={timeline.error.message}
          action={
            <Button variant="outline" size="sm" onClick={() => void timeline.refetch()}>
              Retry
            </Button>
          }
        />
      </div>
    ) : (
      <SkeletonRows rows={6} label="Loading memory" className="p-5" />
    );
  } else if (!timeline.data.entries.length) {
    content = (
      <div className="grid flex-1 place-items-center p-6">
        <EmptyState
          icon={Brain}
          title="No memory yet"
          description="The agent writes whatever it wants to remember for future runs."
        />
      </div>
    );
  } else {
    const { entries, display_path } = timeline.data;
    const live = entries.find((entry) => entry.revision_id === null);
    const archived =
      selectedId === liveId ? undefined : entries.find((entry) => entry.revision_id === selectedId);
    content = (
      <MasterDetail
        listLabel="Memory versions"
        toolbar={
          <span className="type-meta text-muted">
            {entries.length} version{entries.length === 1 ? "" : "s"}
          </span>
        }
        list={entries.map((entry) => (
          <MemoryVersionRow
            key={memoryVersionId(entry)}
            entry={entry}
            selected={archived ? entry === archived : entry.revision_id === null}
            meta={versionMeta(entry)}
            onSelect={() => setSelectedId(memoryVersionId(entry))}
          />
        ))}
        detail={
          archived ? (
            <MemoryVersionView
              key={memoryVersionId(archived)}
              entry={archived}
              actions={
                <MemoryStepButton
                  entry={archived}
                  onOpen={({ runId, call }) => openRunStep({ guildId, agentId, runId, call })}
                />
              }
            />
          ) : (
            <LiveMemory
              agentId={agentId}
              guildId={guildId}
              displayPath={display_path}
              entry={live}
              draft={draft}
              onDraft={setDraft}
            />
          )
        }
      />
    );
  }

  return (
    <>
      {content}
      <ConfirmDialog
        kind="destructive"
        open={blocker.status === "blocked"}
        onOpenChange={(openDialog) => !openDialog && blocker.reset?.()}
        title="Leave without saving?"
        description="Unsaved changes to the memory are lost."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        onConfirm={() => blocker.proceed?.()}
      />
    </>
  );
}

type LiveMemoryProps = {
  agentId: string;
  guildId: string;
  /** The memory's display path, for who changed it last. */
  displayPath: string;
  /** The live version in the timeline. */
  entry: MemoryVersion | undefined;
  draft: string | null;
  onDraft: (text: string | null) => void;
};

/** The live memory in an editor, with who changed it last and the run step that did it. */
function LiveMemory({ agentId, guildId, displayPath, entry, draft, onDraft }: LiveMemoryProps) {
  const file = useNote(agentNotesPrefix(agentId), "memory.md");
  const save = useSaveMemory(agentId);
  const saved = file.data?.content ?? "";
  const value = draft ?? saved;

  return (
    <>
      <DetailHeader title={entry ? `Memory ${memoryVersionName(entry)}` : "Memory"} />
      <p className="text-sm text-fg-2">{memoryHint}</p>
      <LatestChange displayPath={displayPath} guildId={guildId} />
      {file.isPending ? (
        <SkeletonRows rows={6} label="Loading the memory" />
      ) : file.isError ? (
        <Banner tone="error" title="Couldn't read the memory" meta={file.error.message} />
      ) : (
        <TaskEditor
          className="min-h-80 flex-1"
          label="Memory"
          emptyText="The memory is empty."
          placeholder="Write in markdown…"
          defaultMode="preview"
          sourceKey={displayPath}
          value={value}
          savedValue={saved}
          onChange={(text) => onDraft(text === saved ? null : text)}
          onDiscard={() => onDraft(null)}
          onSave={() =>
            save.mutate(value, {
              onSuccess: () => {
                onDraft(null);
                toast({ kind: "success", title: "Memory saved" });
              },
              onError: (error) =>
                toast({
                  kind: "error",
                  title: "Couldn't save the memory",
                  description: error.message,
                }),
            })
          }
          {...(file.data?.version !== undefined ? { revision: file.data.version } : {})}
          saving={save.isPending}
        />
      )}
    </>
  );
}
