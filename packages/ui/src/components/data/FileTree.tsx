import { ChevronDown, ChevronRight } from "lucide-react";
import { useState, type ComponentProps, type KeyboardEvent } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";

export type FileTreeNode = {
  id: string;
  name: string;
  kind: "file" | "folder";
  children?: FileTreeNode[];
  /** Files in a folder, including ones not loaded yet. */
  count?: number;
};

export type FileTreeProps = Omit<ComponentProps<"nav">, "onSelect" | "children"> & {
  nodes: FileTreeNode[];
  /** Accessible name, such as "Agent notes". */
  label: string;
  selectedId?: string | null;
  onSelect?: (node: FileTreeNode) => void;
  /** Open folders; pass with `onExpandedChange` to control them. */
  expandedIds?: string[];
  defaultExpandedIds?: string[];
  onExpandedChange?: (ids: string[]) => void;
};

const itemSelector = "[data-tree-item]";

/** A file tree: folders fold open with a chevron and a file count; markdown files carry an "md" mark. */
export function FileTree({
  nodes,
  label,
  selectedId,
  onSelect,
  expandedIds,
  defaultExpandedIds,
  onExpandedChange,
  onKeyDown,
  className,
  ...props
}: FileTreeProps) {
  const [ownExpanded, setOwnExpanded] = useState<string[]>(defaultExpandedIds ?? []);
  const expanded = expandedIds ?? ownExpanded;

  const setExpanded = (id: string, open: boolean) => {
    const next = open ? [...new Set([...expanded, id])] : expanded.filter((item) => item !== id);
    if (expandedIds === undefined) setOwnExpanded(next);
    onExpandedChange?.(next);
  };

  const navigate = (event: KeyboardEvent<HTMLElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(itemSelector));
    const current = event.target instanceof HTMLButtonElement ? event.target : null;
    const index = current ? items.indexOf(current) : -1;
    if (index < 0) return;
    const focusAt = (at: number) => items[Math.max(0, Math.min(items.length - 1, at))]?.focus();
    const isFolder = current?.dataset.kind === "folder";
    const isOpen = current?.getAttribute("aria-expanded") === "true";
    const id = current?.dataset.nodeId ?? "";
    switch (event.key) {
      case "ArrowDown":
        focusAt(index + 1);
        break;
      case "ArrowUp":
        focusAt(index - 1);
        break;
      case "Home":
        focusAt(0);
        break;
      case "End":
        focusAt(items.length - 1);
        break;
      case "ArrowRight":
        if (isFolder && !isOpen) setExpanded(id, true);
        else if (isFolder) focusAt(index + 1);
        else return;
        break;
      case "ArrowLeft": {
        if (isFolder && isOpen) {
          setExpanded(id, false);
          break;
        }
        const parent = items.find((item) => item.dataset.nodeId === current?.dataset.parentId);
        if (!parent) return;
        parent.focus();
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  const renderNodes = (list: FileTreeNode[], parentId: string | null) => (
    <ul className={cn("flex flex-col gap-0.5", parentId !== null && "mt-0.5 pl-5")}>
      {list.map((node) => {
        const isFolder = node.kind === "folder";
        const isOpen = isFolder && expanded.includes(node.id);
        const isSelected = !isFolder && node.id === selectedId;
        return (
          <li key={node.id}>
            <button
              type="button"
              data-tree-item
              data-node-id={node.id}
              data-parent-id={parentId ?? undefined}
              data-kind={node.kind}
              data-selected={isSelected ? "true" : undefined}
              aria-expanded={isFolder ? isOpen : undefined}
              aria-current={isSelected ? "true" : undefined}
              onClick={() => (isFolder ? setExpanded(node.id, !isOpen) : onSelect?.(node))}
              className={cn(
                "group/item flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-fg transition-colors hover:bg-paper-hi",
                "selected:bg-plum selected:text-on-plum",
              )}
            >
              <span
                aria-hidden
                className="flex w-4 shrink-0 justify-center font-mono text-2xs text-muted group-data-[selected=true]/item:text-on-plum-muted"
              >
                {isFolder ? <Icon icon={isOpen ? ChevronDown : ChevronRight} size={14} /> : "md"}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-sm">{node.name}</span>
              {isFolder && node.count !== undefined ? (
                <span className="shrink-0 rounded-sm bg-well px-1.5 font-mono text-2xs text-fg">
                  {node.count}
                  <span className="sr-only"> files</span>
                </span>
              ) : null}
            </button>
            {isOpen && node.children?.length ? renderNodes(node.children, node.id) : null}
          </li>
        );
      })}
    </ul>
  );

  return (
    <nav
      aria-label={label}
      className={cn("min-w-0", className)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (!event.defaultPrevented) navigate(event);
      }}
      {...props}
    >
      {renderNodes(nodes, null)}
    </nav>
  );
}
