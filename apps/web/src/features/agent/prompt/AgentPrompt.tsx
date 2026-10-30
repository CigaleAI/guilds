import { useBlocker, useParams } from "@tanstack/react-router";
import { History, RotateCcw } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../../../api/client";
import {
  useAgentTask,
  useEmbeddableNotes,
  useEmbedStatus,
  useSaveTask,
} from "../../../api/queries/notes";
import { useCollections } from "../../../api/queries/tables";
import type { TaskFile, TaskInput, TaskRevision } from "../../../api/types/notes";
import { messageTime } from "../../../app/format";
import { useIdentity } from "../../../app/identity";
import {
  Button,
  DiffView,
  diffLines,
  embedLabel,
  Markdown,
  TaskEditor,
  Segmented,
  Select,
  Banner,
  SkeletonRows,
  ConfirmDialog,
  toast,
  Icon,
} from "@guildsrun/ui";
import type { InsertKind } from "@guildsrun/ui";
import { InsertPicker } from "./InsertPicker";
import { EmbedPreview } from "./EmbedPreview";
import { embedIsBroken, pickableNotes, taskEdit, type TaskDraft } from "./taskContext";
import { LatestChange } from "../../notes/LatestChange";

const currentVersion = "current";

/** How a past version reads: its text, or its changes up to the live version. */
type PastView = "text" | "changes";

/** A save of the Task that failed and was reported; it rejects a dialog's confirm so it stays open. */
class TaskNotSaved extends Error {
  constructor() {
    super("The Task was not saved");
    this.name = "TaskNotSaved";
  }
}

/** A save of the Task's text, over the version it started from when it knows one. */
function taskInput(content: string, expected: number | undefined): TaskInput {
  return { content, ...(expected !== undefined ? { expected_version: expected } : {}) };
}

type TaskIntroProps = { versioned: boolean };

/** What the Task is, how its embeds and links reach a run, and that saving keeps the version it replaces. */
function TaskIntro({ versioned }: TaskIntroProps) {
  return (
    <p className="text-sm text-fg-2">
      The agent's standing purpose, sent in its system prompt on every run. Notes and tables
      embedded with <code className="font-mono text-xs">![[…]]</code> are added when a run starts; a
      note referenced with <code className="font-mono text-xs">[[…]]</code> is read by the agent
      when it needs it.
      {versioned ? " Saving keeps the previous version, so it can be restored." : null}
    </p>
  );
}

type BrokenEmbedsProps = { paths: readonly string[] };

/** The embeds the server found the agent cannot reach; nothing while it reaches them all. */
function BrokenEmbeds({ paths }: BrokenEmbedsProps) {
  if (!paths.length) return null;
  return (
    <Banner tone="warning" title="The Task embeds files this agent can't reach">
      {paths.map((path) => embedLabel(path)).join(", ")}. Each run gets a line saying the file is
      not reachable in its place. Fix or remove {paths.length === 1 ? "the link" : "the links"}, or
      give the agent access.
    </Banner>
  );
}

type TaskConflictProps = {
  /** The version saved while the operator was editing. */
  version: number | undefined;
  saved: string;
  value: string;
  onKeepMine: () => void;
  onUseTheirs: () => void;
};

/** A version saved during the edit: keep the operator's text over it or take it, after comparing the two. */
function TaskConflict({ version, saved, value, onKeepMine, onUseTheirs }: TaskConflictProps) {
  const [compared, setCompared] = useState(false);
  return (
    <>
      <Banner
        tone="warning"
        title={`v${version} was saved while you were editing`}
        action={
          <div className="flex flex-wrap gap-1.5">
            <Button variant="outline" size="sm" onClick={() => setCompared(!compared)}>
              {compared ? "Hide changes" : "Compare"}
            </Button>
            <Button variant="outline" size="sm" onClick={onKeepMine}>
              Keep mine
            </Button>
            <Button variant="ghost" size="sm" onClick={onUseTheirs}>
              Use theirs
            </Button>
          </div>
        }
      >
        Keep your text to save it over theirs, or use theirs and drop your edits.
      </Banner>
      {compared ? (
        <div className="max-h-80 shrink-0 overflow-y-auto">
          <DiffView lines={diffLines(saved, value)} title={`task · v${version} → your edits`} />
        </div>
      ) : null}
    </>
  );
}

type TaskVersionsProps = {
  task: TaskFile;
  guildId: string;
  /** The past version open; null for the live one. */
  viewing: number | null;
  past: TaskRevision | undefined;
  pastView: PastView;
  onView: (version: number | null) => void;
  onPastView: (view: PastView) => void;
  onRestore: (revision: TaskRevision) => void;
};

