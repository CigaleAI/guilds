import { ChevronDown } from "lucide-react";
import { Collapsible } from "radix-ui";
import { useState, type ComponentProps } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";
import { pill } from "../../primitives/Pill";
import { Tag } from "../../primitives/Tag";

export type OfferedTool = { name: string; description?: string };

/** Tools from one source: the built-in toolbox or one MCP server. */
export type OfferedToolGroup = { server: string; tools: OfferedTool[] };

export type OfferedToolsProps = ComponentProps<"div"> & {
  groups: OfferedToolGroup[];
  /** Tool names shown in the collapsed row. */
  previewCount?: number;
  defaultOpen?: boolean;
};

function ToolTag({ tool }: { tool: OfferedTool }) {
  return (
    <Tag
      tone="paper"
      className="text-xs"
      {...(tool.description ? { title: tool.description } : {})}
    >
      {tool.name}
    </Tag>
  );
}

/** The tools a run was offered: a count and a few names, expanding to every tool by server. */
export function OfferedTools({
  groups,
  previewCount = 4,
  defaultOpen = false,
  className,
  ...props
}: OfferedToolsProps) {
  const [open, setOpen] = useState(defaultOpen);
  const all = groups.flatMap((group) => group.tools);
  const preview = all.slice(0, previewCount);
  const more = all.length - preview.length;

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className={cn("overflow-hidden rounded-xl bg-surface text-fg", className)}
      {...props}
    >
      <Collapsible.Trigger className="flex w-full cursor-pointer items-center gap-2.5 px-4 py-3 text-left">
        <span className="shrink-0 text-md font-bold">Offered tools</span>
        <span className={cn(pill({ fill: "accent" }), "h-auto px-2 py-0.5 text-2xs font-bold")}>
          {all.length} available
        </span>
        {!open ? (
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {preview.map((tool) => (
              <ToolTag key={tool.name} tool={tool} />
            ))}
            {more > 0 ? (
              <span className="text-xs whitespace-nowrap text-muted">+{more} more</span>
            ) : null}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <Icon
          icon={ChevronDown}
          size={14}
          className={cn("transition-transform", open && "rotate-180")}
        />
      </Collapsible.Trigger>
      <Collapsible.Content className="flex flex-col gap-3 px-4 pb-4">
        {all.length === 0 ? <p className="text-sm text-muted">No tools were offered.</p> : null}
        {groups
          .filter((group) => group.tools.length > 0)
          .map((group) => (
            <section key={group.server} aria-label={group.server} className="flex flex-col gap-1.5">
              {groups.length > 1 ? (
                <span className="type-label text-muted">
                  {group.server} · {group.tools.length}
                </span>
              ) : null}
              <div className="flex flex-wrap gap-1.5">
                {group.tools.map((tool) => (
                  <ToolTag key={tool.name} tool={tool} />
                ))}
              </div>
            </section>
          ))}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
