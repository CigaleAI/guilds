import { useBlocker } from "@tanstack/react-router";
import { ArrowLeft, Copy, FilePlus, FileText, Pin, ShieldCheck, Trash2 } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { ApiError } from "../../api/client";
import { useCollections } from "../../api/queries/tables";
import {
  useDeleteNote,
  useEmbeddableNotes,
  useNote,
  useNoteSections,
  useSaveNote,
} from "../../api/queries/notes";
import type { AccessRow, ItemSections, ReachSubject } from "../../api/types/access";
import type { EmbeddableNoteList, FileContent, NoteItem } from "../../api/types/notes";
import { copyText } from "../../app/clipboard";
import { useIdentity } from "../../app/identity";
import { useMediaQuery, visiblePanes, wideScreen } from "../../app/media";
import {
  cn,
  Button,
  Icon,
  IconButton,
  ModeTag,
  Row,
  SectionList,
  TaskEditor,
  SearchField,
  TextField,
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
import type { InsertKind } from "@guildsrun/ui";
import { AccessListDialog } from "../access/AccessListDialog";
import { HomeGuildField } from "../access/HomeGuildField";
import { findOpenItem, homeLabel, isUnreached, listedItems } from "../access/listedItems";
import { sectionCopy } from "../access/sectionCopy";
import { StartingAccessField } from "../access/StartingAccessField";
import { EmbedPreview } from "./EmbedPreview";
import { embedIsBroken } from "./embeds";
import { InsertPicker } from "./InsertPicker";
import { newNotePath, searchNotes } from "./noteList";
import { LatestChange, type OpenChangeStep } from "./LatestChange";

type NotesBrowserProps = {
  /** The guild's or agent's page whose notes the browser lists; a note created from it starts with a row for it. */
  page: ReachSubject;
  /** The page's guild, or the agent's: a note created from the page is homed in it. */
  guildId: string;
  /** Opens the run step that changed a file; by default the run opens in its agent's chat. */
  onOpenStep?: OpenChangeStep;
  /** A note to open first, by display path, in either section. */
  initialPath?: string | undefined;
  /** Pins the open file to a question for Studio's coach. */
  onAsk?: ((item: NoteItem) => void) | undefined;
};

const noNotes: ItemSections<NoteItem> = { own: [], shared: [] };

const noteAccessIntro = "Who reads and writes this note.";

/**
 * A guild's or an agent's notes in two sections, the guild's own and those shared with it, beside
 * the open note in an editor. A greyed note, which no row reaches for the page, opens its access
 * list. A save over a version someone saved since is refused and the text kept; embeds work as in
 * the Task.
 */
export function NotesBrowser({ page, guildId, onOpenStep, initialPath, onAsk }: NotesBrowserProps) {
  const wide = useMediaQuery(wideScreen);
  const list = useNoteSections(page);
  const [chosenPath, setChosenPath] = useState(initialPath);
  const [listOpen, setListOpen] = useState(!initialPath);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [accessItem, setAccessItem] = useState<NoteItem | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const unsaved = Object.keys(drafts).length > 0;

  const blocker = useBlocker({
    shouldBlockFn: () => unsaved,
    enableBeforeUnload: () => unsaved,
    withResolver: true,
  });

  const sections = list.data ?? noNotes;
  const open = findOpenItem(sections, chosenPath);
  const panes = visiblePanes(wide, listOpen, Boolean(open));
  const pickNote = (path: string) => {
    setChosenPath(path);
    setListOpen(false);
  };
  const keepDraft = (path: string, text: string | null) =>
    setDrafts((current) => {
      const next = { ...current };
      if (text === null) delete next[path];
      else next[path] = text;
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside
        className={cn(
          "min-h-0 flex-col gap-3 border-b border-line p-4 md:flex md:w-72 md:flex-none md:border-r md:border-b-0",
          panes.list ? "flex flex-1" : "hidden",
        )}
      >
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
            page={page}
            list={list}
            shown={searchNotes(sections, query)}
            searching={Boolean(query.trim())}
            selectedPath={open?.display_path ?? null}
            onPick={(item) => (isUnreached(item) ? setAccessItem(item) : pickNote(item.display_path))}
          />
        </div>
      </aside>

      <section className={cn("min-h-0 min-w-0 flex-1 flex-col", panes.item ? "flex" : "hidden")}>
        {open ? (
          <NoteView
            key={open.display_path}
            item={open}
            guildId={guildId}
            onOpenStep={onOpenStep}
            onAsk={onAsk}
            onAccess={() => setAccessItem(open)}
            onBack={wide ? undefined : () => setListOpen(true)}
            draft={drafts[open.display_path]}
            onDraft={(text) => keepDraft(open.display_path, text)}
            onDeleted={() => {
              setChosenPath(undefined);
              setListOpen(true);
            }}
          />
        ) : list.isPending ? null : (
          <div className="grid flex-1 place-items-center p-6">
            <NoOpenNote listed={listedItems(sections).length > 0} onCreate={() => setCreating(true)} />
          </div>
        )}
      </section>

      {accessItem ? (
        <AccessListDialog
          target={{ kind: "note", id: accessItem.id }}
          name={accessItem.path}
          intro={noteAccessIntro}
          onClose={() => setAccessItem(null)}
        />
      ) : null}
      <NewNoteDialog
        open={creating}
        onOpenChange={setCreating}
        page={page}
        guildId={guildId}
        onCreated={(file) => pickNote(file.display_path)}
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

type NoOpenNoteProps = {
  /** Whether the page lists any note, every one of them greyed when none is open. */
  listed: boolean;
  onCreate: () => void;
};

/** The note pane with no note open: none listed yet, or every listed note greyed. */
function NoOpenNote({ listed, onCreate }: NoOpenNoteProps) {
  return (
    <EmptyState
      icon={FileText}
      title={listed ? "No note reached" : "No notes yet"}
      description={
        listed
          ? "No row reaches the listed notes for this page. Open a greyed note to change its access."
          : "Agents write notes with their note tools."
      }
      action={
        <Button size="sm" onClick={onCreate}>
          New note
        </Button>
      }
    />
  );
}

type NoteListContentProps = {
  page: ReachSubject;
  list: UseQueryResult<ItemSections<NoteItem>>;
  /** The page's notes that match the search. */
  shown: ItemSections<NoteItem>;
  /** Whether a search is typed, so an empty section says no note matches. */
  searching: boolean;
  selectedPath: string | null;
  /** Opens a note, or the access list of a greyed one. */
  onPick: (item: NoteItem) => void;
};

/** The page's notes as they load: the two sections, or a failure. */
function NoteListContent({ page, list, shown, searching, selectedPath, onPick }: NoteListContentProps) {
  if (list.isPending) return <SkeletonRows rows={5} label="Loading notes" />;
  if (list.isError) {
    return <Banner tone="error" title="Couldn't load the notes" meta={list.error.message} />;
  }
  const copy = sectionCopy("note", page.type);
  return (
    <div className="flex flex-col gap-3">
      <SectionList
        label={copy.ownLabel}
        count={shown.own.length}
        empty={searching ? copy.noMatch : copy.ownEmpty}
      >
        {shown.own.map((item) => (
          <NoteRow
            key={item.id}
            item={item}
            selected={item.display_path === selectedPath}
            onPick={onPick}
          />
        ))}
      </SectionList>
      <SectionList
        label={copy.sharedLabel}
        count={shown.shared.length}
        empty={searching ? copy.noMatch : copy.sharedEmpty}
      >
        {shown.shared.map((item) => (
          <NoteRow
            key={item.id}
            item={item}
            meta={homeLabel(item)}
            selected={item.display_path === selectedPath}
            onPick={onPick}
          />
        ))}
      </SectionList>
    </div>
  );
}

type NoteRowProps = {
  item: NoteItem;
  /** The caption under the key: where a shared note is homed. */
  meta?: string;
  selected: boolean;
  onPick: (item: NoteItem) => void;
};

/** One listed note: its key and how the page reaches it, greyed when no row does. */
function NoteRow({ item, meta, selected, onPick }: NoteRowProps) {
  const unreached = isUnreached(item);
  return (
    <Row
      asChild
      interactive
      density="compact"
      mono
      muted={unreached}
      selected={selected}
      title={item.path}
      meta={meta}
      trail={<ModeTag mode={item.viewer_mode} />}
    >
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        title={unreached ? "No row reaches it for this page: open its access list" : undefined}
        onClick={() => onPick(item)}
      />
    </Row>
  );
}

type NoteViewProps = {
  item: NoteItem;
  guildId: string;
  onOpenStep?: OpenChangeStep | undefined;
  onAsk?: ((item: NoteItem) => void) | undefined;
  /** Opens the note's access list. */
  onAccess: () => void;
  onBack?: (() => void) | undefined;
  draft: string | undefined;
  onDraft: (text: string | null) => void;
  onDeleted: () => void;
};

/** One note: its path and provenance, and its text to edit. */
function NoteView({
  item,
  guildId,
  onOpenStep,
  onAsk,
  onAccess,
  onBack,
  draft,
  onDraft,
  onDeleted,
}: NoteViewProps) {
  const { org } = useIdentity();
  const file = useNote(item.path);
  const save = useSaveNote();
  const remove = useDeleteNote();
  const notes = useEmbeddableNotes();
  const collections = useCollections();
  const [picking, setPicking] = useState<InsertKind | null>(null);
  const resolvePick = useRef<((markup: string | null) => void) | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const otherNotes = useMemo<EmbeddableNoteList | undefined>(
    () =>
      notes.data && {
        kind: "list",
        notes: notes.data.notes.filter((note) => note.display_path !== item.display_path),
      },
    [notes.data, item.display_path],
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
        <span className="min-w-0 flex-1 truncate font-mono text-sm">{item.path}</span>
        {onAsk ? (
          <Button variant="outline" size="xs" onClick={() => onAsk(item)}>
            <Icon icon={Pin} size={14} />
            Ask the coach
          </Button>
        ) : null}
        <Button variant="outline" size="xs" onClick={onAccess}>
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
              {
                path: item.path,
                content: value,
                ...(file.data?.version !== undefined ? { expected_version: file.data.version } : {}),
              },
              {
                onSuccess: () => {
                  onDraft(null);
                  toast({ kind: "success", title: `${item.path} saved` });
                },
                onError: (error) => {
                  if (!(error instanceof ApiError && error.status === 409)) {
                    toast({ kind: "error", title: "Couldn't save the note", description: error.message });
                    return;
                  }
                  void file.refetch();
                  toast({
                    kind: "warning",
                    title: "Someone saved the note while you were editing",
                    description: "Your text is kept. Compare it with theirs before saving.",
                  });
                },
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
        notes={otherNotes}
        notesError={notes.error}
        collections={collections.data}
        collectionsError={collections.error}
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
        notesError={notes.error}
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

type NewNoteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The page the note is made on: its first row names the page's guild or agent. */
  page: ReachSubject;
  /** The guild the note is homed in. */
  guildId: string;
  onCreated: (file: FileContent) => void;
};

/**
 * Names a new note of the organisation, homed in the page's guild, and who reaches it first: the
 * page's guild or agent at write unless the operator picks another. It only creates: a name
 * another note holds is refused.
 */
function NewNoteDialog({ open, onOpenChange, page, guildId, onCreated }: NewNoteDialogProps) {
  const save = useSaveNote();
  const pageAccess: AccessRow = { ...page, mode: "write" };
  const [name, setName] = useState("untitled");
  const [access, setAccess] = useState<AccessRow>(pageAccess);
  const [touched, setTouched] = useState(false);
  const result = newNotePath(name);

  const close = () => {
    setName("untitled");
    setAccess(pageAccess);
    setTouched(false);
    save.reset();
    onOpenChange(false);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if ("error" in result) return;
    save.mutate(
      { path: result.path, content: "", access, home_guild_id: guildId, expected_version: 0 },
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
          <DialogHeader title="New note" description="A note's name is unique in the organisation." />
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
            <HomeGuildField guildId={guildId} />
            <StartingAccessField value={access} onChange={setAccess} disabled={save.isPending} />
            {save.isError ? (
              <Banner tone="error" title="Couldn't create the note">
                {save.error instanceof ApiError && save.error.status === 409
                  ? "A note with this name already exists in the organisation."
                  : save.error.message}
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
