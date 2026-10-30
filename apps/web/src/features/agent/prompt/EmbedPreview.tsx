import { useEmbeddableNote } from "../../../api/queries/notes";
import type { EmbeddableNote } from "../../../api/types/notes";
import type { Collection } from "../../../api/types/tables";
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
import { collectionDisplayPath } from "./taskContext";

type EmbedPreviewProps = {
  /** The embed to show; null keeps the dialog closed. */
  path: string | null;
  notes: readonly EmbeddableNote[] | undefined;
  collections: readonly Collection[] | undefined;
  orgId: string;
  onClose: () => void;
};

type TablePreviewProps = { collection: Collection | undefined };

/** A table embed: the purpose of the table it names, or that the agent cannot reach it. */
function TablePreview({ collection }: TablePreviewProps) {
  if (!collection) {
    return (
      <Banner tone="error" title="This table is not reachable">
        Runs get a line saying the file is not reachable in its place.
      </Banner>
    );
  }
  return <p className="text-md text-fg-2">{collection.purpose || "No purpose written."}</p>;
}

type NotePreviewProps = {
  path: string | null;
  /** The notes the operator can see; a note not among them is fetched by its path. */
  notes: readonly EmbeddableNote[] | undefined;
};

/** A note embed: its text, that it is empty, or that it is not reachable. */
function NotePreview({ path, notes }: NotePreviewProps) {
  const listed = path ? notes?.find((note) => note.display_path === path) : undefined;
  const fetched = useEmbeddableNote(path, notes !== undefined && !listed);
  const note = listed ?? fetched.data;
  if (note) {
    return note.content.trim() ? (
      <Markdown density="compact">{note.content}</Markdown>
    ) : (
      <p className="text-sm text-muted">This note is empty.</p>
    );
  }
  if (fetched.isError) {
    return (
      <Banner tone="error" title="This note is not reachable">
        Runs get a line saying the file is not reachable in its place.
      </Banner>
    );
  }
  return <SkeletonRows rows={4} label="Loading the note" />;
}

/** What an embed pulls into the prompt: a note's text, or the table it names. */
export function EmbedPreview({ path, notes, collections, orgId, onClose }: EmbedPreviewProps) {
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
            <TablePreview collection={collection} />
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
