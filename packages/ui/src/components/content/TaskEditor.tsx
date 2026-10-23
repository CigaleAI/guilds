import { Columns3, FileText, Table2 } from "lucide-react";
import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type MouseEvent,
  type SyntheticEvent,
} from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";
import { Pill } from "../../primitives/Pill";
import { tag } from "../../primitives/Tag";
import { Button } from "../actions/Button";
import type { EmbedKind } from "./embeds";
import { Markdown } from "./Markdown";
import { Segmented } from "../controls/Segmented";

export type TaskEditorMode = "edit" | "preview";

/** What the Insert bar offers: a note or a table to link, or a table's column to name. */
export type InsertKind = EmbedKind | "column";

export type TaskEditorProps = Omit<ComponentProps<"div">, "onChange"> & {
  value: string;
  onChange: (value: string) => void;
  /** The live Task. The editor is dirty while `value` differs from it. */
  savedValue: string;
  /** Saves `value` as the new Task; the previous one is kept as a revision. */
  onSave: () => void;
  /** Reverts `value` to `savedValue`. */
  onDiscard: () => void;
  /** Version of the live Task, shown as "v8". */
  revision?: number;
  /** Tokens in the Task; without it the footer counts characters. */
  tokenCount?: number;
  saving?: boolean;
  /**
   * Opens the picker for a note, a table or a column. Resolves to the text inserted at the cursor,
   * such as `![[path]]`, or to nothing when the operator cancels. Without it, Insert is hidden.
   */
  onPickInsert?: (
    kind: InsertKind,
  ) => Promise<string | null | undefined> | string | null | undefined;
  /** Opens an embedded or referenced note or table from the preview. */
  onOpenEmbed?: (path: string) => void;
  /** Marks embeds that are not reachable. */
  isBrokenEmbed?: (path: string) => boolean;
  placeholder?: string;
  /** The view the editor opens in. Double-clicking the preview switches to Edit. */
  defaultMode?: TaskEditorMode;
  /**
   * Identity of the text being shown. When it changes the editor returns to `defaultMode`, so a
   * newly opened note opens in Preview even if the last one was in Edit.
   */
  sourceKey?: string;
  /** What is edited, naming the text box and the view switch: "Task", "Note". */
  label?: string;
  /** Shown in Preview when there is no text. */
  emptyText?: string;
};

const insertChip = cn(
  tag({ tone: "signal", font: "sans" }),
  "cursor-pointer transition-opacity hover:opacity-80 disabled:cursor-default disabled:opacity-50",
);

const numberFormat = new Intl.NumberFormat("en-US");

/** The 0-based line of a caret offset in the text. */
function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length - 1;
}

/** Scrolls the editor just enough to show a line; the textarea grows with its text, so its own scroll never moves. */
function revealLine(textarea: HTMLTextAreaElement, line: number) {
  textarea.parentElement?.children[line]?.scrollIntoView({ block: "nearest" });
}

const insertChoices: { kind: InsertKind; label: string; icon: typeof FileText }[] = [
  { kind: "note", label: "Note", icon: FileText },
  { kind: "table", label: "Table", icon: Table2 },
  { kind: "column", label: "Column", icon: Columns3 },
];

/**
 * Markdown an operator writes and agents read: an agent's Task, the only part of the system prompt
 * an operator writes, or a note. Notes and tables are embedded with `![[path]]` and expanded when
 * a run reads the text; a note referenced with `[[path]]` is read by the agent when it needs it.
 */
