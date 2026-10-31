import { Columns3, FileText, Info, Table2, type LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { EmbeddableNote } from "../../api/types/notes";
import type { Collection } from "../../api/types/tables";
import {
  Button,
  Markdown,
  SearchField,
  ListGroupLabel,
  EmptyState,
  Segmented,
  SkeletonRows,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  Row,
  Tooltip,
  cn,
} from "@guildsrun/ui";
import type { EmbedMode, InsertKind } from "@guildsrun/ui";
import { collectionDisplayPath, insertMarkup, type NoteGroup } from "./embeds";

type InsertPickerProps = {
  /** What to pick; null keeps the dialog closed. */
  kind: InsertKind | null;
  noteGroups: NoteGroup[] | undefined;
  collections: readonly Collection[] | undefined;
  orgId: string;
  /** The text to insert, or null when the operator cancels. */
  onPick: (markup: string | null) => void;
};

type Choice = {
  path: string;
  title: string;
  meta: string;
  note?: EmbeddableNote;
  collection?: Collection;
};

type ChoiceGroup = { label: string; choices: Choice[] };

type PickerCopy = {
  title: string;
  /** Under the title; a note's says what its embed or reference mode does instead. */
  description?: string;
  search: string;
  icon: LucideIcon;
  emptyTitle: string;
  emptyDescription: string;
  prompt: string;
};

const tableCopy = {
  search: "Search tables",
  icon: Table2,
  emptyTitle: "No tables yet",
  emptyDescription: "Tables are created on the Tables page.",
};

const copyByKind: Record<InsertKind, PickerCopy> = {
  note: {
    title: "Insert a note",
    search: "Search notes",
    icon: FileText,
    emptyTitle: "No notes to insert",
    emptyDescription: "Notes of this agent, its guild and the organisation appear here.",
    prompt: "Select a note to preview it.",
  },
  table: {
    ...tableCopy,
    title: "Insert a table",
    description: "The table's name is added to the prompt when a run starts.",
    prompt: "Select a table to preview it.",
  },
  column: {
    ...tableCopy,
    title: "Insert a column",
    description:
      "The column's name is added with its table's, as table.column, so the agent knows which table it means.",
    prompt: "Select a table to list its columns.",
  },
};

const modeDescription: Record<EmbedMode, string> = {
  embed: "The note's text is added to the prompt when a run starts.",
  reference: "Only a link to the note is added; the agent reads the note when it needs it.",
};

function matches(choice: Choice, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || `${choice.title} ${choice.meta}`.toLowerCase().includes(needle);
}

function tableGroups(collections: readonly Collection[], orgId: string): ChoiceGroup[] {
  const choices = collections.map((collection) => ({
    path: collectionDisplayPath(orgId, collection),
    title: collection.name,
    meta: collection.purpose,
    collection,
  }));
  return [{ label: "Tables", choices }];
}

function noteChoiceGroups(noteGroups: readonly NoteGroup[]): ChoiceGroup[] {
  return noteGroups.map((group) => ({
    label: group.label,
    choices: group.notes.map((note) => ({
      path: note.display_path,
      title: note.key,
      meta: note.title ?? "",
      note,
    })),
  }));
}

/** The choices for a kind that match the query; undefined while they load. */
function choiceGroups(
  kind: InsertKind | null,
  sources: Pick<InsertPickerProps, "noteGroups" | "collections" | "orgId">,
  query: string,
): ChoiceGroup[] | undefined {
  const listed =
    kind === "note"
      ? sources.noteGroups && noteChoiceGroups(sources.noteGroups)
      : sources.collections && tableGroups(sources.collections, sources.orgId);
  return listed
    ?.map((group) => ({ ...group, choices: group.choices.filter((item) => matches(item, query)) }))
    .filter((group) => group.choices.length > 0);
}

/** The choice at the selected path among the groups shown; undefined when none is selected or shown. */
function selectedChoice(
  groups: readonly ChoiceGroup[] | undefined,
  selected: string | null,
): Choice | undefined {
  return groups?.flatMap((group) => group.choices).find((choice) => choice.path === selected);
}

/**
 * Picks what to insert in a Task or note: a note, embedded as `![[path]]` or referenced as
 * `[[path]]`; a table, embedded; or one of a table's columns, named as `table.column`.
 */
export function InsertPicker({ kind, noteGroups, collections, orgId, onPick }: InsertPickerProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [column, setColumn] = useState<string | null>(null);
  const [mode, setMode] = useState<EmbedMode>("embed");

  const groups = useMemo(
    () => choiceGroups(kind, { noteGroups, collections, orgId }, query),
    [kind, noteGroups, collections, orgId, query],
  );
  const chosen = selectedChoice(groups, selected);
  const copy = copyByKind[kind ?? "note"];
  const markup =
    kind && chosen
      ? insertMarkup(kind, { path: chosen.path, table: chosen.title, column, mode })
      : null;

  const close = (text: string | null) => {
    setQuery("");
    setSelected(null);
    setColumn(null);
    onPick(text);
  };
  const select = (path: string) => {
    setSelected(path);
    setColumn(null);
  };
  const pickDirectly = (choice: Choice) => {
    if (kind && kind !== "column")
      close(insertMarkup(kind, { path: choice.path, table: choice.title, column: null, mode }));
  };

  return (
    <Dialog open={kind !== null} onOpenChange={(open) => !open && close(null)}>
      <DialogContent size="lg">
        <DialogHeader
          title={copy.title}
          description={kind === "note" ? modeDescription[mode] : (copy.description ?? "")}
        />
        <DialogBody className="gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <SearchField
              className="min-w-48 flex-1"
              value={query}
              onValueChange={setQuery}
              label={copy.search}
              placeholder={`${copy.search}…`}
              tone="surface"
            />
            {kind === "note" ? <ModeSwitch mode={mode} onModeChange={setMode} /> : null}
          </div>
          <div className="grid min-h-72 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-1">
              <ChoiceList
                groups={groups}
                copy={copy}
                query={query}
                showLabels={kind === "note"}
                selected={selected}
                onSelect={select}
                onPick={pickDirectly}
              />
            </div>
            <div
              className={cn(
                "max-h-96 min-w-0 overflow-y-auto rounded-lg bg-surface p-4",
                kind === "column" ? "block" : "hidden md:block",
              )}
            >
              {chosen && kind === "column" ? (
                <ColumnList
                  collection={chosen.collection}
                  selected={column}
                  onSelect={setColumn}
                  onPick={(name) =>
                    close(
                      insertMarkup("column", {
                        path: chosen.path,
                        table: chosen.title,
                        column: name,
                        mode,
                      }),
                    )
                  }
                />
              ) : chosen ? (
                <ChoicePreview choice={chosen} />
              ) : (
                <p className="text-sm text-muted">{copy.prompt}</p>
              )}
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button disabled={!markup} onClick={() => markup && close(markup)}>
            Insert
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type ModeSwitchProps = {
  mode: EmbedMode;
  onModeChange: (mode: EmbedMode) => void;
};

/** Embed or reference, with what each one does on hover. */
function ModeSwitch({ mode, onModeChange }: ModeSwitchProps) {
  return (
    <div className="flex items-center gap-1.5">
      <Segmented
        label="Add the note as"
        value={mode}
        onValueChange={onModeChange}
        options={[
          { value: "embed", label: "Embed" },
          { value: "reference", label: "Reference" },
        ]}
      />
      <Tooltip
        side="bottom"
        align="end"
        label={
          <span className="flex flex-col gap-1.5">
            <span>
              <b>Embed</b> copies the note's text into the prompt on every run. Use it for short
              instructions the agent always needs; it counts against the embed budget.
            </span>
            <span>
              <b>Reference</b> adds only a link. The agent reads the note with note_get when it
              needs it. Use it for long or occasional material.
            </span>
          </span>
        }
      >
        <button
          type="button"
          aria-label="Embed or reference?"
          className="inline-flex size-7 items-center justify-center rounded-sm text-muted hover:bg-well hover:text-fg"
        >
          <Icon icon={Info} size={14} />
        </button>
      </Tooltip>
    </div>
  );
}

type ChoiceListProps = {
  groups: ChoiceGroup[] | undefined;
  copy: PickerCopy;
  query: string;
  showLabels: boolean;
  selected: string | null;
  onSelect: (path: string) => void;
  onPick: (choice: Choice) => void;
};

function ChoiceList({
  groups,
  copy,
  query,
  showLabels,
  selected,
  onSelect,
  onPick,
}: ChoiceListProps) {
  if (!groups) return <SkeletonRows rows={4} label="Loading" />;
  if (groups.length === 0) {
    return (
      <EmptyState
        icon={copy.icon}
        title={query ? "Nothing matches" : copy.emptyTitle}
        description={query ? "Try another name." : copy.emptyDescription}
      />
    );
  }
  return (
    <>
      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-0.5">
          {showLabels ? (
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
              lead={<Icon icon={copy.icon} size={14} />}
              title={choice.title}
              {...(choice.meta ? { meta: choice.meta } : {})}
            >
              <button
                type="button"
                aria-pressed={choice.path === selected}
                onClick={() => onSelect(choice.path)}
                onDoubleClick={() => onPick(choice)}
              />
            </Row>
          ))}
        </div>
      ))}
    </>
  );
}

