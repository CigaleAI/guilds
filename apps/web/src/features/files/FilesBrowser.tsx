import { ArrowLeft, Download, FileUp, Paperclip, ShieldCheck, Trash2 } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useDeleteFile, useFileSections, useUploadFile } from "../../api/queries/files";
import type { AccessRow, ItemSections, ReachSubject } from "../../api/types/access";
import type { FileItem, StoredFile } from "../../api/types/files";
import { formatSize, relativeTime } from "../../app/format";
import { useMediaQuery, visiblePanes, wideScreen } from "../../app/media";
import {
  Banner,
  Button,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Icon,
  IconButton,
  ModeTag,
  Row,
  SearchField,
  SectionList,
  SkeletonRows,
  TextField,
  cn,
  toast,
} from "@guildsrun/ui";
import { AccessListDialog } from "../access/AccessListDialog";
import { HomeGuildField } from "../access/HomeGuildField";
import { findOpenItem, homeLabel, isUnreached, listedItems } from "../access/listedItems";
import { StartingAccessField } from "../access/StartingAccessField";
import { LatestChange, type OpenChangeStep } from "../notes/LatestChange";
import { attemptFileDownload } from "./download";
import { fileMeta, searchFiles, uploadExpectedVersion, uploadFailure, uploadProblem } from "./fileList";

type FilesBrowserProps = {
  /** The guild's or agent's page whose files the browser lists; a file uploaded from it starts with a row for it. */
  page: ReachSubject;
  /** The page's guild, or the agent's: a file uploaded from the page is homed in it. */
  guildId: string;
  /** Opens the run step that changed a file; by default the run opens in its agent's chat. */
  onOpenStep?: OpenChangeStep;
  /** A file to open first, by display path, in either section. */
  initialPath?: string | undefined;
};

const noFiles: ItemSections<FileItem> = { own: [], shared: [] };

/** What the guild's own section holds when it holds nothing, by page. */
const emptyOwnFiles: Record<ReachSubject["type"], string> = {
  guild: "Files made in this guild appear here.",
  agent: "Files made in this agent's guild appear here.",
};

/** What the shared section holds, as it says when it holds nothing. */
const emptySharedFiles =
  "Files from elsewhere that a row for this guild, its agents or the organisation reaches appear here.";

const fileAccessIntro = "Who reads and writes this file.";

/**
 * A guild's or an agent's shared files in two sections, the guild's own and those shared with it,
 * beside the open file with its facts and actions. A greyed file, which no row reaches for the
 * page, opens its access list.
 */