/** The version picker; beside it, how a past version reads and restoring it, or the live Task's latest change. */
function TaskVersions({
  task,
  guildId,
  viewing,
  past,
  pastView,
  onView,
  onPastView,
  onRestore,
}: TaskVersionsProps) {
  return (
    <div className="flex flex-wrap items-end gap-2.5">
      <Select
        tone="surface"
        className="w-72"
        label="Version"
        value={viewing === null ? currentVersion : String(viewing)}
        onValueChange={(next) => onView(next === currentVersion ? null : Number(next))}
        options={[
          { value: currentVersion, label: `v${task.version} · live` },
          ...(task.revisions ?? []).map((revision) => ({
            value: String(revision.version),
            label: `v${revision.version} · ${messageTime(revision.replaced_at)}`,
            ...(revision.replaced_by_name
              ? { description: `replaced by ${revision.replaced_by_name}` }
              : {}),
          })),
        ]}
      />
      {past ? (
        <>
          <Segmented
            label="Show"
            value={pastView}
            onValueChange={onPastView}
            options={[
              { value: "text", label: "Text" },
              { value: "changes", label: "Compare with live" },
            ]}
          />
          <span className="flex-1" />
          <Button variant="outline" onClick={() => onRestore(past)}>
            <Icon icon={RotateCcw} size={14} />
            Restore v{past.version}
          </Button>
        </>
      ) : task.display_path ? (
        <LatestChange
          className="min-w-0 flex-1"
          displayPath={task.display_path}
          guildId={guildId}
        />
      ) : null}
    </div>
  );
}

type PastVersionProps = {
  past: TaskRevision;
  view: PastView;
  saved: string;
  liveVersion: number | undefined;
  onOpenEmbed: (path: string) => void;
  isBrokenEmbed: (path: string) => boolean;
};

/** A past version, as its text or as its changes up to the live version. */
function PastVersion({
  past,
  view,
  saved,
  liveVersion,
  onOpenEmbed,
  isBrokenEmbed,
}: PastVersionProps) {
  if (view === "changes") {
    return (
      <div className="min-h-80 flex-1 overflow-y-auto">
        <DiffView
          lines={diffLines(past.content, saved)}
          title={`task · v${past.version} → v${liveVersion}`}
        />
      </div>
    );
  }
  return (
    <div className="min-h-80 flex-1 overflow-y-auto rounded-lg bg-paper px-4 py-3">
      {past.content.trim() ? (
        <Markdown onOpenEmbed={onOpenEmbed} isBrokenEmbed={isBrokenEmbed}>
          {past.content}
        </Markdown>
      ) : (
        <p className="text-sm text-muted">This version was empty.</p>
      )}
    </div>
  );
}

type NoEarlierVersionsProps = { task: TaskFile };

/** That earlier versions come with the next save, for a versioned Task that has none yet. */
function NoEarlierVersions({ task }: NoEarlierVersionsProps) {
  if (task.version === undefined || (task.revisions ?? []).length > 0) return null;
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted">
      <Icon icon={History} size={14} />
      Earlier versions appear here once the Task is saved again.
    </p>
  );
}

type RestoreVersionDialogProps = {
  revision: TaskRevision | null;
  liveVersion: number | undefined;
  onClose: () => void;
  onRestore: (revision: TaskRevision) => Promise<void>;
};

/** Restoring a past version as the live Task's next version; a failed save keeps it open. */
function RestoreVersionDialog({
  revision,
  liveVersion,
  onClose,
  onRestore,
}: RestoreVersionDialogProps) {
  return (
    <ConfirmDialog
      open={revision !== null}
      onOpenChange={(open) => !open && onClose()}
      title={revision ? `Restore v${revision.version}?` : ""}
      description={`Its text becomes the live Task as a new version, v${(liveVersion ?? 0) + 1}. v${liveVersion} stays in the version list.`}
      confirmLabel="Restore"
      onConfirm={() => (revision ? onRestore(revision) : undefined)}
    />
  );
}

/**
 * The agent's Task: the part of its system prompt an operator writes. Saving keeps the previous
 * version; any earlier version can be read, compared with the live one, and restored.
 */
