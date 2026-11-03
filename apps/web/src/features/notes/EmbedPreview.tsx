import { useEmbeddableNote } from "../../api/queries/notes";
import type { EmbeddableNotes } from "../../api/types/notes";
import type { Collection } from "../../api/types/tables";
import { Link } from "@tanstack/react-router";
import {
  Button,
  Markdown,
  embedKind,
  embedLabel,
  Banner,
  SkeletonRows,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "@guildsrun/ui";
import { collectionDisplayPath, noteEmbed } from "./embeds";

type EmbedPreviewProps = {
  /** The embed to show; null keeps the dialog closed. */
  path: string | null;
  /** The notes the Task or note can embed; undefined while they load. */
  notes: EmbeddableNotes | undefined;
  /** Why the notes did not load; null while they load or once they have. */
  notesError: Error | null;
  /** The tables the Task or note can embed; undefined while they load. */
  collections: readonly Collection[] | undefined;
  /** Why the tables did not load; null while they load or once they have. */
  collectionsError: Error | null;
  orgId: string;
  onClose: () => void;
};

type TablePreviewProps = {
  /** The tables the Task or note can embed; undefined while they load. */
  collections: readonly Collection[] | undefined;
  /** Why the tables did not load; null while they load or once they have. */
  collectionsError: Error | null;
  /** The table the embed names, among `collections`. */
  collection: Collection | undefined;
};

/**
 * A table embed: the purpose of the table it names, that the agent cannot reach it, or the tables
 * loading or failing to load.
 */
function TablePreview({ collections, collectionsError, collection }: TablePreviewProps) {
  if (collection) {
    return <p className="text-md text-fg-2">{collection.purpose || "No purpose written."}</p>;
  }
  if (collections) {
    return (
      <Banner tone="error" title="This table is not reachable">
        Runs get a line saying the file is not reachable in its place.
      </Banner>
    );
  }
  if (collectionsError) {
    return <Banner tone="error" title="Couldn't load the tables" meta={collectionsError.message} />;
  }
  return <SkeletonRows rows={2} label="Loading the table" />;
}

type NotePreviewProps = {
  path: string | null;
  /** The notes the Task or note can embed; a note they cannot tell of is fetched by its path. */
  notes: EmbeddableNotes | undefined;
};

/** A note embed: its text, that it is empty, or that it is not reachable. */
function NotePreview({ path, notes }: NotePreviewProps) {
  const embed = path && notes ? noteEmbed(path, notes) : undefined;
  const fetched = useEmbeddableNote(path, embed?.state === "unknown");
  const note = embed?.state === "readable" ? embed.note : fetched.data;
  if (note) {
    return note.content.trim() ? (
      <Markdown density="compact">{note.content}</Markdown>
    ) : (
      <p className="text-sm text-muted">This note is empty.</p>
    );
  }
  if (embed?.state === "unreadable" || fetched.isError) {
    return (
      <Banner tone="error" title="This note is not reachable">
        Runs get a line saying the file is not reachable in its place.
      </Banner>
    );
  }
  return <SkeletonRows rows={4} label="Loading the note" />;
}

/** What an embed pulls into the prompt: a note's text, or the table it names. */
export function EmbedPreview({
  path,
  notes,
  notesError,
  collections,
  collectionsError,
  orgId,
  onClose,
}: EmbedPreviewProps) {
  const table = path !== null && embedKind(path) === "table";
  const collection = table
    ? collections?.find((item) => collectionDisplayPath(orgId, item) === path)
    : undefined;

  return (
    <Dialog open={path !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg">
        <DialogHeader title={path ? embedLabel(path) : ""} description={path} />
        <DialogBody>
          {table ? (
            <TablePreview
              collections={collections}
              collectionsError={collectionsError}
              collection={collection}
            />
          ) : !notes && notesError ? (
            <Banner tone="error" title="Couldn't load the notes" meta={notesError.message} />
          ) : (
            <NotePreview path={path} notes={notes} />
          )}
        </DialogBody>
        <DialogFooter>
          {collection ? (
            <Button asChild variant="outline" className="mr-auto">
              <Link to="/tables/$collectionId" params={{ collectionId: collection.id }}>
                Open the table
              </Link>
            </Button>
          ) : null}
          <DialogClose asChild>
            <Button>Done</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
