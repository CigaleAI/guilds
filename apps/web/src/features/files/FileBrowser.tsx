import { useBlocker } from "@tanstack/react-router";
import { ArrowLeft, Copy, FilePlus, FileText, Pin, Trash2 } from "lucide-react";
import { useMemo, useRef, useState, type FormEvent } from "react";
import {
  useCollections,
  useDeleteFile,
  useEmbeddableNotes,
  useFile,
  useFileList,
  useSaveFile,
  type FilesPrefix,
} from "../../api/queries";
import type { FileItem } from "../../api/types";

import { useIdentity } from "../../app/identity";
import { useMediaQuery, wideScreen } from "../../app/media";
import {
  cn,
  Button,
  Icon,
  IconButton,
  TaskEditor,
  SearchField,
  Segmented,
  TextField,
  FileTree,
  Banner,
  EmptyState,
  SkeletonRows,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  toast,
} from "@guildsrun/ui";
import type { EmbedKind } from "@guildsrun/ui";
import { EmbedPicker } from "../agent/prompt/EmbedPicker";
import { EmbedPreview } from "../agent/prompt/EmbedPreview";
import { embedIsBroken, pickableNotes } from "../agent/prompt/taskContext";
import { buildTree, newNotePath } from "./fileTree";
import { LatestChange, type OpenChangeStep } from "./LatestChange";

export type FileScope = { id: "agent" | "guild" | "org"; title: string; prefix: FilesPrefix };

type FileBrowserProps = {
  /** The scopes to browse, the first open at start: an agent's, its guild's, the organisation's. */
  scopes: FileScope[];
  guildId: string;
  /** The agent whose notes these are, when browsing from its inspector. */
  agentId?: string;
  /** Opens the run step that changed a file; by default the run opens in its agent's chat. */
  onOpenStep?: OpenChangeStep;
  /** A file to open first, by display path; its scope opens with it. */
  initialPath?: string | undefined;
  /** Pins the open file to a question for Studio's coach. */
  onAsk?: ((item: FileItem) => void) | undefined;
};

