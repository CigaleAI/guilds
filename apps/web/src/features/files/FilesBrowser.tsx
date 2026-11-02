import { ArrowLeft, Download, FileUp, Paperclip, ShieldCheck, Trash2 } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { useDeleteFile, useFileList, useUploadFile } from "../../api/queries/files";
import type { AccessRow, AccessSubject } from "../../api/types/access";
import type { FileItem } from "../../api/types/files";
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
  SearchField,
  Segmented,
  SkeletonRows,
  TextField,
  cn,
  toast,
} from "@guildsrun/ui";
import { AccessListPanel } from "../access/AccessListPanel";
import { StartingAccessField } from "../access/StartingAccessField";
import { LatestChange, type OpenChangeStep } from "../notes/LatestChange";
import { attemptFileDownload } from "./download";
import { fileMeta, filterFiles, uploadProblem } from "./fileList";

/**
 * A page whose files the browser lists: an agent's lists the files it reads, a guild's the files
 * whose access list names the guild, one of its agents or the organisation, the organisation's
 * every file. A file uploaded from it starts with a row for the page's subject.
 */
export type FileScope = { title: string; page: AccessSubject };

type FilesBrowserProps = {
  /** The pages to browse, the first open at start; the organisation's is the last. */
  scopes: FileScope[];
  guildId: string;
  /** Opens the run step that changed a file; by default the run opens in its agent's chat. */
  onOpenStep?: OpenChangeStep;
  /** A file to open first, by display path; the organisation's list, which holds every file, opens with it. */
  initialPath?: string | undefined;
};

const noFiles: FileItem[] = [];

/** What each page's list holds, as its empty state says. */
const emptyFiles: Record<AccessSubject["type"], string> = {
  agent: "Files this agent reads appear here.",
  guild: "Files open to this guild, its agents or the organisation appear here.",
  org: "Every file of the organisation appears here.",
};

/** Shared files by page: each page's list, and the open file with its facts and actions. */
export function FilesBrowser({ scopes, guildId, onOpenStep, initialPath }: FilesBrowserProps) {
  const initialScope = initialPath ? scopes.find((item) => item.page.type === "org")?.page.type : undefined;
  const [scopeId, setScopeId] = useState(initialScope ?? scopes[0]?.page.type ?? "guild");
  const scope = scopes.find((item) => item.page.type === scopeId) ?? scopes[0];
  const pageOf = (type: AccessSubject["type"]) => scopes.find((item) => item.page.type === type)?.page ?? null;
  const lists = {
    agent: useFileList(pageOf("agent")),
    guild: useFileList(pageOf("guild")),
    org: useFileList(pageOf("org")),
  };
  const [selected, setSelected] = useState<Partial<Record<AccessSubject["type"], string>>>(() =>
    initialScope && initialPath ? { [initialScope]: initialPath } : {},
  );

  if (!scope) return null;

  return (
    <ScopeFiles
      scope={scope}
      list={lists[scope.page.type]}
      tabs={
        scopes.length > 1 ? (
          <Segmented
            size="sm"
            label="Files list"
            value={scope.page.type}
            onValueChange={setScopeId}
            options={scopes.map((item) => ({
              value: item.page.type,
              label: item.title,
              count: lists[item.page.type].data?.length ?? 0,
            }))}
          />
        ) : null
      }
      guildId={guildId}
      onOpenStep={onOpenStep}
      chosenPath={selected[scope.page.type]}
      onChoose={(path) => setSelected({ ...selected, [scope.page.type]: path })}
      startsOnFile={Boolean(initialPath)}
    />
  );
}

type ScopeFilesProps = {
  scope: FileScope;
  list: UseQueryResult<FileItem[]>;
  /** The list picker above the list; null when there is one list. */
  tabs: ReactNode;
  guildId: string;
  onOpenStep: OpenChangeStep | undefined;
  /** The file chosen in this list, by display path; without one the first file opens. */
  chosenPath: string | undefined;
  onChoose: (path: string | undefined) => void;
  /** Whether a phone starts on the open file instead of the list. */
  startsOnFile: boolean;
};