export function AgentPrompt() {
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  const { org } = useIdentity();
  const task = useAgentTask(agentId);
  const save = useSaveTask(agentId, guildId);
  const notes = useEmbeddableNotes();
  const collections = useCollections();
  const embedStatus = useEmbedStatus(guildId);

  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [pastView, setPastView] = useState<PastView>("text");
  const [picking, setPicking] = useState<InsertKind | null>(null);
  const resolvePick = useRef<((markup: string | null) => void) | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<TaskRevision | null>(null);

  const { saved, value, dirty, conflict } = taskEdit(draft, task.data);

  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: () => dirty,
    withResolver: true,
  });

  const serverBroken = useMemo(
    () => embedStatus.data?.agents.find((agent) => agent.id === agentId)?.broken_embeds ?? [],
    [embedStatus.data, agentId],
  );
  const isBroken = (path: string) =>
    embedIsBroken(path, {
      serverBroken,
      notes: notes.data,
      collections: collections.data,
      orgId: org.id,
    });
  const noteGroups = useMemo(
    () => (notes.data ? pickableNotes(notes.data, { orgId: org.id, guildId, agentId }) : undefined),
    [notes.data, org.id, guildId, agentId],
  );

  const pickInsert = (kind: InsertKind) =>
    new Promise<string | null>((resolve) => {
      resolvePick.current = resolve;
      setPicking(kind);
    });

  /** Tells why the Task did not save: someone saved it meanwhile, or the error it failed with. */
  const reportSaveFailure = (error: unknown) => {
    if (error instanceof ApiError && error.status === 409) {
      void task.refetch();
      toast({
        kind: "warning",
        title: "Someone saved the Task while you were editing",
        description: "Your text is kept. Compare it with theirs before saving.",
      });
    } else {
      toast({
        kind: "error",
        title: "Couldn't save the Task",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /**
   * Saves the Task's text over the version it started from: the saved file, or `null` when the
   * save failed and the operator was told why.
   */
  const saveTask = async (
    content: string,
    expected: number | undefined,
  ): Promise<TaskFile | null> => {
    try {
      return await save.mutateAsync(taskInput(content, expected));
    } catch (error) {
      reportSaveFailure(error);
      return null;
    }
  };

  const onSave = () => {
    if (!task.data) return;
    void saveTask(value, draft?.base ?? task.data.version).then((next) => {
      if (!next) return;
      setDraft(null);
      toast({
        kind: "success",
        title: next.version ? `Task saved as v${next.version}` : "Task saved",
      });
    });
  };

  /** Restores a past version as the live Task; a failed save rejects, so the dialog stays open. */
  const restore = async (revision: TaskRevision, expected: number | undefined) => {
    const next = await saveTask(revision.content, expected);
    if (!next) throw new TaskNotSaved();
    setViewing(null);
    setRestoring(null);
    toast({ kind: "success", title: `Restored as v${next.version ?? ""}` });
  };

  if (task.isPending)
    return (
      <TabFrame>
        <SkeletonRows rows={8} label="Loading the Task" />
      </TabFrame>
    );
  if (task.isError) {
    return (
      <TabFrame>
        <Banner
          tone="error"
          title="Couldn't load the Task"
          meta={task.error.message}
          action={
            <Button variant="outline" size="sm" onClick={() => void task.refetch()}>
              Retry
            </Button>
          }
        />
      </TabFrame>
    );
  }

  const current = task.data;
  const past =
    viewing === null
      ? undefined
      : current.revisions?.find((revision) => revision.version === viewing);
  const versioned = current.version !== undefined;

  return (
    <TabFrame>
      <TaskIntro versioned={versioned} />
      <BrokenEmbeds paths={serverBroken} />

      {conflict ? (
        <TaskConflict
          version={current.version}
          saved={saved}
          value={value}
          onKeepMine={() => setDraft({ text: value, base: current.version })}
          onUseTheirs={() => setDraft(null)}
        />
      ) : null}

      {versioned ? (
        <TaskVersions
          task={current}
          guildId={guildId}
          viewing={viewing}
          past={past}
          pastView={pastView}
          onView={(next) => {
            setViewing(next);
            setPastView("text");
          }}
          onPastView={setPastView}
          onRestore={setRestoring}
        />
      ) : null}

      {past ? (
        <PastVersion
          past={past}
          view={pastView}
          saved={saved}
          liveVersion={current.version}
          onOpenEmbed={setPreviewPath}
          isBrokenEmbed={isBroken}
        />
      ) : (
        <TaskEditor
          className="min-h-80 flex-1"
          value={value}
          savedValue={saved}
          onChange={(text) =>
            setDraft((previous) => ({ text, base: previous?.base ?? current.version }))
          }
          onSave={onSave}
          onDiscard={() => setDraft(null)}
          {...(current.version !== undefined ? { revision: current.version } : {})}
          saving={save.isPending}
          onPickInsert={pickInsert}
          onOpenEmbed={setPreviewPath}
          isBrokenEmbed={isBroken}
          defaultMode="preview"
        />
      )}

      <NoEarlierVersions task={current} />

      <InsertPicker
        kind={picking}
        noteGroups={noteGroups}
        collections={collections.data}
        orgId={org.id}
        onPick={(markup) => {
          setPicking(null);
          resolvePick.current?.(markup);
          resolvePick.current = null;
        }}
      />
      <EmbedPreview
        path={previewPath}
        notes={notes.data}
        collections={collections.data}
        orgId={org.id}
        onClose={() => setPreviewPath(null)}
      />
      <RestoreVersionDialog
        revision={restoring}
        liveVersion={current.version}
        onClose={() => setRestoring(null)}
        onRestore={(revision) => restore(revision, current.version)}
      />
      <ConfirmDialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => !open && blocker.reset?.()}
        kind="destructive"
        title="Leave without saving?"
        description="Your changes to the Task are lost."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        onConfirm={() => blocker.proceed?.()}
      />
    </TabFrame>
  );
}
type TabFrameProps = { children: ReactNode };

/** The tab fills the inspector; the editor takes the height left, so its Save bar stays in view. */
function TabFrame({ children }: TabFrameProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-7 py-6">
      <div className="mx-auto flex min-h-0 w-full max-w-240 flex-1 flex-col gap-4">{children}</div>
    </div>
  );
}
