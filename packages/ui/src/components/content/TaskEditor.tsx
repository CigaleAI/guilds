import { FileText, Table2 } from "lucide-react";
import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type SyntheticEvent,
} from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";
import { Pill } from "../../primitives/Pill";
import { tag } from "../../primitives/Tag";
import { Button } from "../actions/Button";
import { embedMarkup, type EmbedKind } from "./embeds";
import { Markdown } from "./Markdown";
import { Segmented } from "../controls/Segmented";

export type TaskEditorMode = "edit" | "preview";

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
   * Opens the note or table picker. Resolves to the chosen display path, which is inserted at the
   * cursor as `![[path]]`, or to nothing when the operator cancels. Without it, Insert is hidden.
   */
  onPickEmbed?: (kind: EmbedKind) => Promise<string | null | undefined> | string | null | undefined;
  /** Opens an embedded note or table from the preview. */
  onOpenEmbed?: (path: string) => void;
  /** Marks embeds whose path no longer resolves. */
  isBrokenEmbed?: (path: string) => boolean;
  placeholder?: string;
  defaultMode?: TaskEditorMode;
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

/**
 * Markdown an operator writes and agents read: an agent's Task, the only part of the system prompt
 * an operator writes, or a note. Notes and tables are embedded with `![[path]]` and expanded when
 * a run reads the text.
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
  onPickEmbed,
  onOpenEmbed,
  isBrokenEmbed,
  placeholder = "Describe this agent's standing purpose…",
  defaultMode = "edit",
  label = "Task",
  emptyText = "The Task is empty.",
  className,
  onKeyDown,
  ...props
}: TaskEditorProps) {
  const [mode, setMode] = useState<TaskEditorMode>(defaultMode);
  const [focused, setFocused] = useState(false);
  const [caretLine, setCaretLine] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const selection = useRef<{ start: number; end: number } | null>(null);
  const latestValue = useRef(value);
  const pendingCaret = useRef<number | null>(null);

  const dirty = value !== savedValue;
  const lines = value.split("\n");

  useLayoutEffect(() => {
    latestValue.current = value;
    const caret = pendingCaret.current;
    const textarea = textareaRef.current;
    if (caret === null || !textarea) return;
    pendingCaret.current = null;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
  }, [value]);

  function track(event: SyntheticEvent<HTMLTextAreaElement>) {
    const { selectionStart, selectionEnd, value: text } = event.currentTarget;
    selection.current = { start: selectionStart, end: selectionEnd };
    setCaretLine(text.slice(0, selectionStart).split("\n").length - 1);
  }

  async function insert(kind: EmbedKind) {
    if (!onPickEmbed) return;
    const range = selection.current;
    const path = await onPickEmbed(kind);
    if (!path) return;
    const current = latestValue.current;
    const start = Math.min(range?.start ?? current.length, current.length);
    const end = Math.min(range?.end ?? current.length, current.length);
    const markup = embedMarkup(path);
    pendingCaret.current = start + markup.length;
    selection.current = { start: pendingCaret.current, end: pendingCaret.current };
    onChange(current.slice(0, start) + markup + current.slice(end));
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
        {onPickEmbed ? (
          <>
            <span className="mr-1 text-xs text-muted">Insert</span>
            <button
              type="button"
              className={insertChip}
              disabled={mode !== "edit"}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void insert("note")}
            >
              <Icon icon={FileText} size={14} />
              Note
            </button>
            <button
              type="button"
              className={insertChip}
              disabled={mode !== "edit"}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void insert("table")}
            >
              <Icon icon={Table2} size={14} />
              Table
            </button>
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
        <div className="flex min-h-40 flex-1 flex-col overflow-auto">
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
