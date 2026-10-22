import { cva } from "class-variance-authority";
import {
  createContext,
  createElement,
  useContext,
  useRef,
  useMemo,
  type ComponentProps,
  type JSX,
} from "react";
import ReactMarkdown, { type Components, type ExtraProps, type Options } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { cn } from "../../cn";
import { CopyButton } from "../actions/CopyButton";
import { EmbedChip } from "./EmbedChip";
import { Mention } from "../identity/Mention";
import { remarkEmbeds } from "./embeds";
import { remarkMentions } from "./mentions";

export type MarkdownDensity = "document" | "compact";
/** `tinted` reads on a soft coloured ground, such as a person's message bubble. */
export type MarkdownTone = "default" | "tinted";

/** The tone Markdown takes when none is passed; a bubble sets it for what it holds. */
export const MarkdownToneContext = createContext<MarkdownTone>("default");

type MarkdownSettings = {
  density: MarkdownDensity;
  tone: MarkdownTone;
  onOpenEmbed: ((path: string) => void) | undefined;
  isBrokenEmbed: ((path: string) => boolean) | undefined;
};

const Settings = createContext<MarkdownSettings>({
  density: "document",
  tone: "default",
  onOpenEmbed: undefined,
  isBrokenEmbed: undefined,
});
const ListKind = createContext<{ ordered: boolean; depth: number } | null>(null);
const InsidePre = createContext(false);

const root = cva("flex min-w-0 flex-col wrap-break-word", {
  variants: {
    density: {
      document: "gap-3 text-md leading-relaxed",
      compact: "gap-2 text-sm leading-normal",
    },
    tone: {
      default: "text-fg-2",
      tinted: "text-fg",
    },
  },
});

/** Headings and bold text step up from body grey to full ink. */
const strongTone = { default: "text-fg", tinted: "text-fg" };

const heading = cva("font-semibold", {
  variants: {
    level: { 1: "", 2: "", 3: "", 4: "" },
    density: { document: "not-first:pt-2", compact: "not-first:pt-1" },
    tone: strongTone,
  },
  compoundVariants: [
    { density: "document", level: 1, className: "type-h2" },
    { density: "document", level: 2, className: "text-xl" },
    { density: "document", level: 3, className: "text-lg" },
    { density: "document", level: 4, className: "text-md" },
    { density: "compact", level: 1, className: "text-lg" },
    { density: "compact", level: 2, className: "text-md" },
    { density: "compact", level: 3, className: "text-sm" },
    { density: "compact", level: 4, className: "text-sm" },
  ],
});

const measure = { document: "max-w-170", compact: "" };

const link = cva("underline underline-offset-2 hover:decoration-2", {
  variants: { tone: { default: "text-signal-t", tinted: "text-fg" } },
});

const list = cva("", {
  variants: {
    ordered: { true: "list-decimal pl-5", false: "" },
    density: { document: "space-y-1.5", compact: "space-y-1" },
    nested: { true: "pt-1.5", false: "" },
  },
});

const bullet = cva(
  "relative pl-4 before:absolute before:left-0.5 before:size-1.5 before:rounded-full",
  {
    variants: {
      density: { document: "before:top-2", compact: "before:top-1.5" },
      tone: { default: "before:bg-fg-2", tinted: "before:bg-fg-2" },
    },
  },
);

const numbered = cva("pl-1", {
  variants: { tone: { default: "marker:text-muted", tinted: "marker:text-fg-2" } },
});

const inlineCode = cva(
  "rounded-sm px-1.5 py-0.5 font-mono text-xs box-decoration-clone wrap-anywhere",
  {
    variants: {
      tone: { default: "bg-well text-fg", tinted: "bg-fg/10 text-fg" },
    },
  },
);

const codeBlock = cva("overflow-x-auto rounded-md bg-panel font-mono text-on-panel", {
  variants: {
    density: {
      document: "px-3.5 py-3 text-sm leading-relaxed",
      compact: "px-3 py-2.5 text-xs leading-normal",
    },
  },
});

const quote = cva("space-y-2 rounded-md italic", {
  variants: {
    density: { document: "px-3.5 py-3", compact: "px-3 py-2" },
    tone: { default: "bg-well text-fg-2", tinted: "bg-fg/5 text-fg-2" },
  },
});

const tableFrame = cva("max-w-full overflow-x-auto overscroll-contain rounded-md border", {
  variants: {
    tone: { default: "border-line-2", tinted: "border-fg/15" },
  },
});

