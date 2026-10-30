import { useBlocker } from "@tanstack/react-router";
import { ArrowLeft, Copy, FilePlus, FileText, Pin, ShieldCheck, Trash2 } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useCollections } from "../../api/queries/tables";
import {
  useDeleteNote,
  useEmbeddableNotes,
  useNote,
  useNoteList,
  useSaveNote,
  type NotesPrefix,
} from "../../api/queries/notes";
import type { FileContent, NoteItem } from "../../api/types/notes";
import { copyText } from "../../app/clipboard";
import { openingScope } from "../../app/displayPath";
import { useIdentity } from "../../app/identity";
import { useMediaQuery, visiblePanes, wideScreen } from "../../app/media";
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
import type { FileTreeNode, InsertKind } from "@guildsrun/ui";
import { AccessListPanel } from "../access/AccessListPanel";
import { InsertPicker } from "../agent/prompt/InsertPicker";
import { EmbedPreview } from "../agent/prompt/EmbedPreview";
import { embedIsBroken, pickableNotes } from "../agent/prompt/taskContext";
import { buildTree, newNotePath } from "./noteTree";
import { LatestChange, type OpenChangeStep } from "./LatestChange";

export type NoteScope = { id: "agent" | "guild" | "org"; title: string; prefix: NotesPrefix };

type NotesBrowserProps = {
  /** The scopes to browse, the first open at start: an agent's, its guild's, the organisation's. */
  scopes: NoteScope[];
  guildId: string;
  /** The agent whose notes these are, when browsing from its inspector. */
  agentId?: string;
  /** Opens the run step that changed a file; by default the run opens in its agent's chat. */
  onOpenStep?: OpenChangeStep;
  /** A file to open first, by display path; its scope opens with it. */
  initialPath?: string | undefined;
  /** Pins the open file to a question for Studio's coach. */
  onAsk?: ((item: NoteItem) => void) | undefined;
};

const noNotes: NoteItem[] = [];

/**
 * Notes by scope: each scope's notes side by side, and the open note in an editor. Notes are
 * last-writer-wins; embeds work as in the Task.
 */
