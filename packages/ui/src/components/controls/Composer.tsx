import { ArrowUp, Paperclip, X } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "../../cn";
import type { IdentityTone } from "../../identity";
import { Icon } from "../../primitives/Icon";
import { Kbd } from "../../primitives/Kbd";
import { Button } from "../actions/Button";
import { IconButton } from "../actions/IconButton";
import { Avatar } from "../identity/Avatar";
import { Tooltip } from "../overlays/Tooltip";

/** Someone the message can tag with `@name`: an agent, a person, or `user` for every operator. */
export type MentionCandidate = {
  name: string;
  /** Shown as the candidate's avatar; people without one show initials on dusk. */
  tone?: IdentityTone;
  src?: string;
  /** What the name reaches, such as "every operator". */
  hint?: string;
};

type MentionQuery = { start: number; end: number; text: string };

/** The `@partial` right before the caret, if the caret is completing a tag. */
function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const match = /(?:^|[^A-Za-z0-9-])@([a-z0-9-]{0,62})$/.exec(text.slice(0, caret));
  if (!match) return null;
  const typed = match[1] ?? "";
  return { start: caret - typed.length - 1, end: caret, text: typed };
}

export type ComposerProps = Omit<ComponentProps<"form">, "onSubmit" | "children"> & {
  /** Accessible name of the message box, such as "Message managooor". */
  label: string;
  placeholder: string;
  /** Called with the trimmed message, and any attached image files, on Enter or Send. */
  onSend: (message: string, files?: File[]) => void;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** A run is generating: Send waits for it, and Cancel stops it when `onCancel` is given. */
  generating?: boolean;
  onCancel?: () => void;
  disabled?: boolean;
  /** `card`: message box over a hint row with Cancel and Send. `inline`: one row with a round send. */
  variant?: "card" | "inline";
  tone?: "paper" | "surface";
  /** Replaces the keyboard hint in a card, such as a note on where the message is sent. */
  footnote?: ReactNode;
  autoFocus?: boolean;
  name?: string;
  /** Typing `@` offers these names; arrows move, Enter or Tab picks, Escape dismisses. */
  mentions?: readonly MentionCandidate[];
  /**
   * Direct chat: a paperclip adds JPEG, PNG, GIF, or WebP files (at most 4, 10 MiB
   * each). Send may be an empty caption with images.
   */
  acceptAttachments?: boolean;
  /**
   * Why the paperclip is off. Direct chat always passes this when the model
   * refuses images, so the control stays visible and the tooltip explains.
   */
  attachmentsUnavailable?: string;
};

const tones = { paper: "bg-paper", surface: "bg-surface" } as const;

const ATTACHMENT_ACCEPT = "image/jpeg,image/png,image/gif,image/webp";
const ATTACHMENT_KINDS = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_COMPOSER_ATTACHMENTS = 4;
const MAX_COMPOSER_ATTACHMENT_BYTES = 10 * 1024 * 1024;

type PendingFile = { key: string; file: File; url: string };

function isAttachableImage(file: File): boolean {
  if (file.size <= 0 || file.size > MAX_COMPOSER_ATTACHMENT_BYTES) return false;
  if (!file.type || file.type === "application/octet-stream") return true;
  return ATTACHMENT_KINDS.has(file.type);
}

/**
 * Where an operator writes to an agent, the guild or the coach. Enter sends, Shift+Enter breaks
 * the line, and the box grows with its text.
 */