const tableHead = { default: "bg-surface text-fg", tinted: "bg-fg/5 text-fg" };
const cellRule = { default: "border-line-2", tinted: "border-fg/15" };
const tableText = { document: "text-sm", compact: "text-xs" };
const ruleFill = { default: "bg-line-2", tinted: "bg-fg/15" };
type Props<K extends keyof JSX.IntrinsicElements> = ComponentProps<K> & ExtraProps;

function headingOf(level: 1 | 2 | 3 | 4, tagName: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
  return function MarkdownHeading({ node: _node, className, ...props }: Props<typeof tagName>) {
    const { density, tone } = useContext(Settings);
    return createElement(tagName, {
      ...props,
      className: cn(heading({ level, density, tone }), className),
    });
  };
}

function listOf(ordered: boolean) {
  return function MarkdownList({ node: _node, className, ...props }: Props<"ul" | "ol">) {
    const { density } = useContext(Settings);
    const parent = useContext(ListKind);
    const depth = parent ? parent.depth + 1 : 0;
    return (
      <ListKind.Provider value={{ ordered, depth }}>
        {createElement(ordered ? "ol" : "ul", {
          ...props,
          className: cn(
            list({ ordered, density, nested: depth > 0 }),
            depth === 0 && measure[density],
            className,
          ),
        })}
      </ListKind.Provider>
    );
  };
}

function Paragraph({ node: _node, className, ...props }: Props<"p">) {
  const { density } = useContext(Settings);
  return <p className={cn(measure[density], className)} {...props} />;
}

function Link({ node: _node, className, href, ...props }: Props<"a">) {
  const { tone } = useContext(Settings);
  const external = typeof href === "string" && /^https?:\/\//i.test(href);
  return (
    <a
      href={href}
      className={cn(link({ tone }), className)}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      {...props}
    />
  );
}

function ListItem({ node: _node, className, ...props }: Props<"li">) {
  const { density, tone } = useContext(Settings);
  const kind = useContext(ListKind);
  const isTask = typeof className === "string" && className.includes("task-list-item");
  const style = isTask
    ? "list-none"
    : kind?.ordered
      ? numbered({ tone })
      : bullet({ density, tone });
  return <li className={cn(style, className)} {...props} />;
}

function Checkbox({ node: _node, className, ...props }: Props<"input">) {
  return (
    <input className={cn("mr-2 size-3.5 translate-y-0.5 accent-ink-fill", className)} {...props} />
  );
}

function Code({ node: _node, className, ...props }: Props<"code">) {
  const { tone } = useContext(Settings);
  const block = useContext(InsidePre);
  return <code className={cn(!block && inlineCode({ tone }), className)} {...props} />;
}

/** The language a fenced block names, from its code element's `language-*` class. */
function languageOf(node: Props<"pre">["node"]): string | null {
  const code = node?.children.find((child) => child.type === "element" && child.tagName === "code");
  const classes = code && code.type === "element" ? code.properties.className : undefined;
  const found = Array.isArray(classes)
    ? classes.map(String).find((name) => name.startsWith("language-"))
    : undefined;
  return found ? found.slice("language-".length) : null;
}

function CodeBlock({ node, className, ...props }: Props<"pre">) {
  const { density } = useContext(Settings);
  const pre = useRef<HTMLPreElement>(null);
  const language = languageOf(node);
  return (
    <InsidePre.Provider value={true}>
      <div className="relative">
        <pre ref={pre} className={cn(codeBlock({ density }), "pr-16", className)} {...props} />
        <div className="absolute top-1 right-1 flex items-center gap-1">
          {language ? <span className="font-mono text-2xs text-muted">{language}</span> : null}
          <CopyButton text={() => pre.current?.textContent ?? ""} what="code" size={24} />
        </div>
      </div>
    </InsidePre.Provider>
  );
}

function Quote({ node: _node, className, ...props }: Props<"blockquote">) {
  const { density, tone } = useContext(Settings);
  return <blockquote className={cn(quote({ density, tone }), className)} {...props} />;
}

function Table({ node: _node, className, ...props }: Props<"table">) {
  const { density, tone } = useContext(Settings);
  return (
    <div className={tableFrame({ tone })}>
      <table
        className={cn("w-max min-w-full border-collapse", tableText[density], className)}
        {...props}
      />
    </div>
  );
}

function TableHead({ node: _node, className, ...props }: Props<"thead">) {
  const { tone } = useContext(Settings);
  return <thead className={cn(tableHead[tone], className)} {...props} />;
}

