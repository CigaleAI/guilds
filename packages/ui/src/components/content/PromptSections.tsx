import { Check, ChevronDown, Copy, SquareTerminal } from "lucide-react";
import { Collapsible } from "radix-ui";
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";
import { CopyButton } from "../actions/CopyButton";
import { IconButton } from "../actions/IconButton";
import { PromptTag, promptSections, type PromptSection } from "../identity/PromptTag";
import { JsonTree } from "./JsonTree";
import { Markdown } from "./Markdown";
import { promptBlocks, promptText, type PromptBlock } from "./promptBlocks";

const sectionSource: Record<PromptSection, string> = {
  guidelines: "Repo template, then the agent's name and id",
  task: "The operator's standing purpose, with embeds expanded",
  state: "Snapshot of the guild at run creation",
  memory: "The agent's own memory.md",
};

export type PromptSectionsProps = Omit<ComponentProps<"div">, "title"> & {
  /** Section bodies as hydrated for the run; missing sections are left out. */
  sections: Partial<Record<PromptSection, string>>;
  title?: ReactNode;
  defaultOpen?: boolean;
};

/** The collapsible system prompt of a run: Guidelines, Task, State and Memory, read-only. */
export function PromptSections({
  sections,
  title = "System prompt",
  defaultOpen = false,
  className,
  ...props
}: PromptSectionsProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const resetCopied = useRef<ReturnType<typeof setTimeout>>(undefined);
  const present = promptSections.filter((name) => sections[name] !== undefined);

  useEffect(() => () => clearTimeout(resetCopied.current), []);

  async function copy() {
    const text = present
      .map((name) => `<${name}>\n${sections[name] ?? ""}\n</${name}>`)
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(resetCopied.current);
      resetCopied.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className={cn("overflow-hidden rounded-xl bg-surface text-fg", className)}
      {...props}
    >
      <div className="relative flex items-center gap-2 px-4 py-3">
        <Collapsible.Trigger className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-2.5 text-left after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-focus">
          <Icon icon={SquareTerminal} className="text-plum-t" />
          <span className="text-md font-bold">{title}</span>
          <span className="flex flex-wrap gap-1.5">
            {present.map((name) => (
              <PromptTag key={name} section={name} />
            ))}
          </span>
        </Collapsible.Trigger>
        <IconButton
          icon={copied ? Check : Copy}
          label={copied ? "Copied" : "Copy system prompt"}
          variant="ghost"
          size={28}
          className="relative z-10 text-muted hover:text-fg"
          onClick={() => void copy()}
        />
        <Icon
          icon={ChevronDown}
          size={14}
          className={cn("transition-transform", open && "rotate-180")}
        />
      </div>
      <Collapsible.Content className="flex flex-col gap-3 px-4 pb-4">
        {present.map((name) => (
          <section key={name} aria-label={name} className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <PromptTag section={name} />
              <span className="flex-1 text-xs text-muted">{sectionSource[name]}</span>
              <CopyButton text={sections[name] ?? ""} what={`the ${name} section`} size={24} />
            </div>
            <div
              tabIndex={0}
              className="flex max-h-96 flex-col gap-2 overflow-auto rounded-md bg-paper px-3.5 py-3"
            >
              {sections[name]?.trim() ? (
                <PromptBody content={sections[name] ?? ""} />
              ) : (
                <span className="text-sm text-muted">—</span>
              )}
            </div>
          </section>
        ))}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

/** Text as it reads best: JSON as a tree, anything else as Markdown. */
function PromptTextView({ text }: { text: string }) {
  const read = promptText(text);
  if (read.kind === "markdown") return <Markdown density="compact">{read.text}</Markdown>;
  return (
    <div className="flex flex-col gap-1">
      {read.lead ? <Markdown density="compact">{read.lead}</Markdown> : null}
      <JsonTree value={read.value} />
    </div>
  );
}

/** A section's body: its tagged parts as nested cards, the text between them as Markdown. */
function PromptBody({ content }: { content: string }) {
  return <PromptBlocksView blocks={promptBlocks(content)} />;
}

function PromptBlocksView({ blocks }: { blocks: PromptBlock[] }) {
  return (
    <>
      {blocks.map((block, index) =>
        block.type === "text" ? (
          <PromptTextView key={index} text={block.text} />
        ) : (
          <section key={index} className="flex flex-col gap-1.5 rounded-md bg-surface px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-semibold text-fg">&lt;{block.tag}&gt;</span>
              {block.path ? (
                <span className="min-w-0 truncate font-mono text-2xs text-muted">{block.path}</span>
              ) : null}
              <CopyButton
                text={block.content}
                what={`<${block.tag}>`}
                size={24}
                className="ml-auto"
              />
            </div>
            {block.children ? (
              <div className="flex flex-col gap-2">
                <PromptBlocksView blocks={block.children} />
              </div>
            ) : (
              <PromptTextView text={block.content} />
            )}
          </section>
        ),
      )}
    </>
  );
}