/** One page's files: the searchable list beside the open file, one at a time on a phone, and the upload. */
function ScopeFiles({
  scope,
  list,
  tabs,
  guildId,
  onOpenStep,
  chosenPath,
  onChoose,
  startsOnFile,
}: ScopeFilesProps) {
  const wide = useMediaQuery(wideScreen);
  const [listOpen, setListOpen] = useState(!startsOnFile);
  const [query, setQuery] = useState("");
  const [uploading, setUploading] = useState(false);

  const items = list.data ?? noFiles;
  const open = items.find((item) => item.display_path === chosenPath) ?? items[0];
  const panes = visiblePanes(wide, listOpen, Boolean(open));
  const pickFile = (path: string) => {
    onChoose(path);
    setListOpen(false);
  };
  const empty = (
    <EmptyState
      icon={Paperclip}
      title="No files yet"
      description={`${emptyFiles[scope.page.type]} Agents share files with their file tools.`}
      action={
        <Button size="sm" onClick={() => setUploading(true)}>
          Upload a file
        </Button>
      }
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside
        className={cn(
          "min-h-0 flex-col gap-3 border-b border-line p-4 md:flex md:w-80 md:flex-none md:border-r md:border-b-0",
          panes.list ? "flex flex-1" : "hidden",
        )}
      >
        {tabs}
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
            list={list}
            shown={filterFiles(items, query)}
            selectedPath={open?.display_path ?? null}
            onSelect={pickFile}
            empty={wide ? null : <div className="grid flex-1 place-items-center p-2">{empty}</div>}
          />
        </div>
      </aside>

      <section className={cn("min-h-0 min-w-0 flex-1 flex-col", panes.item ? "flex" : "hidden")}>
        {open ? (
          <FileView
            key={`${scope.page.type}:${open.display_path}`}
            item={open}
            guildId={guildId}
            onOpenStep={onOpenStep}
            onBack={wide ? undefined : () => setListOpen(true)}
            onDeleted={() => {
              onChoose(undefined);
              setListOpen(true);
            }}
          />
        ) : list.isPending ? null : (
          <div className="grid flex-1 place-items-center p-6">{empty}</div>
        )}
      </section>

      <UploadDialog
        key={scope.page.type}
        open={uploading}
        onOpenChange={setUploading}
        scope={scope}
        onUploaded={(file) => pickFile(file.display_path)}
      />
    </div>
  );
}

type FileListContentProps = {
  list: UseQueryResult<FileItem[]>;
  /** The list's files that match the search. */
  shown: readonly FileItem[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** What a list without files shows; null where the file pane shows it instead. */
  empty: ReactNode;
};

/** One page's list of files as it loads: rows, a failure, no match for the search, or none yet. */
function FileListContent({ list, shown, selectedPath, onSelect, empty }: FileListContentProps) {
  if (list.isPending) return <SkeletonRows rows={5} label="Loading files" />;
  if (list.isError) {
    return <Banner tone="error" title="Couldn't load the files" meta={list.error.message} />;
  }
  if (shown.length) return <FileRows items={shown} selectedPath={selectedPath} onSelect={onSelect} />;
  if (list.data.length) return <p className="px-2 text-sm text-muted">No files match.</p>;
  return empty;
}

type FileRowsProps = {
  items: readonly FileItem[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
};

/** The files of one list, one row each: the name, then the description and facts. */
function FileRows({ items, selectedPath, onSelect }: FileRowsProps) {
  return (
    <ul className="flex flex-col" aria-label="Files">
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            aria-current={item.display_path === selectedPath ? "true" : undefined}
            onClick={() => onSelect(item.display_path)}
            className={cn(
              "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-surface-2",
              item.display_path === selectedPath && "bg-surface-2",
            )}
          >
            <span className="flex items-center gap-2 text-sm">
              <Icon icon={Paperclip} size={14} className="text-muted" />
              <span className="min-w-0 flex-1 truncate font-mono">{item.name}</span>
            </span>
            <span className="truncate pl-6 text-xs text-muted">{item.description}</span>
            <span className="truncate pl-6 text-xs text-muted">{fileMeta(item, relativeTime(item.updated_at))}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

type FileViewProps = {
  item: FileItem;
  guildId: string;
  onOpenStep?: OpenChangeStep | undefined;
  onBack?: (() => void) | undefined;
  onDeleted: () => void;
};

/** One file: its path and provenance, what it is, and the actions on it. */
function FileView({ item, guildId, onOpenStep, onBack, onDeleted }: FileViewProps) {
  const remove = useDeleteFile();
  const [deleting, setDeleting] = useState(false);
  const [sharing, setSharing] = useState(false);
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
        <Button variant="outline" size="xs" onClick={() => setSharing(true)}>
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

      <Dialog open={sharing} onOpenChange={setSharing}>
        <DialogContent size="lg">
          <DialogHeader title={`Access to ${item.name}`} />
          <DialogBody>
            <AccessListPanel
              target={{ kind: "file", id: item.id }}
              intro="Who reads and writes this file."
            />
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Done</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  scope: FileScope;
  onUploaded: (file: FileItem) => void;
};

/**
 * Picks a file, says what it is, and names who reaches it first, the page's subject at write
 * unless the operator picks another; a file of the same name in the organisation is replaced.
 */
function UploadDialog({ open, onOpenChange, scope, onUploaded }: UploadDialogProps) {
  const upload = useUploadFile();
  const pageAccess: AccessRow = { ...scope.page, mode: "write" };
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
      { file, description, access },
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
            description="A file of the same name in the organisation is replaced and keeps its access list."
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
              <StartingAccessField value={access} onChange={setAccess} disabled={upload.isPending} />
              {upload.isError ? (
                <Banner tone="error" title="Couldn't upload the file">
                  {upload.error.message}
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