export function FilesBrowser({ page, guildId, onOpenStep, initialPath }: FilesBrowserProps) {
  const wide = useMediaQuery(wideScreen);
  const list = useFileSections(page);
  const [chosenPath, setChosenPath] = useState(initialPath);
  const [listOpen, setListOpen] = useState(!initialPath);
  const [query, setQuery] = useState("");
  const [uploading, setUploading] = useState(false);
  const [accessItem, setAccessItem] = useState<FileItem | null>(null);

  const sections = list.data ?? noFiles;
  const listed = listedItems(sections);
  const open = findOpenItem(sections, chosenPath);
  const panes = visiblePanes(wide, listOpen, Boolean(open));
  const pickFile = (path: string) => {
    setChosenPath(path);
    setListOpen(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside
        className={cn(
          "min-h-0 flex-col gap-3 border-b border-line p-4 md:flex md:w-80 md:flex-none md:border-r md:border-b-0",
          panes.list ? "flex flex-1" : "hidden",
        )}
      >
        <div className="flex items-center gap-2">
          <SearchField
            className="min-w-0 flex-1"
            tone="surface"
            label="Search files"
            placeholder="Search files…"
            value={query}
            onValueChange={setQuery}
          />
          <IconButton icon={FileUp} label="Upload a file" variant="surface" onClick={() => setUploading(true)} />
        </div>
        <div className="-mx-2 min-h-0 flex-1 overflow-y-auto">
          <FileListContent
            page={page}
            list={list}
            shown={searchFiles(sections, query)}
            searching={Boolean(query.trim())}
            selectedPath={open?.display_path ?? null}
            onPick={(item) => (isUnreached(item) ? setAccessItem(item) : pickFile(item.display_path))}
          />
        </div>
      </aside>

      <section className={cn("min-h-0 min-w-0 flex-1 flex-col", panes.item ? "flex" : "hidden")}>
        {open ? (
          <FileView
            key={open.display_path}
            item={open}
            guildId={guildId}
            onOpenStep={onOpenStep}
            onAccess={() => setAccessItem(open)}
            onBack={wide ? undefined : () => setListOpen(true)}
            onDeleted={() => {
              setChosenPath(undefined);
              setListOpen(true);
            }}
          />
        ) : list.isPending ? null : (
          <div className="grid flex-1 place-items-center p-6">
            <NoOpenFile listed={listed.length > 0} onUpload={() => setUploading(true)} />
          </div>
        )}
      </section>

      {accessItem ? (
        <AccessListDialog
          target={{ kind: "file", id: accessItem.id }}
          name={accessItem.name}
          intro={fileAccessIntro}
          onClose={() => setAccessItem(null)}
        />
      ) : null}
      <UploadDialog
        open={uploading}
        onOpenChange={setUploading}
        page={page}
        guildId={guildId}
        listed={listed}
        onUploaded={(file) => pickFile(file.display_path)}
      />
    </div>
  );
}

type NoOpenFileProps = {
  /** Whether the page lists any file, every one of them greyed when none is open. */
  listed: boolean;
  onUpload: () => void;
};

/** The file pane with no file open: none listed yet, or every listed file greyed. */
function NoOpenFile({ listed, onUpload }: NoOpenFileProps) {
  return (
    <EmptyState
      icon={Paperclip}
      title={listed ? "No file reached" : "No files yet"}
      description={
        listed
          ? "No row reaches the listed files for this page. Open a greyed file to change its access."
          : "Agents share files with their file tools."
      }
      action={
        <Button size="sm" onClick={onUpload}>
          Upload a file
        </Button>
      }
    />
  );
}

type FileListContentProps = {
  page: ReachSubject;
  list: UseQueryResult<ItemSections<FileItem>>;
  /** The page's files that match the search. */
  shown: ItemSections<FileItem>;
  /** Whether a search is typed, so an empty section says no file matches. */
  searching: boolean;
  selectedPath: string | null;
  /** Opens a file, or the access list of a greyed one. */
  onPick: (item: FileItem) => void;
};

/** The page's files as they load: the two sections, or a failure. */
function FileListContent({ page, list, shown, searching, selectedPath, onPick }: FileListContentProps) {
  if (list.isPending) return <SkeletonRows rows={5} label="Loading files" />;
  if (list.isError) {
    return <Banner tone="error" title="Couldn't load the files" meta={list.error.message} />;
  }
  return (
    <div className="flex flex-col gap-3">
      <SectionList
        label="Guild files"
        count={shown.own.length}
        empty={searching ? "No files match." : emptyOwnFiles[page.type]}
      >
        {shown.own.map((item) => (
          <FileRow
            key={item.id}
            item={item}
            selected={item.display_path === selectedPath}
            onPick={onPick}
          />
        ))}
      </SectionList>
      <SectionList
        label="Shared with this guild"
        count={shown.shared.length}
        empty={searching ? "No files match." : emptySharedFiles}
      >
        {shown.shared.map((item) => (
          <FileRow
            key={item.id}
            item={item}
            home={homeLabel(item)}
            selected={item.display_path === selectedPath}
            onPick={onPick}
          />
        ))}
      </SectionList>
    </div>
  );
}

type FileRowProps = {
  item: FileItem;
  /** Where a shared file is homed, before its facts. */
  home?: string;
  selected: boolean;
  onPick: (item: FileItem) => void;
};

/** One listed file: its name, description and facts, and how the page reaches it, greyed when no row does. */
function FileRow({ item, home, selected, onPick }: FileRowProps) {
  const unreached = isUnreached(item);
  const facts = fileMeta(item, relativeTime(item.updated_at));
  return (
    <Row
      asChild
      interactive
      density="compact"
      mono
      muted={unreached}
      selected={selected}
      lead={<Icon icon={Paperclip} size={14} />}
      title={item.name}
      meta={
        <>
          <span className="block truncate">{item.description}</span>
          <span className="block truncate">{home ? `${home} · ${facts}` : facts}</span>
        </>
      }
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

type FileViewProps = {
  item: FileItem;
  guildId: string;
  onOpenStep?: OpenChangeStep | undefined;
  /** Opens the file's access list. */
  onAccess: () => void;
  onBack?: (() => void) | undefined;
  onDeleted: () => void;
};

/** One file: its path and provenance, what it is, and the actions on it. */
function FileView({ item, guildId, onOpenStep, onAccess, onBack, onDeleted }: FileViewProps) {
  const remove = useDeleteFile();
  const [deleting, setDeleting] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const download = async () => {
    setDownloading(true);
    const outcome = await attemptFileDownload(item.id, item.name);
    setDownloading(false);
    if (outcome.kind === "failed") {
      toast({ kind: "error", title: "Couldn't download the file", description: outcome.reason });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 md:p-5">
      <div className="flex flex-wrap items-center gap-2">
        {onBack ? <IconButton icon={ArrowLeft} label="Back to files" variant="ghost" size={28} onClick={onBack} /> : null}
        <span className="min-w-0 flex-1 truncate font-mono text-sm">{item.name}</span>
        <Button variant="outline" size="xs" onClick={onAccess}>
          <Icon icon={ShieldCheck} size={14} />
          Access
        </Button>
        <Button variant="outline" size="xs" disabled={downloading} onClick={() => void download()}>
          <Icon icon={Download} size={14} />
          {downloading ? "Downloading…" : "Download"}
        </Button>
        <IconButton icon={Trash2} label={`Delete ${item.name}`} variant="ghost" size={28} onClick={() => setDeleting(true)} />
      </div>
      <LatestChange displayPath={item.display_path} guildId={guildId} {...(onOpenStep ? { onOpenStep } : {})} />

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted">Description</dt>
        <dd className="min-w-0 break-words">{item.description}</dd>
        <dt className="text-muted">Type</dt>
        <dd className="font-mono">{item.mime}</dd>
        <dt className="text-muted">Size</dt>
        <dd>{formatSize(item.bytes)}</dd>
        <dt className="text-muted">Version</dt>
        <dd>{item.version}</dd>
        <dt className="text-muted">Display path</dt>
        <dd className="min-w-0 break-all font-mono text-xs">{item.display_path}</dd>
      </dl>
      <p className="text-sm text-muted">
        Agents fetch this file into their home with <code>file_fetch</code> and replace it with <code>file_put</code>.
        Its bytes never reach a model.
      </p>

      <ConfirmDialog
        kind="destructive"
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${item.name}?`}
        description="The file and its bytes are removed. Agents that fetched it keep their copies."
        confirmLabel="Delete file"
        onConfirm={() =>
          remove.mutateAsync(item.id).then(
            () => {
              onDeleted();
              toast({ kind: "success", title: `${item.name} deleted` });
            },
            (error: Error) => {
              toast({ kind: "error", title: "Couldn't delete the file", description: error.message });
              throw error;
            },
          )
        }
      />
    </div>
  );
}

type UploadDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The page the file is uploaded on: its first row names the page's guild or agent. */
  page: ReachSubject;
  /** The guild the file is homed in. */
  guildId: string;
  /** The files the page lists, in both sections: one of the same name is the file the upload replaces. */
  listed: readonly FileItem[];
  onUploaded: (file: StoredFile) => void;
};

/**
 * Picks a file, says what it is, and names who reaches it first: the page's guild or agent at
 * write unless the operator picks another. A new file is homed in the page's guild. A file of the
 * same name in the page's list is replaced over the version the list loaded and keeps its home;
 * any other upload only creates.
 */
function UploadDialog({ open, onOpenChange, page, guildId, listed, onUploaded }: UploadDialogProps) {
  const upload = useUploadFile();
  const pageAccess: AccessRow = { ...page, mode: "write" };
  const [file, setFile] = useState<File | null>(null);
  const [description, setDescription] = useState("");
  const [access, setAccess] = useState<AccessRow>(pageAccess);
  const [touched, setTouched] = useState(false);
  const problem = uploadProblem(file, description);

  const close = () => {
    setFile(null);
    setDescription("");
    setAccess(pageAccess);
    setTouched(false);
    upload.reset();
    onOpenChange(false);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problem || !file) return;
    upload.mutate(
      {
        file,
        description,
        access,
        homeGuildId: guildId,
        expectedVersion: uploadExpectedVersion(file.name, listed),
      },
      {
        onSuccess: (item) => {
          onUploaded(item);
          toast({ kind: "success", title: `${item.name} uploaded` });
          close();
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent size="sm">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader
            title="Upload a file"
            description="A file of the same name in this list is replaced and keeps its access list and home; a name another file of the organisation holds is refused."
          />
          <DialogBody>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted">File</span>
                <input
                  type="file"
                  className="text-sm"
                  onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
                />
              </label>
              <TextField
                tone="surface"
                label="Description"
                placeholder="What the file is, in a sentence"
                value={description}
                maxLength={400}
                onChange={(event) => setDescription(event.currentTarget.value)}
                {...(touched && problem ? { error: problem } : {})}
              />
              <HomeGuildField guildId={guildId} />
              <StartingAccessField value={access} onChange={setAccess} disabled={upload.isPending} />
              {upload.isError ? (
                <Banner tone="error" title="Couldn't upload the file">
                  {uploadFailure(upload.error, upload.variables?.expectedVersion)}
                </Banner>
              ) : null}
            </div>
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={upload.isPending}>
              {upload.isPending ? "Uploading…" : "Upload"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
