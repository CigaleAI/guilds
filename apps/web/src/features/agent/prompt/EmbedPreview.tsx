import { useEmbeddableNote } from "../../../api/queries";
import type { Collection, EmbeddableNote } from "../../../api/types";
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

/** What an embed pulls into the prompt: a note's text, or the table it names. */
export function EmbedPreview({ path, notes, collections, orgId, onClose }: EmbedPreviewProps) {
  const table = path !== null && embedKind(path) === "table";
  const listed = path ? notes?.find((note) => note.display_path === path) : undefined;
  const fetched = useEmbeddableNote(path, !table && notes !== undefined && !listed);
  const note = listed ?? fetched.data;
  const collection = table
    ? collections?.find((item) => collectionDisplayPath(orgId, item) === path)
    : undefined;

  return (
    <Dialog open={path !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg">
        <DialogHeader title={path ? embedLabel(path) : ""} description={path} />
        <DialogBody>
          {table ? (
            collection ? (
              <p className="text-md text-fg-2">{collection.purpose || "No purpose written."}</p>
            ) : (
              <Banner tone="error" title="This table is not reachable">
                Runs get a line saying the file is not reachable in its place.
              </Banner>
            )
          ) : note ? (
            note.content.trim() ? (
              <Markdown density="compact">{note.content}</Markdown>
            ) : (
              <p className="text-sm text-muted">This note is empty.</p>
            )
          ) : fetched.isError ? (
            <Banner tone="error" title="This note is not reachable">
              Runs get a line saying the file is not reachable in its place.
            </Banner>
          ) : (
            <SkeletonRows rows={4} label="Loading the note" />
          )}
        </DialogBody>
        <DialogFooter>
          {table && collection ? (
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
