import { useBlocker, useParams } from "@tanstack/react-router";
import { History, RotateCcw } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../../../api/client";
import {
  useAgentTask,
  useCollections,
  useEmbeddableNotes,
  useEmbedStatus,
  useSaveTask,
} from "../../../api/queries";
import type { TaskFile, TaskRevision } from "../../../api/types";
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
import { embedIsBroken, pickableNotes } from "./taskContext";
import { LatestChange } from "../../files/LatestChange";

/** What the operator is writing, and the version it started from. */
type Draft = { text: string; base: number | undefined };

const currentVersion = "current";

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

  const [draft, setDraft] = useState<Draft | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [pastView, setPastView] = useState<"text" | "changes">("text");
  const [showConflict, setShowConflict] = useState(false);
  const [picking, setPicking] = useState<InsertKind | null>(null);
  const resolvePick = useRef<((markup: string | null) => void) | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<TaskRevision | null>(null);

  const saved = task.data?.content ?? "";
  const value = draft?.text ?? saved;
  const dirty = value !== saved;
  const conflict =
    dirty &&
    draft?.base !== undefined &&
    task.data?.version !== undefined &&
    draft.base !== task.data.version;

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

  const write = (content: string, expected: number | undefined, done: (saved: TaskFile) => void) =>
    save
      .mutateAsync({ content, ...(expected !== undefined ? { expected_version: expected } : {}) })
      .then(done, (error: Error) => {
        if (error instanceof ApiError && error.status === 409) {
          void task.refetch();
          toast({
            kind: "warning",
            title: "Someone saved the Task while you were editing",
            description: "Your text is kept. Compare it with theirs before saving.",
          });
        } else {
          toast({ kind: "error", title: "Couldn't save the Task", description: error.message });
        }
        throw error;
      });

  const onSave = () => {
    if (!task.data) return;
    write(value, draft?.base ?? task.data.version, (next) => {
      setDraft(null);
      setShowConflict(false);
      toast({
        kind: "success",
        title: next.version ? `Task saved as v${next.version}` : "Task saved",
      });
    }).catch(() => undefined);
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
  const revisions = current.revisions ?? [];
  const past =
    viewing === null ? undefined : revisions.find((revision) => revision.version === viewing);
  const versioned = current.version !== undefined;

  return (
    <TabFrame>
      <p className="text-sm text-fg-2">
        The agent's standing purpose, sent in its system prompt on every run. Notes and tables
        embedded with <code className="font-mono text-xs">![[…]]</code> are added when a run starts;
        a note referenced with <code className="font-mono text-xs">[[…]]</code> is read by the agent
        when it needs it.
        {versioned ? " Saving keeps the previous version, so it can be restored." : null}
      </p>

      {serverBroken.length ? (
        <Banner tone="warning" title="The Task embeds files this agent can't reach">
          {serverBroken.map((path) => embedLabel(path)).join(", ")}. Each run gets a line saying the
          file is not reachable in its place. Fix or remove{" "}
          {serverBroken.length === 1 ? "the link" : "the links"}, or give the agent access.
        </Banner>
      ) : null}

      {conflict ? (
        <Banner
          tone="warning"
          title={`v${current.version} was saved while you were editing`}
          action={
            <div className="flex flex-wrap gap-1.5">
              <Button variant="outline" size="sm" onClick={() => setShowConflict(!showConflict)}>
                {showConflict ? "Hide changes" : "Compare"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDraft({ text: value, base: current.version })}
              >
                Keep mine
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
                Use theirs
              </Button>
            </div>
          }
        >
          Keep your text to save it over theirs, or use theirs and drop your edits.
        </Banner>
      ) : null}
      {conflict && showConflict ? (
        <div className="max-h-80 shrink-0 overflow-y-auto">
          <DiffView
            lines={diffLines(saved, value)}
            title={`task · v${current.version} → your edits`}
          />
        </div>
      ) : null}

      {versioned ? (
        <div className="flex flex-wrap items-end gap-2.5">
          <Select
            tone="surface"
            className="w-72"
            label="Version"
            value={viewing === null ? currentVersion : String(viewing)}
            onValueChange={(next) => {
              setViewing(next === currentVersion ? null : Number(next));
              setPastView("text");
            }}
            options={[
              { value: currentVersion, label: `v${current.version} · live` },
              ...revisions.map((revision) => ({
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
                onValueChange={setPastView}
                options={[
                  { value: "text", label: "Text" },
                  { value: "changes", label: "Compare with live" },
                ]}
              />
              <span className="flex-1" />
              <Button variant="outline" onClick={() => setRestoring(past)}>
                <Icon icon={RotateCcw} size={14} />
                Restore v{past.version}
              </Button>
            </>
          ) : task.data?.display_path ? (
            <LatestChange
              className="min-w-0 flex-1"
              displayPath={task.data.display_path}
              guildId={guildId}
            />
          ) : null}
        </div>
      ) : null}

      {past ? (
        pastView === "text" ? (
          <div className="min-h-80 flex-1 overflow-y-auto rounded-lg bg-paper px-4 py-3">
            {past.content.trim() ? (
              <Markdown onOpenEmbed={setPreviewPath} isBrokenEmbed={isBroken}>
                {past.content}
              </Markdown>
            ) : (
              <p className="text-sm text-muted">This version was empty.</p>
            )}
          </div>
        ) : (
          <div className="min-h-80 flex-1 overflow-y-auto">
            <DiffView
              lines={diffLines(past.content, saved)}
              title={`task · v${past.version} → v${current.version}`}
            />
          </div>
        )
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

      {versioned && revisions.length === 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <Icon icon={History} size={14} />
          Earlier versions appear here once the Task is saved again.
        </p>
      ) : null}

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
      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(open) => !open && setRestoring(null)}
        title={restoring ? `Restore v${restoring.version}?` : ""}
        description={`Its text becomes the live Task as a new version, v${(current.version ?? 0) + 1}. v${current.version} stays in the version list.`}
        confirmLabel="Restore"
        onConfirm={() =>
          restoring
            ? write(restoring.content, current.version, (next) => {
                setViewing(null);
                setRestoring(null);
                toast({ kind: "success", title: `Restored as v${next.version ?? ""}` });
              })
            : undefined
        }
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

/** The tab fills the inspector; the editor takes the height left, so its Save bar stays in view. */
function TabFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-7 py-6">
      <div className="mx-auto flex min-h-0 w-full max-w-240 flex-1 flex-col gap-4">{children}</div>
    </div>
  );
}