/** The scope a display path belongs to: an agent's files, a guild's, or the organisation's. */
function scopeOfPath(path: string): FileScope["id"] {
  if (/(^|\/)agents\//.test(path)) return "agent";
  if (/(^|\/)guilds\//.test(path)) return "guild";
  return "org";
}

const noFiles: FileItem[] = [];

/**
 * Notes by scope: each scope's notes side by side, and the open note in an editor. Notes are
 * last-writer-wins; embeds work as in the Task.
 */
export function FileBrowser({
  scopes,
  guildId,
  agentId,
  onOpenStep,
  initialPath,
  onAsk,
}: FileBrowserProps) {
  const wide = useMediaQuery(wideScreen);
  const [listOpen, setListOpen] = useState(!initialPath);
  const initialScope =
    initialPath && scopes.some((item) => item.id === scopeOfPath(initialPath))
      ? scopeOfPath(initialPath)
      : undefined;
  const [scopeId, setScopeId] = useState(initialScope ?? scopes[0]?.id ?? "guild");
  const scope = scopes.find((item) => item.id === scopeId) ?? scopes[0];
  const prefixOf = (id: FileScope["id"]) => scopes.find((item) => item.id === id)?.prefix ?? null;
  const lists = {
    agent: useFileList(prefixOf("agent")),
    guild: useFileList(prefixOf("guild")),
    org: useFileList(prefixOf("org")),
  };
  const list = scope ? lists[scope.id] : undefined;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Partial<Record<FileScope["id"], string>>>(() =>
    initialScope && initialPath ? { [initialScope]: initialPath } : {},
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);

  const items = list?.data ?? noFiles;
  const tree = buildTree(items, query);

  const chosen = scope ? selected[scope.id] : undefined;
  const openPath = items.some((item) => item.display_path === chosen)
    ? chosen
    : items[0]?.display_path;
  const open = items.find((item) => item.display_path === openPath);
  const unsaved = Object.keys(drafts).length > 0;

  const blocker = useBlocker({
    shouldBlockFn: () => unsaved,
    enableBeforeUnload: () => unsaved,
    withResolver: true,
  });

  if (!scope || !list) return null;

  const showingList = wide || listOpen || !open;
  const showingNote = Boolean(open) && (wide || !listOpen);
  const pickFile = (path: string) => {
    setSelected({ ...selected, [scope.id]: path });
    setListOpen(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside
        className={cn(
          "min-h-0 flex-col gap-3 border-b border-line p-4 md:flex md:w-72 md:flex-none md:border-r md:border-b-0",
          showingList ? "flex flex-1" : "hidden",
        )}
      >
        {scopes.length > 1 ? (
          <Segmented
            size="sm"
            label="Notes scope"
            value={scope.id}
            onValueChange={setScopeId}
            options={scopes.map((item) => ({
              value: item.id,
              label: item.title,
              count: lists[item.id].data?.length ?? 0,
            }))}
          />
        ) : null}
        <div className="flex items-center gap-2">
          <SearchField
            className="min-w-0 flex-1"
            tone="surface"
            label="Search notes"
            placeholder="Search notes…"
            value={query}
            onValueChange={setQuery}
          />
          <IconButton
            icon={FilePlus}
            label="New note"
            variant="surface"
            onClick={() => setCreating(true)}
          />
        </div>
        <div className="-mx-2 min-h-0 flex-1 overflow-y-auto">
          {list.isPending ? (
            <SkeletonRows rows={5} label="Loading notes" />
          ) : list.isError ? (
            <Banner tone="error" title="Couldn't load the notes" meta={list.error.message} />
          ) : tree.length ? (
            <FileTree
              key={scope.id}
              label={`${scope.title} notes`}
              nodes={tree}
              selectedId={openPath ?? null}
              onSelect={(node) => node.kind === "file" && pickFile(node.id)}
            />
          ) : items.length ? (
            <p className="px-2 text-sm text-muted">No notes match.</p>
          ) : !wide ? (
            <div className="grid flex-1 place-items-center p-2">
              <EmptyState
                icon={FileText}
                title="No notes yet"
                description={`Notes in ${scope.title.toLowerCase()} scope appear here. Agents write them with their note tools.`}
                action={
                  <Button size="sm" onClick={() => setCreating(true)}>
                    New note
                  </Button>
                }
              />
            </div>
          ) : null}
        </div>
      </aside>

      <section
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col",
          showingNote || (wide && !open) ? "flex" : "hidden",
        )}
      >
        {open ? (
          <NoteView
            key={`${scope.id}:${open.display_path}`}
            scope={scope}
            item={open}
            guildId={guildId}
            {...(agentId ? { agentId } : {})}
            {...(onOpenStep ? { onOpenStep } : {})}
            {...(onAsk ? { onAsk } : {})}
            {...(!wide ? { onBack: () => setListOpen(true) } : {})}
            draft={drafts[open.display_path]}
            onDraft={(text) =>
              setDrafts((current) => {
                const next = { ...current };
                if (text === null) delete next[open.display_path];
                else next[open.display_path] = text;
                return next;
              })
            }
            onDeleted={() => {
              setSelected({ ...selected, [scope.id]: undefined });
              setListOpen(true);
            }}
          />
        ) : list.isPending ? null : (
          <div className="grid flex-1 place-items-center p-6">
            <EmptyState
              icon={FileText}
              title="No notes yet"
              description={`Notes in ${scope.title.toLowerCase()} scope appear here. Agents write them with their note tools.`}
              action={
                <Button size="sm" onClick={() => setCreating(true)}>
                  New note
                </Button>
              }
            />
          </div>
        )}
      </section>

      <NewNoteDialog
        open={creating}
        onOpenChange={setCreating}
        scope={scope}
        existing={items}
        onCreated={(file) => {
          setSelected({ ...selected, [scope.id]: file.display_path });
          setListOpen(false);
        }}
      />
      <ConfirmDialog
        kind="destructive"
        open={blocker.status === "blocked"}
        onOpenChange={(openDialog) => !openDialog && blocker.reset?.()}
        title="Leave without saving?"
        description="Unsaved changes to notes are lost."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        onConfirm={() => blocker.proceed?.()}
      />
    </div>
  );
}

type NoteViewProps = {
  scope: FileScope;
  item: FileItem;
  guildId: string;
  agentId?: string;
  onOpenStep?: OpenChangeStep;
  onAsk?: (item: FileItem) => void;
  onBack?: () => void;
  draft: string | undefined;
  onDraft: (text: string | null) => void;
  onDeleted: () => void;
};

/** One note: its path and provenance, and its text to edit. */
function NoteView({
  scope,
  item,
  guildId,
  agentId,
  onOpenStep,
  onAsk,
  onBack,
  draft,
  onDraft,
  onDeleted,
}: NoteViewProps) {
  const { org } = useIdentity();
  const file = useFile(scope.prefix, item.path);
  const save = useSaveFile(scope.prefix);
  const remove = useDeleteFile(scope.prefix);
  const notes = useEmbeddableNotes();
  const collections = useCollections();
  const [picking, setPicking] = useState<EmbedKind | null>(null);
  const resolvePick = useRef<((path: string | null) => void) | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const noteGroups = useMemo(
    () =>
      notes.data
        ? pickableNotes(
            notes.data.filter((note) => note.display_path !== item.display_path),
            { orgId: org.id, guildId, agentId: agentId ?? "" },
          )
        : undefined,
    [notes.data, item.display_path, org.id, guildId, agentId],
  );
  const isBroken = (path: string) =>
    embedIsBroken(path, {
      serverBroken: [],
      notes: notes.data,
      collections: collections.data,
      orgId: org.id,
    });

  const saved = file.data?.content ?? "";
  const value = draft ?? saved;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast({ kind: "success", title: "Copied" });
    } catch {
      toast({ kind: "error", title: "Couldn't copy the note" });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-4 md:gap-3 md:p-5">
      <div className="flex flex-wrap items-center gap-2">
        {onBack ? (
          <IconButton
            icon={ArrowLeft}
            label="Back to notes"
            variant="ghost"
            size={28}
            onClick={onBack}
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate font-mono text-sm">
          <span className="text-muted">~/{scope.id}/</span>
          {item.path}
        </span>
        {onAsk ? (
          <Button variant="outline" size="xs" onClick={() => onAsk(item)}>
            <Icon icon={Pin} size={14} />
            Ask the coach
          </Button>
        ) : null}
        <IconButton
          icon={Copy}
          label="Copy the text"
          variant="ghost"
          size={28}
          onClick={() => void copy()}
        />
        <IconButton
          icon={Trash2}
          label={`Delete ${item.path}`}
          variant="ghost"
          size={28}
          onClick={() => setDeleting(true)}
        />
      </div>
      <LatestChange
        displayPath={item.display_path}
        guildId={guildId}
        {...(onOpenStep ? { onOpenStep } : {})}
      />

      {file.isPending ? (
        <SkeletonRows rows={6} label="Loading the note" />
      ) : file.isError ? (
        <Banner tone="error" title="Couldn't read the note" meta={file.error.message} />
      ) : (
        <TaskEditor
          className="min-h-0 flex-1"
          label="Note"
          emptyText="This note is empty."
          placeholder="Write in markdown…"
          defaultMode="preview"
          value={value}
          savedValue={saved}
          onChange={(text) => onDraft(text === saved ? null : text)}
          onDiscard={() => onDraft(null)}
          onSave={() =>
            save.mutate(
              { path: item.path, content: value },
              {
                onSuccess: () => {
                  onDraft(null);
                  toast({ kind: "success", title: `${item.path} saved` });
                },
                onError: (error) =>
                  toast({
                    kind: "error",
                    title: "Couldn't save the note",
                    description: error.message,
                  }),
              },
            )
          }
          {...(file.data?.version !== undefined ? { revision: file.data.version } : {})}
          saving={save.isPending}
          onPickEmbed={(kind) =>
            new Promise<string | null>((resolve) => {
              resolvePick.current = resolve;
              setPicking(kind);
            })
          }
          onOpenEmbed={setPreviewPath}
          isBrokenEmbed={isBroken}
        />
      )}

      <EmbedPicker
        kind={picking}
        noteGroups={noteGroups}
        collections={collections.data}
        orgId={org.id}
        onPick={(path) => {
          setPicking(null);
          resolvePick.current?.(path);
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
        kind="destructive"
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${item.path}?`}
        description={
          draft !== undefined
            ? "The note and its unsaved changes are removed. A Task that embeds it keeps it from being deleted."
            : "The note is removed. A Task that embeds it keeps it from being deleted."
        }
        confirmLabel="Delete note"
        onConfirm={() =>
          remove.mutateAsync(item.path).then(
            () => {
              onDraft(null);
              onDeleted();
              toast({ kind: "success", title: `${item.path} deleted` });
            },
            (error: Error) => {
              toast({
                kind: "error",
                title: "Couldn't delete the note",
                description: error.message,
              });
              throw error;
            },
          )
        }
      />
    </div>
  );
}

function NewNoteDialog({
  open,
  onOpenChange,
  scope,
  existing,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: FileScope;
  existing: readonly FileItem[];
  onCreated: (file: { display_path: string }) => void;
}) {
  const save = useSaveFile(scope.prefix);
  const [name, setName] = useState("untitled");
  const [touched, setTouched] = useState(false);
  const result = newNotePath(name, existing);

  const close = () => {
    setName("untitled");
    setTouched(false);
    save.reset();
    onOpenChange(false);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if ("error" in result) return;
    save.mutate(
      { path: result.path, content: "" },
      {
        onSuccess: (file) => {
          onCreated(file);
          close();
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent size="sm">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader title="New note" description={`In ${scope.title.toLowerCase()} scope.`} />
          <DialogBody>
            <TextField
              tone="surface"
              label="Name"
              mono
              autoFocus
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              onFocus={(event) => event.currentTarget.select()}
              hint={"path" in result ? `Saved as ${result.path}` : undefined}
              {...(touched && "error" in result ? { error: result.error } : {})}
            />
            {save.isError ? (
              <Banner tone="error" title="Couldn't create the note">
                {save.error.message}
              </Banner>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