export function TaskEditor({
  value,
  onChange,
  savedValue,
  onSave,
  onDiscard,
  revision,
  tokenCount,
  saving = false,
  onPickInsert,
  onOpenEmbed,
  isBrokenEmbed,
  placeholder = "Describe this agent's standing purpose…",
  defaultMode = "edit",
  sourceKey,
  label = "Task",
  emptyText = "The Task is empty.",
  className,
  onKeyDown,
  ...props
}: TaskEditorProps) {
  const [mode, setMode] = useState<TaskEditorMode>(defaultMode);
  const [modeKey, setModeKey] = useState(sourceKey);
  if (sourceKey !== undefined && sourceKey !== modeKey) {
    setModeKey(sourceKey);
    setMode(defaultMode);
  }
  const [focused, setFocused] = useState(false);
  const [caretLine, setCaretLine] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const selection = useRef<{ start: number; end: number } | null>(null);
  const latestValue = useRef(value);
  const pendingCaret = useRef<number | null>(null);
  const pendingFocus = useRef(false);

  const dirty = value !== savedValue;
  const lines = value.split("\n");

  useLayoutEffect(() => {
    latestValue.current = value;
    const caret = pendingCaret.current;
    const textarea = textareaRef.current;
    if (caret === null || !textarea) return;
    pendingCaret.current = null;
    // Writing the value moved the caret to the end; focusing first would scroll there.
    textarea.setSelectionRange(caret, caret);
    textarea.focus({ preventScroll: true });
    revealLine(textarea, lineAt(value, caret));
  }, [value]);

  useLayoutEffect(() => {
    if (mode !== "edit" || !pendingFocus.current) return;
    pendingFocus.current = false;
    textareaRef.current?.focus();
  }, [mode]);

  function editFromPreview(event: MouseEvent<HTMLDivElement>) {
    if (event.target instanceof Element && event.target.closest("a, button")) return;
    pendingFocus.current = true;
    setMode("edit");
  }

  function track(event: SyntheticEvent<HTMLTextAreaElement>) {
    const { selectionStart, selectionEnd, value: text } = event.currentTarget;
    selection.current = { start: selectionStart, end: selectionEnd };
    setCaretLine(lineAt(text, selectionStart));
  }

  async function insert(kind: InsertKind) {
    if (!onPickInsert) return;
    const range = selection.current;
    const markup = await onPickInsert(kind);
    if (!markup) return;
    const current = latestValue.current;
    const start = Math.min(range?.start ?? current.length, current.length);
    const end = Math.min(range?.end ?? current.length, current.length);
    const next = current.slice(0, start) + markup + current.slice(end);
    pendingCaret.current = start + markup.length;
    selection.current = { start: pendingCaret.current, end: pendingCaret.current };
    setCaretLine(lineAt(next, pendingCaret.current));
    onChange(next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(event);
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (dirty && !saving) onSave();
    }
  }

  const count =
    tokenCount !== undefined
      ? `${numberFormat.format(tokenCount)} tokens`
      : `${numberFormat.format(value.length)} characters`;

  return (
    <div
      className={cn("flex min-h-0 flex-col overflow-hidden rounded-lg bg-paper text-fg", className)}
      onKeyDown={handleKeyDown}
      {...props}
    >
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
        {onPickInsert ? (
          <>
            <span className="mr-1 text-xs text-muted">Insert</span>
            {insertChoices.map((choice) => (
              <button
                key={choice.kind}
                type="button"
                className={insertChip}
                disabled={mode !== "edit"}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void insert(choice.kind)}
              >
                <Icon icon={choice.icon} size={14} />
                {choice.label}
              </button>
            ))}
          </>
        ) : null}
        <span className="flex-1" />
        <Segmented
          label={`${label} view`}
          value={mode}
          onValueChange={setMode}
          options={[
            { value: "edit", label: "Edit" },
            { value: "preview", label: "Preview" },
          ]}
        />
      </div>

      <div
        className={cn(
          "relative flex min-h-0 flex-1 flex-col",
          mode === "edit" &&
            "after:pointer-events-none after:absolute after:inset-0 focus-within:after:inset-ring-2 focus-within:after:inset-ring-focus",
        )}
      >
        <div
          className="flex min-h-40 flex-1 flex-col overflow-auto"
          {...(mode === "preview" ? { onDoubleClick: editFromPreview } : {})}
        >
          {mode === "edit" ? (
            <div className="relative flex-1 py-2.5 font-mono text-sm leading-5.5">
              {lines.map((line, index) => {
                const current = focused && index === caretLine;
                return (
                  <div key={index} aria-hidden className="flex">
                    <span
                      className={cn(
                        "w-10 shrink-0 pr-3 text-right select-none",
                        current ? "text-fg" : "text-muted",
                      )}
                    >
                      {index + 1}
                    </span>
                    <span
                      className={cn(
                        "min-w-0 flex-1 pr-3 whitespace-pre-wrap text-transparent wrap-anywhere",
                        current && "bg-t-sig",
                      )}
                    >
                      {line || " "}
                    </span>
                  </div>
                );
              })}
              <textarea
                ref={textareaRef}
                value={value}
                placeholder={placeholder}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                aria-label={label}
                onChange={(event) => {
                  track(event);
                  onChange(event.currentTarget.value);
                }}
                onSelect={track}
                onFocus={(event) => {
                  setFocused(true);
                  track(event);
                }}
                onBlur={() => setFocused(false)}
                className="absolute top-2.5 right-0 bottom-2.5 left-10 resize-none overflow-hidden bg-transparent pr-3 font-mono text-sm leading-5.5 whitespace-pre-wrap text-fg wrap-anywhere caret-fg outline-none placeholder:text-muted focus-visible:outline-none"
              />
            </div>
          ) : value.trim() ? (
            <Markdown
              className="px-4 py-3"
              {...(onOpenEmbed ? { onOpenEmbed } : {})}
              {...(isBrokenEmbed ? { isBrokenEmbed } : {})}
            >
              {value}
            </Markdown>
          ) : (
            <p className="px-4 py-3 text-sm text-muted">{emptyText}</p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 bg-surface px-3 py-2">
        <span className="font-mono text-2xs whitespace-nowrap text-muted">
          {count}
          {revision !== undefined ? ` · v${revision}` : null}
        </span>
        {dirty ? (
          <Pill size="xs" fill="ochre-tint" className="h-5.5 font-bold">
            Unsaved changes
          </Pill>
        ) : null}
        <span className="flex-1" />
        {dirty ? (
          <Button variant="ghost" size="sm" disabled={saving} onClick={onDiscard}>
            Discard
          </Button>
        ) : null}
        <Button size="sm" disabled={!dirty || saving} onClick={onSave}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