export function NotesBrowser({
  scopes,
  guildId,
  agentId,
  onOpenStep,
  initialPath,
  onAsk,
}: NotesBrowserProps) {
  const initialScope = openingScope(scopes, initialPath)?.id;
  const [scopeId, setScopeId] = useState(initialScope ?? scopes[0]?.id ?? "guild");
  const scope = scopes.find((item) => item.id === scopeId) ?? scopes[0];
  const prefixOf = (id: NoteScope["id"]) => scopes.find((item) => item.id === id)?.prefix ?? null;
  const lists = {
    agent: useNoteList(prefixOf("agent")),
    guild: useNoteList(prefixOf("guild")),
    org: useNoteList(prefixOf("org")),
  };
  const [selected, setSelected] = useState<Partial<Record<NoteScope["id"], string>>>(() =>
    initialScope && initialPath ? { [initialScope]: initialPath } : {},
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const unsaved = Object.keys(drafts).length > 0;

  const blocker = useBlocker({
    shouldBlockFn: () => unsaved,
    enableBeforeUnload: () => unsaved,
    withResolver: true,
  });

  if (!scope) return null;

  return (
    <>
      <ScopeNotes
        scope={scope}
        list={lists[scope.id]}
        tabs={
          scopes.length > 1 ? (
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
          ) : null
        }
        guildId={guildId}
        agentId={agentId}
        onOpenStep={onOpenStep}
        onAsk={onAsk}
        chosenPath={selected[scope.id]}
        onChoose={(path) => setSelected({ ...selected, [scope.id]: path })}
        drafts={drafts}
        onDraft={(path, text) =>
          setDrafts((current) => {
            const next = { ...current };
            if (text === null) delete next[path];
            else next[path] = text;
            return next;
          })
        }
        startsOnNote={Boolean(initialPath)}
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
    </>
  );
}

type ScopeNotesProps = {
  scope: NoteScope;
  list: UseQueryResult<NoteItem[]>;
  /** The scope picker above the list; null when there is one scope. */
  tabs: ReactNode;
  guildId: string;
  agentId: string | undefined;
  onOpenStep: OpenChangeStep | undefined;
  onAsk: ((item: NoteItem) => void) | undefined;
  /** The note chosen in this scope, by display path; without one the first note opens. */
  chosenPath: string | undefined;
  onChoose: (path: string | undefined) => void;
  /** The unsaved text of every note edited in the browser, by display path. */
  drafts: Record<string, string>;
  /** Keeps a note's unsaved text, or drops it with null. */
  onDraft: (path: string, text: string | null) => void;
  /** Whether a phone starts on the open note instead of the list. */
  startsOnNote: boolean;
};

/** One scope's notes: the searchable tree beside the open note, one at a time on a phone, and a new note. */
function ScopeNotes({
  scope,
  list,
  tabs,
  guildId,
  agentId,
  onOpenStep,
  onAsk,
  chosenPath,
  onChoose,
  drafts,
  onDraft,
  startsOnNote,
}: ScopeNotesProps) {
  const wide = useMediaQuery(wideScreen);
  const [listOpen, setListOpen] = useState(!startsOnNote);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  const items = list.data ?? noNotes;
  const open = items.find((item) => item.display_path === chosenPath) ?? items[0];
  const panes = visiblePanes(wide, listOpen, Boolean(open));
  const pickFile = (path: string) => {
    onChoose(path);
    setListOpen(false);
  };
  const empty = (
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
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside
        className={cn(
          "min-h-0 flex-col gap-3 border-b border-line p-4 md:flex md:w-72 md:flex-none md:border-r md:border-b-0",
          panes.list ? "flex flex-1" : "hidden",
        )}
      >
        {tabs}
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
          <NoteListContent
            scope={scope}
            list={list}
            tree={buildTree(items, query)}
            selectedPath={open?.display_path ?? null}
            onSelect={pickFile}
            empty={wide ? null : <div className="grid flex-1 place-items-center p-2">{empty}</div>}
          />
        </div>
      </aside>

      <section className={cn("min-h-0 min-w-0 flex-1 flex-col", panes.item ? "flex" : "hidden")}>
        {open ? (
          <NoteView
            key={`${scope.id}:${open.display_path}`}
            scope={scope}
            item={open}
            guildId={guildId}
            agentId={agentId}
            onOpenStep={onOpenStep}
            onAsk={onAsk}
            onBack={wide ? undefined : () => setListOpen(true)}
            draft={drafts[open.display_path]}
            onDraft={(text) => onDraft(open.display_path, text)}
            onDeleted={() => {
              onChoose(undefined);
              setListOpen(true);
            }}
          />
        ) : list.isPending ? null : (
          <div className="grid flex-1 place-items-center p-6">{empty}</div>
        )}
      </section>

      <NewNoteDialog
        open={creating}
        onOpenChange={setCreating}
        scope={scope}
        existing={items}
        onCreated={(file) => pickFile(file.display_path)}
      />
    </div>
  );
}

type NoteListContentProps = {
  scope: NoteScope;
  list: UseQueryResult<NoteItem[]>;
  /** The scope's notes that match the search, as a tree of folders. */
  tree: FileTreeNode[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** What a scope without notes shows in the list; null where the note pane shows it instead. */
  empty: ReactNode;
};

/** The tree of one scope's notes as it loads: the tree, a failure, no match for the search, or none yet. */
function NoteListContent({
  scope,
  list,
  tree,
  selectedPath,
  onSelect,
  empty,
}: NoteListContentProps) {
  if (list.isPending) return <SkeletonRows rows={5} label="Loading notes" />;
  if (list.isError) {
    return <Banner tone="error" title="Couldn't load the notes" meta={list.error.message} />;
  }
  if (tree.length) {
    return (
      <FileTree
        key={scope.id}
        label={`${scope.title} notes`}
        nodes={tree}
        selectedId={selectedPath}
        onSelect={(node) => node.kind === "file" && onSelect(node.id)}
      />
    );
  }
  if (list.data.length) return <p className="px-2 text-sm text-muted">No notes match.</p>;
  return empty;
}

type NoteViewProps = {
  scope: NoteScope;
  item: NoteItem;
  guildId: string;
  agentId?: string | undefined;
  onOpenStep?: OpenChangeStep | undefined;
  onAsk?: ((item: NoteItem) => void) | undefined;
  onBack?: (() => void) | undefined;
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
  const file = useNote(scope.prefix, item.path);
  const save = useSaveNote(scope.prefix);
  const remove = useDeleteNote(scope.prefix);
  const notes = useEmbeddableNotes();
  const collections = useCollections();
  const [picking, setPicking] = useState<InsertKind | null>(null);
  const resolvePick = useRef<((markup: string | null) => void) | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [sharing, setSharing] = useState(false);

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
    const outcome = await copyText(value);
    if (outcome === "copied") toast({ kind: "success", title: "Copied" });
    else toast({ kind: "error", title: "Couldn't copy the note" });
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
        <Button variant="outline" size="xs" onClick={() => setSharing(true)}>
          <Icon icon={ShieldCheck} size={14} />
          Access
        </Button>
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
      <LatestChange displayPath={item.display_path} guildId={guildId} onOpenStep={onOpenStep} />

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
          sourceKey={item.display_path}
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
          onPickInsert={(kind) =>
            new Promise<string | null>((resolve) => {
              resolvePick.current = resolve;
              setPicking(kind);
            })
          }
          onOpenEmbed={setPreviewPath}
          isBrokenEmbed={isBroken}
        />
      )}

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
      <NoteAccessDialog item={item} open={sharing} onOpenChange={setSharing} />
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

type NoteAccessDialogProps = {
  item: NoteItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Who reaches a note: its access list, in a dialog over the open note. */
function NoteAccessDialog({ item, open, onOpenChange }: NoteAccessDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader title={`Access to ${item.path}`} />
        <DialogBody>
          <AccessListPanel
            target={{ kind: "note", id: item.id }}
            intro="Who reads and writes this note. Where it is placed only files it; this list decides who reaches it. An agent always reaches its own notes."
          />
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Done</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type NewNoteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: NoteScope;
  existing: readonly NoteItem[];
  onCreated: (file: FileContent) => void;
};

function NewNoteDialog({ open, onOpenChange, scope, existing, onCreated }: NewNoteDialogProps) {
  const save = useSaveNote(scope.prefix);
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
