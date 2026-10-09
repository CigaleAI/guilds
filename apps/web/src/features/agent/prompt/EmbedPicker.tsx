import { FileText, Table2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { Collection, EmbeddableNote } from "../../../api/types";
import {
  Button,
  Markdown,
  SearchField,
  ListGroupLabel,
  EmptyState,
  SkeletonRows,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  Row,
} from "@guildsrun/ui";
import type { EmbedKind } from "@guildsrun/ui";
import { collectionDisplayPath, type NoteGroup } from "./taskContext";

type EmbedPickerProps = {
  /** What to pick; null keeps the dialog closed. */
  kind: EmbedKind | null;
  noteGroups: NoteGroup[] | undefined;
  collections: readonly Collection[] | undefined;
  orgId: string;
  /** The chosen display path, or null when the operator cancels. */
  onPick: (path: string | null) => void;
};

type Choice = { path: string; title: string; meta: string; note?: EmbeddableNote };

function matches(choice: Choice, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || `${choice.title} ${choice.meta}`.toLowerCase().includes(needle);
}

/** Picks a note or a table to embed in the Task as `![[display-path]]`. */
export function EmbedPicker({ kind, noteGroups, collections, orgId, onPick }: EmbedPickerProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const groups = useMemo(() => {
    const listed: { label: string; choices: Choice[] }[] =
      kind === "table"
        ? [
            {
              label: "Tables",
              choices: (collections ?? []).map((collection) => ({
                path: collectionDisplayPath(orgId, collection),
                title: collection.name,
                meta: collection.purpose,
              })),
            },
          ]
        : (noteGroups ?? []).map((group) => ({
            label: group.label,
            choices: group.notes.map((note) => ({
              path: note.display_path,
              title: note.key,
              meta: note.title ?? "",
              note,
            })),
          }));
    return listed
      .map((group) => ({
        ...group,
        choices: group.choices.filter((choice) => matches(choice, query)),
      }))
      .filter((group) => group.choices.length > 0);
  }, [kind, collections, noteGroups, orgId, query]);

  const loading = kind === "table" ? !collections : !noteGroups;
  const chosen = groups
    .flatMap((group) => group.choices)
    .find((choice) => choice.path === selected);

  const close = (path: string | null) => {
    setQuery("");
    setSelected(null);
    onPick(path);
  };

  return (
    <Dialog open={kind !== null} onOpenChange={(open) => !open && close(null)}>
      <DialogContent size="lg">
        <DialogHeader
          title={kind === "table" ? "Insert a table" : "Insert a note"}
          description={
            kind === "table"
              ? "The table's name is added to the prompt when a run starts."
              : "The note's text is added to the prompt when a run starts."
          }
        />
        <DialogBody className="gap-3">
          <SearchField
            value={query}
            onValueChange={setQuery}
            label={kind === "table" ? "Search tables" : "Search notes"}
            placeholder={kind === "table" ? "Search tables…" : "Search notes…"}
            tone="surface"
          />
          <div className="grid min-h-72 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-1">
              {loading ? (
                <SkeletonRows rows={4} label="Loading" />
              ) : groups.length === 0 ? (
                <EmptyState
                  icon={kind === "table" ? Table2 : FileText}
                  title={
                    query
                      ? "Nothing matches"
                      : kind === "table"
                        ? "No tables yet"
                        : "No notes to insert"
                  }
                  description={
                    query
                      ? "Try another name."
                      : kind === "table"
                        ? "Tables are created on the Databases page."
                        : "Notes of this agent, its guild and the organisation appear here."
                  }
                />
              ) : (
                groups.map((group) => (
                  <div key={group.label} className="flex flex-col gap-0.5">
                    {kind === "note" ? (
                      <ListGroupLabel className="px-2.5 pt-2">{group.label}</ListGroupLabel>
                    ) : null}
                    {group.choices.map((choice) => (
                      <Row
                        key={choice.path}
                        asChild
                        density="compact"
                        interactive
                        mono
                        selected={choice.path === selected}
                        lead={<Icon icon={kind === "table" ? Table2 : FileText} size={14} />}
                        title={choice.title}
                        {...(choice.meta ? { meta: choice.meta } : {})}
                      >
                        <button
                          type="button"
                          aria-pressed={choice.path === selected}
                          onClick={() => setSelected(choice.path)}
                          onDoubleClick={() => close(choice.path)}
                        />
                      </Row>
                    ))}
                  </div>
                ))
              )}
            </div>
            <div className="hidden max-h-96 min-w-0 overflow-y-auto rounded-lg bg-surface p-4 md:block">
              {chosen?.note ? (
                chosen.note.content.trim() ? (
                  <Markdown density="compact">{chosen.note.content}</Markdown>
                ) : (
                  <p className="text-sm text-muted">This note is empty.</p>
                )
              ) : chosen ? (
                <div className="flex flex-col gap-1">
                  <span className="font-mono text-sm font-medium">{chosen.title}</span>
                  <span className="text-sm text-fg-2">{chosen.meta || "No purpose written."}</span>
                </div>
              ) : (
                <p className="text-sm text-muted">
                  Select a {kind === "table" ? "table" : "note"} to preview it.
                </p>
              )}
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button disabled={!chosen} onClick={() => chosen && close(chosen.path)}>
            Insert
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
