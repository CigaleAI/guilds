import { ExternalLink, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { lookupWithLogin, useDriveFolder } from "../../api/queries/access";
import type { LookupOption } from "../../api/types/access";
import { isString } from "../../api/wire";
import { ConfirmDialog, Icon, IconButton, SearchField } from "@guildsrun/ui";
import { DRIVE_PATH_UNAVAILABLE, driveFolderUrl } from "./driveFolder";
import { useLookup } from "./SettingsForm";

type DriveFolderFieldProps = {
  connectionId: string;
  /** The folder the settings being edited hold; empty when they hold none. */
  folderId: string;
  disabled: boolean;
  /** Undefined for an inherited login's folder, which this scope can only read. */
  onChange: ((next: string | undefined) => void) | undefined;
};

/**
 * A Drive login's one folder: its name, its path as the login reads it, and its link in Drive. The
 * scope's own login searches for another, and removes the folder from the unsaved settings only.
 */
export function DriveFolderField({
  connectionId,
  folderId,
  disabled,
  onChange,
}: DriveFolderFieldProps) {
  const [picked, setPicked] = useState<LookupOption | null>(null);
  const [removed, setRemoved] = useState(false);
  const searchBox = useRef<HTMLInputElement>(null);
  const known = picked !== null && picked.value === folderId ? picked : null;
  const resolved = useDriveFolder(connectionId, known ? "" : folderId);

  useEffect(() => {
    if (!removed) return;
    // The dialog hands focus back to its trigger as it closes; the trigger is gone with the folder.
    const timer = setTimeout(() => searchBox.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [removed]);

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-semibold">Folder</span>
      {folderId ? (
        <PickedFolder
          folderId={folderId}
          folder={known ?? resolved.data ?? null}
          reading={resolved.isLoading}
          error={resolved.error?.message ?? null}
          disabled={disabled}
          {...(onChange
            ? {
                onRemove: () => {
                  setPicked(null);
                  setRemoved(true);
                  onChange(undefined);
                },
              }
            : {})}
        />
      ) : (
        <p className="text-sm text-muted">
          {onChange ? "No folder picked. Pick a folder, then save." : "No folder picked."}
        </p>
      )}
      {onChange ? (
        <FolderSearch
          connectionId={connectionId}
          searchBox={searchBox}
          disabled={disabled}
          onPick={(option) => {
            if (!isString(option.value)) return;
            setPicked(option);
            setRemoved(false);
            onChange(option.value);
          }}
        />
      ) : null}
    </div>
  );
}

type FolderSearchProps = {
  connectionId: string;
  searchBox: RefObject<HTMLInputElement | null>;
  disabled: boolean;
  onPick: (option: LookupOption) => void;
};

/** A search for a folder by name or pasted link, with the login's lookup. */
function FolderSearch({ connectionId, searchBox, disabled, onPick }: FolderSearchProps) {
  const search = useCallback(
    (query: string) => lookupWithLogin(connectionId, "folder_id", query),
    [connectionId],
  );
  const lookup = useLookup(search);
  return (
    <div className="flex flex-col gap-1">
      <SearchField
        ref={searchBox}
        tone="surface"
        label="Search folders"
        placeholder="Search by name, or paste a link…"
        disabled={disabled}
        value={lookup.query}
        onValueChange={(next) => {
          lookup.setQuery(next);
          if (!next.trim()) lookup.setResults(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.preventDefault();
          if (event.key === "Escape") lookup.setResults(null);
        }}
      />
      {lookup.query.trim() && lookup.results ? (
        <FolderResults
          options={lookup.results}
          onPick={(option) => {
            onPick(option);
            lookup.reset();
          }}
        />
      ) : null}
      {lookup.error ? <p className="text-xs text-plum-t">{lookup.error}</p> : null}
    </div>
  );
}

type PickedFolderProps = {
  folderId: string;
  /** The folder as the login's lookup reads it; null when it has not, or could not. */
  folder: LookupOption | null;
  reading: boolean;
  /** Why the lookup could not read the folder; null when it could. */
  error: string | null;
  disabled: boolean;
  /** Absent for an inherited login's folder. */
  onRemove?: () => void;
};

/** The picked folder: its name, its path, its link in Drive, and the removal of the unsaved pick. */
function PickedFolder({ folderId, folder, reading, error, disabled, onRemove }: PickedFolderProps) {
  const name = folder?.label ?? folderId;
  return (
    <div className="flex items-start gap-2 rounded-lg bg-paper px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={`text-sm font-medium break-words ${folder ? "" : "font-mono"}`}>
          {name}
        </span>
        <span className="text-xs break-words text-muted">
          {reading ? "Reading the folder's path…" : (folder?.detail ?? DRIVE_PATH_UNAVAILABLE)}
        </span>
        <a
          href={driveFolderUrl(folderId)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit items-center gap-1 text-xs underline"
        >
          Open in Google Drive
          <Icon icon={ExternalLink} size={14} />
        </a>
        {error ? <p className="text-xs text-plum-t">{error}</p> : null}
      </div>
      {onRemove ? (
        <ConfirmDialog
          title={`Remove ${name}?`}
          description={`This removes ${name} from these unsaved settings only. Nothing in Google Drive is deleted or trashed, and the Google login stays connected. The saved folder stays in use until you pick another folder and save.`}
          confirmLabel="Remove folder"
          onConfirm={onRemove}
          trigger={
            <IconButton
              type="button"
              icon={X}
              label={`Remove folder ${name}`}
              variant="ghost"
              size={28}
              disabled={disabled}
            />
          }
        />
      ) : null}
    </div>
  );
}

type FolderResultsProps = {
  options: LookupOption[];
  onPick: (option: LookupOption) => void;
};

/** Folders a search found, each with its path, which tells folders of the same name apart. */
function FolderResults({ options, onPick }: FolderResultsProps) {
  return (
    <ul className="flex max-h-56 flex-col overflow-y-auto rounded-lg bg-surface p-1">
      {options.length ? (
        options.map((option) => (
          <li key={String(option.value)}>
            <button
              type="button"
              onClick={() => onPick(option)}
              className="flex w-full cursor-pointer flex-col rounded-md px-2.5 py-1.5 text-left hover:bg-paper-hi"
            >
              <span className="text-sm break-words">{option.label}</span>
              <span className="text-xs break-words text-muted">
                {option.detail ?? DRIVE_PATH_UNAVAILABLE}
              </span>
            </button>
          </li>
        ))
      ) : (
        <li className="px-2.5 py-1.5 text-sm text-muted">Nothing found.</li>
      )}
    </ul>
  );
}