function HeaderCell({ node: _node, className, ...props }: Props<"th">) {
  return (
    <th
      className={cn("px-3 py-2 text-left font-semibold whitespace-nowrap", className)}
      {...props}
    />
  );
}

function Cell({ node: _node, className, ...props }: Props<"td">) {
  const { tone } = useContext(Settings);
  return (
    <td
      className={cn("border-t px-3 py-2 align-top whitespace-nowrap", cellRule[tone], className)}
      {...props}
    />
  );
}

function Rule({ node: _node, className, ...props }: Props<"hr">) {
  const { tone } = useContext(Settings);
  return <hr className={cn("h-px border-0", ruleFill[tone], className)} {...props} />;
}

function Image({ node: _node, className, alt, ...props }: Props<"img">) {
  return <img alt={alt ?? ""} className={cn("max-w-full rounded-md", className)} {...props} />;
}

function Strong({ node: _node, className, ...props }: Props<"strong">) {
  const { tone } = useContext(Settings);
  return <strong className={cn("font-bold", strongTone[tone], className)} {...props} />;
}

/** Spans only come from the embed and mention plugins; raw HTML never reaches the tree. */
function Span({ node, className, ...props }: Props<"span">) {
  const { tone, onOpenEmbed, isBrokenEmbed } = useContext(Settings);
  const handle = node?.properties?.dataMention;
  if (typeof handle === "string") return <Mention handle={handle} tone={tone} />;
  const path = node?.properties?.dataEmbed;
  if (typeof path === "string") {
    return (
      <EmbedChip
        path={path}
        tone={tone}
        broken={isBrokenEmbed?.(path) ?? false}
        {...(onOpenEmbed ? { onOpen: onOpenEmbed } : {})}
      />
    );
  }
  return <span className={className} {...props} />;
}

const components: Components = {
  h1: headingOf(1, "h1"),
  h2: headingOf(2, "h2"),
  h3: headingOf(3, "h3"),
  h4: headingOf(4, "h4"),
  h5: headingOf(4, "h5"),
  h6: headingOf(4, "h6"),
  p: Paragraph,
  a: Link,
  ul: listOf(false),
  ol: listOf(true),
  li: ListItem,
  input: Checkbox,
  code: Code,
  pre: CodeBlock,
  blockquote: Quote,
  table: Table,
  thead: TableHead,
  th: HeaderCell,
  td: Cell,
  hr: Rule,
  img: Image,
  strong: Strong,
  span: Span,
};

export type MarkdownProps = Omit<ComponentProps<"div">, "children"> & {
  /** Markdown source. Raw HTML shows as text; it is never rendered. */
  children: string;
  /** `document` for notes and previews; `compact` for chat messages. */
  density?: MarkdownDensity;
  /** Defaults to the surrounding `MarkdownToneContext`. */
  tone?: MarkdownTone;
  /** Opens an embedded note or table; embeds render as buttons when set. */
  onOpenEmbed?: (path: string) => void;
  /** Marks embeds that are not reachable. */
  isBrokenEmbed?: (path: string) => boolean;
  /** Handles the message tagged; their `@handle` shows as a mention chip. */
  mentions?: readonly string[];
};

/** Agent- or operator-written Markdown: notes, messages, Task previews. A single line break stays a break; `![[path]]` embeds and tagged `@handles` show as chips. */
export function Markdown({
  children,
  density = "document",
  tone: toneProp,
  onOpenEmbed,
  isBrokenEmbed,
  mentions,
  className,
  ...props
}: MarkdownProps) {
  const inheritedTone = useContext(MarkdownToneContext);
  const tone = toneProp ?? inheritedTone;
  const mentionKey = mentions?.join(" ") ?? "";
  const remarkPlugins = useMemo<NonNullable<Options["remarkPlugins"]>>(
    () => [
      remarkGfm,
      remarkBreaks,
      remarkEmbeds,
      [remarkMentions, { names: mentionKey ? mentionKey.split(" ") : [] }],
    ],
    [mentionKey],
  );
  const settings = useMemo(
    () => ({ density, tone, onOpenEmbed, isBrokenEmbed }),
    [density, tone, onOpenEmbed, isBrokenEmbed],
  );
  return (
    <div className={cn(root({ density, tone }), className)} {...props}>
      <Settings.Provider value={settings}>
        <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
          {children}
        </ReactMarkdown>
      </Settings.Provider>
    </div>
  );
}