type ChoicePreviewProps = { choice: Choice };

/** A chosen note's text, or a chosen table's purpose and columns. */
function ChoicePreview({ choice }: ChoicePreviewProps) {
  if (choice.note) {
    return choice.note.content.trim() ? (
      <Markdown density="compact">{choice.note.content}</Markdown>
    ) : (
      <p className="text-sm text-muted">This note is empty.</p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span className="font-mono text-sm font-medium">{choice.title}</span>
        <span className="text-sm text-fg-2">{choice.meta || "No purpose written."}</span>
      </div>
      {choice.collection?.columns.map((item) => (
        <div key={item.name} className="flex flex-col gap-0.5">
          <span className="font-mono text-xs font-medium">
            {item.name} <span className="text-muted">· {item.type}</span>
          </span>
          <span className="text-xs whitespace-pre-line text-fg-2">{item.description}</span>
        </div>
      ))}
    </div>
  );
}

type ColumnListProps = {
  collection: Collection | undefined;
  selected: string | null;
  onSelect: (name: string) => void;
  onPick: (name: string) => void;
};

/** A table's columns to pick one from, each with its type and description. */
function ColumnList({ collection, selected, onSelect, onPick }: ColumnListProps) {
  if (!collection?.columns.length) {
    return <p className="text-sm text-muted">This table has no columns.</p>;
  }
  return (
    <div className="flex flex-col gap-0.5">
      <ListGroupLabel className="px-2.5 pb-1">Columns of {collection.name}</ListGroupLabel>
      {collection.columns.map((item) => (
        <Row
          key={item.name}
          asChild
          density="compact"
          interactive
          mono
          selected={item.name === selected}
          lead={<Icon icon={Columns3} size={14} />}
          title={item.name}
          meta={`${item.type} · ${item.description}`}
        >
          <button
            type="button"
            aria-pressed={item.name === selected}
            onClick={() => onSelect(item.name)}
            onDoubleClick={() => onPick(item.name)}
          />
        </Row>
      ))}
    </div>
  );
}