export function Composer({
  label,
  placeholder,
  onSend,
  value,
  defaultValue = "",
  onValueChange,
  generating = false,
  onCancel,
  disabled = false,
  variant = "card",
  tone = "surface",
  footnote,
  autoFocus,
  name,
  mentions,
  acceptAttachments = false,
  attachmentsUnavailable,
  className,
  ...props
}: ComposerProps) {
  const [inner, setInner] = useState(defaultValue);
  const text = value ?? inner;
  const box = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const pendingRef = useRef(pending);
  const canSend = !disabled && !generating && (text.trim().length > 0 || pending.length > 0);

  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  useEffect(() => {
    return () => {
      for (const item of pendingRef.current) URL.revokeObjectURL(item.url);
    };
  }, []);
  const listId = useId();
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [active, setActive] = useState(0);
  const suggestions =
    query && mentions
      ? mentions.filter((candidate) => candidate.name.startsWith(query.text)).slice(0, 6)
      : [];
  const suggesting = suggestions.length > 0;

  function trackCaret() {
    const el = box.current;
    if (!el || !mentions?.length) return;
    const next = mentionQueryAt(el.value, el.selectionStart ?? 0);
    setQuery((current) =>
      current?.start === next?.start && current?.text === next?.text ? current : next,
    );
    if (next?.text !== query?.text) setActive(0);
  }

  function pick(candidate: MentionCandidate) {
    if (!query) return;
    const inserted = `@${candidate.name} `;
    const next = text.slice(0, query.start) + inserted + text.slice(query.end);
    const caret = query.start + inserted.length;
    change(next);
    setQuery(null);
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(caret, caret);
    });
  }

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  function change(next: string) {
    if (value === undefined) setInner(next);
    onValueChange?.(next);
  }

  function addFiles(files: File[]) {
    if (!acceptAttachments || disabled || generating) return;
    const extras: PendingFile[] = [];
    for (const file of files) {
      if (!isAttachableImage(file)) continue;
      extras.push({ key: `${file.name}:${file.size}:${file.lastModified}:${extras.length}`, file, url: URL.createObjectURL(file) });
    }
    if (!extras.length) return;
    setPending((current) => {
      const room = Math.max(0, MAX_COMPOSER_ATTACHMENTS - current.length);
      const kept = extras.slice(0, room);
      for (const item of extras.slice(room)) URL.revokeObjectURL(item.url);
      return room ? [...current, ...kept] : current;
    });
  }

  function removeFile(key: string) {
    setPending((current) => {
      const next = current.filter((item) => item.key !== key);
      for (const item of current) {
        if (item.key === key) URL.revokeObjectURL(item.url);
      }
      return next;
    });
  }

  function send() {
    if (!canSend) return;
    const files = pending.map((item) => item.file);
    onSend(text.trim(), files.length ? files : undefined);
    change("");
    setPending((current) => {
      for (const item of current) URL.revokeObjectURL(item.url);
      return [];
    });
  }

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(event.currentTarget.files ?? []));
    event.currentTarget.value = "";
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!acceptAttachments) return;
    const images = Array.from(event.clipboardData.files).filter(isAttachableImage);
    if (!images.length) return;
    event.preventDefault();
    addFiles(images);
  }

  const showAttach = acceptAttachments || Boolean(attachmentsUnavailable);
  const attachHint = !acceptAttachments
    ? (attachmentsUnavailable ?? "This model does not accept images")
    : pending.length >= MAX_COMPOSER_ATTACHMENTS
      ? "At most four images per message"
      : "Attach a JPEG, PNG, GIF, or WebP image";
  const attachDisabled =
    !acceptAttachments || disabled || generating || pending.length >= MAX_COMPOSER_ATTACHMENTS;

  const fileField = acceptAttachments ? (
    <input
      ref={fileInput}
      type="file"
      accept={ATTACHMENT_ACCEPT}
      multiple
      className="hidden"
      onChange={onPick}
    />
  ) : null;

  const previews = pending.length ? (
    <ul className="flex flex-wrap gap-2">
      {pending.map((item) => (
        <li key={item.key} className="relative">
          <img
            src={item.url}
            alt={item.file.name}
            className="size-14 rounded-md object-cover"
          />
          <IconButton
            type="button"
            icon={X}
            label={`Remove ${item.file.name}`}
            variant="ink"
            size={24}
            className="absolute -top-1.5 -right-1.5"
            onClick={() => removeFile(item.key)}
          />
        </li>
      ))}
    </ul>
  ) : null;

  const attachControl = (
    <IconButton
      type="button"
      icon={Paperclip}
      label={attachHint}
      variant="ghost"
      size={36}
      disabled={attachDisabled}
      onClick={() => fileInput.current?.click()}
    />
  );
  const attachButton = showAttach ? (
    <Tooltip label={attachHint}>
      {attachDisabled ? (
        <span className="inline-flex" tabIndex={0}>
          {attachControl}
        </span>
      ) : (
        attachControl
      )}
    </Tooltip>
  ) : null;

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (suggesting) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((index) => (index + step + suggestions.length) % suggestions.length);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        const candidate = suggestions[active];
        if (candidate) {
          event.preventDefault();
          pick(candidate);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setQuery(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }

  const textarea = (
    <textarea
      ref={box}
      rows={1}
      name={name}
      aria-label={label}
      placeholder={placeholder}
      value={text}
      disabled={disabled}
      autoFocus={autoFocus}
      onChange={(event) => {
        change(event.currentTarget.value);
        trackCaret();
      }}
      onSelect={trackCaret}
      onPaste={onPaste}
      onBlur={() => setQuery(null)}
      onKeyDown={onKeyDown}
      {...(mentions?.length
        ? {
            role: "combobox",
            "aria-autocomplete": "list" as const,
            "aria-expanded": suggesting,
            "aria-controls": listId,
            ...(suggesting ? { "aria-activedescendant": `${listId}-${active}` } : {}),
          }
        : {})}
      className={cn(
        "max-h-60 w-full min-w-0 resize-none overflow-y-auto bg-transparent text-md text-fg outline-none",
        "placeholder:text-muted focus-visible:outline-none disabled:cursor-not-allowed",
        variant === "card" ? "min-h-10" : "py-2.5",
      )}
    />
  );

  const suggestionList = suggesting ? (
    <ul
      id={listId}
      role="listbox"
      aria-label="Mention"
      className="absolute bottom-full left-0 z-10 mb-2 flex w-72 max-w-full flex-col gap-0.5 rounded-lg bg-paper p-1.5 text-fg shadow-pop"
    >
      {suggestions.map((candidate, index) => (
        <li
          key={candidate.name}
          id={`${listId}-${index}`}
          role="option"
          aria-selected={index === active}
          onMouseDown={(event) => {
            event.preventDefault();
            pick(candidate);
          }}
          onMouseEnter={() => setActive(index)}
          className="flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 selected:bg-well"
        >
          <Avatar
            name={candidate.name}
            tone={candidate.tone ?? "dusk"}
            size={24}
            {...(candidate.src ? { src: candidate.src } : {})}
            round={!candidate.tone}
          />
          <span className="truncate font-mono text-sm font-medium">{candidate.name}</span>
          {candidate.hint ? <span className="ml-auto truncate text-xs text-muted">{candidate.hint}</span> : null}
        </li>
      ))}
    </ul>
  ) : null;

  const frame = cn(
    "text-fg transition-shadow focus-within:ring-2 focus-within:ring-focus",
    tones[tone],
  );

  if (variant === "inline") {
    return (
      <form
        className={cn(frame, "relative flex items-end gap-2.5 rounded-xl py-2 pr-2 pl-5", className)}
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
        {...props}
      >
        {fileField}
        {suggestionList}
        <div className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-2">
          {previews}
          {textarea}
        </div>
        {attachButton}
        <IconButton
          type="submit"
          icon={ArrowUp}
          label="Send"
          variant="ink"
          size={44}
          disabled={!canSend}
        />
      </form>
    );
  }

  return (
    <form
      className={cn(
        frame,
        "@container relative flex flex-col gap-3 rounded-xl pt-3.5 pr-3.5 pb-2.5 pl-5",
        className,
      )}
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
      {...props}
    >
      {fileField}
      {suggestionList}
      {previews}
      {textarea}
      <div className="flex flex-wrap items-center gap-2">
        {footnote ? (
          <span className="min-w-0 flex-1 text-xs text-pretty text-muted">{footnote}</span>
        ) : (
          <span className="flex items-center gap-2 text-xs whitespace-nowrap text-muted">
            <Kbd className={cn(tone === "paper" && "bg-surface")}>↵ Enter</Kbd>
            <span>
              to send<span className="hidden @md:inline"> · Shift+Enter for newline</span>
            </span>
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {attachButton}
          {generating && onCancel ? (
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button type="submit" variant="accent" disabled={!canSend}>
            Send
            <Icon icon={ArrowUp} size={14} />
          </Button>
        </div>
      </div>
    </form>
  );
}
