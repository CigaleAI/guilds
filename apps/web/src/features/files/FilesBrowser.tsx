import { ArrowLeft, Download, FileUp, Paperclip, ShieldCheck, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { downloadFile, type FilesPrefix } from "../../api/files";
import { useDeleteFile, useFileList, useUploadFile } from "../../api/queries/files";
import type { FileItem } from "../../api/types/files";
import { formatSize, relativeTime } from "../../app/format";
import { useMediaQuery, wideScreen } from "../../app/media";
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
import { LatestChange, type OpenChangeStep } from "../notes/LatestChange";
import { scopeOfDisplayPath } from "../../app/displayPath";
import { fileMeta, filterFiles, uploadProblem } from "./fileList";

export type FileScope = { id: "agent" | "guild" | "org"; title: string; prefix: FilesPrefix };

type FilesBrowserProps = {
  /** The scopes to browse, the first open at start: an agent's, its guild's, the organisation's. */
  scopes: FileScope[];
  guildId: string;
  /** Opens the run step that changed a file; by default the run opens in its agent's chat. */
  onOpenStep?: OpenChangeStep;
  /** A file to open first, by display path; its scope opens with it. */
  initialPath?: string | undefined;
};

const noFiles: FileItem[] = [];

/** Shared files by scope: each scope's files side by side, and the open file with its facts and actions. */
export function FilesBrowser({ scopes, guildId, onOpenStep, initialPath }: FilesBrowserProps) {
  const wide = useMediaQuery(wideScreen);
  const [listOpen, setListOpen] = useState(!initialPath);
  const initialScope =
    initialPath && scopes.some((item) => item.id === scopeOfDisplayPath(initialPath))
      ? scopeOfDisplayPath(initialPath)
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
  const [uploading, setUploading] = useState(false);

  const items = list?.data ?? noFiles;
  const shown = filterFiles(items, query);
  const chosen = scope ? selected[scope.id] : undefined;
  const openPath = items.some((item) => item.display_path === chosen) ? chosen : items[0]?.display_path;
  const open = items.find((item) => item.display_path === openPath);

  if (!scope || !list) return null;

  const showingList = wide || listOpen || !open;
  const showingFile = Boolean(open) && (wide || !listOpen);
  const pickFile = (path: string) => {
    setSelected({ ...selected, [scope.id]: path });
    setListOpen(false);
  };
  const empty = (
    <EmptyState
      icon={Paperclip}
      title="No files yet"
      description={`Files in ${scope.title.toLowerCase()} scope appear here. Agents share them with their file tools.`}
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
          showingList ? "flex flex-1" : "hidden",
        )}
      >
        {scopes.length > 1 ? (
          <Segmented
            size="sm"
            label="Files scope"
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
            label="Search files"
            placeholder="Search files…"
            value={query}
            onValueChange={setQuery}
          />
          <IconButton icon={FileUp} label="Upload a file" variant="surface" onClick={() => setUploading(true)} />
        </div>
        <div className="-mx-2 min-h-0 flex-1 overflow-y-auto">
          {list.isPending ? (
            <SkeletonRows rows={5} label="Loading files" />
          ) : list.isError ? (
            <Banner tone="error" title="Couldn't load the files" meta={list.error.message} />
          ) : shown.length ? (
            <FileRows items={shown} selectedPath={openPath ?? null} onSelect={pickFile} />
          ) : items.length ? (
            <p className="px-2 text-sm text-muted">No files match.</p>
          ) : !wide ? (
            <div className="grid flex-1 place-items-center p-2">{empty}</div>
          ) : null}
        </div>
      </aside>

      <section className={cn("min-h-0 min-w-0 flex-1 flex-col", showingFile || (wide && !open) ? "flex" : "hidden")}>
        {open ? (
          <FileView
            key={`${scope.id}:${open.display_path}`}
            scope={scope}
            item={open}
            guildId={guildId}
            {...(onOpenStep ? { onOpenStep } : {})}
            {...(!wide ? { onBack: () => setListOpen(true) } : {})}
            onDeleted={() => {
              setSelected({ ...selected, [scope.id]: undefined });
              setListOpen(true);
            }}
          />
        ) : list.isPending ? null : (
          <div className="grid flex-1 place-items-center p-6">{empty}</div>
        )}
      </section>

      <UploadDialog
        open={uploading}
        onOpenChange={setUploading}
        scope={scope}
        onUploaded={(file) => {
          setSelected({ ...selected, [scope.id]: file.display_path });
          setListOpen(false);
        }}
      />
    </div>
  );
}

type FileRowsProps = {
  items: readonly FileItem[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
};

/** The files of one scope, one row each: the name, then the description and facts. */
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
  scope: FileScope;
  item: FileItem;
  guildId: string;
  onOpenStep?: OpenChangeStep;
  onBack?: () => void;
  onDeleted: () => void;
};

/** One file: its path and provenance, what it is, and the actions on it. */
function FileView({ scope, item, guildId, onOpenStep, onBack, onDeleted }: FileViewProps) {
  const remove = useDeleteFile(scope.prefix);
  const [deleting, setDeleting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const download = async () => {
    setDownloading(true);
    try {
      await downloadFile(item.id, item.name);
    } catch (error) {
      toast({ kind: "error", title: "Couldn't download the file", description: (error as Error).message });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 md:p-5">
      <div className="flex flex-wrap items-center gap-2">
        {onBack ? <IconButton icon={ArrowLeft} label="Back to files" variant="ghost" size={28} onClick={onBack} /> : null}
        <span className="min-w-0 flex-1 truncate font-mono text-sm">
          <span className="text-muted">~/{scope.id}/files/</span>
          {item.name}
        </span>
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
              intro="Who reads and writes this file. Where it is placed only files it; this list decides who reaches it. An agent always reaches its own files."
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

/** Picks a file and says what it is; a file of the same name in the scope is replaced. */
function UploadDialog({ open, onOpenChange, scope, onUploaded }: UploadDialogProps) {
  const upload = useUploadFile(scope.prefix);
  const [file, setFile] = useState<File | null>(null);
  const [description, setDescription] = useState("");
  const [touched, setTouched] = useState(false);
  const problem = uploadProblem(file, description);

  const close = () => {
    setFile(null);
    setDescription("");
    setTouched(false);
    upload.reset();
    onOpenChange(false);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problem || !file) return;
    upload.mutate(
      { file, description },
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
            description={`In ${scope.title.toLowerCase()} scope. A file of the same name there is replaced.`}
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
