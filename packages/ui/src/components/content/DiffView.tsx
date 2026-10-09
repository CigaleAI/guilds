import { GitCompare, UnfoldVertical } from "lucide-react";
import { Fragment, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";
import { Pill } from "../../primitives/Pill";
import type { DiffLine } from "./diff";
import { Segmented } from "../controls/Segmented";

export type DiffLayout = "unified" | "split";

type Block = { type: "lines"; lines: DiffLine[] } | { type: "fold"; id: number; lines: DiffLine[] };

/** Unchanged runs longer than the context around them fold into one expandable row. */
function foldContext(lines: DiffLine[], context: number, expanded: ReadonlySet<number>): Block[] {
  const blocks: Block[] = [];
  let shown: DiffLine[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line?.kind !== "ctx") {
      if (line) shown.push(line);
      index++;
      continue;
    }
    let end = index;
    while (lines[end]?.kind === "ctx") end++;
    const keepHead = index === 0 ? 0 : context;
    const keepTail = end === lines.length ? 0 : context;
    const hiddenFrom = index + keepHead;
    const hiddenTo = end - keepTail;
    if (hiddenTo - hiddenFrom >= 2 && !expanded.has(hiddenFrom)) {
      shown.push(...lines.slice(index, hiddenFrom));
      if (shown.length) blocks.push({ type: "lines", lines: shown });
      blocks.push({ type: "fold", id: hiddenFrom, lines: lines.slice(hiddenFrom, hiddenTo) });
      shown = lines.slice(hiddenTo, end);
    } else {
      shown.push(...lines.slice(index, end));
    }
    index = end;
  }
  if (shown.length) blocks.push({ type: "lines", lines: shown });
  return blocks;
}

type SplitRow = { left: DiffLine | undefined; right: DiffLine | undefined };

function pairRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    for (let k = 0; k < Math.max(dels.length, adds.length); k++)
      rows.push({ left: dels[k], right: adds[k] });
    dels = [];
    adds = [];
  };
  for (const line of lines) {
    if (line.kind === "ctx") {
      flush();
      rows.push({ left: line, right: line });
    } else if (line.kind === "del") {
      dels.push(line);
    } else {
      adds.push(line);
    }
  }
  flush();
  return rows;
}

const rowTone: Record<DiffLine["kind"], string> = {
  add: "bg-t-tide text-t-tide-fg",
  del: "bg-t-plum text-plum-t",
  ctx: "text-fg-2",
};

const sign: Record<DiffLine["kind"], string> = { add: "+", del: "−", ctx: "" };
const spoken: Record<DiffLine["kind"], string> = { add: "Added: ", del: "Removed: ", ctx: "" };

function LineNo({ value }: { value: number | undefined }) {
  return <span className="w-8 shrink-0 pr-2 text-right text-muted select-none">{value ?? ""}</span>;
}

function LineText({ line }: { line: DiffLine }) {
  return (
    <>
      <span aria-hidden className="w-4 shrink-0 select-none">
        {sign[line.kind]}
      </span>
      <span className="min-w-0 flex-1 pr-3 whitespace-pre-wrap wrap-anywhere">
        {line.kind !== "ctx" ? <span className="sr-only">{spoken[line.kind]}</span> : null}
        {line.text}
      </span>
    </>
  );
}

function UnifiedRow({ line }: { line: DiffLine }) {
  return (
    <div className={cn("flex", rowTone[line.kind])}>
      <LineNo value={line.oldNo} />
      <LineNo value={line.newNo} />
      <LineText line={line} />
    </div>
  );
}

function SplitHalf({ line, side }: { line: DiffLine | undefined; side: "old" | "new" }) {
  return (
    <div
      className={cn(
        "flex min-w-0",
        line && rowTone[line.kind],
        side === "new" && "border-l border-line",
      )}
    >
      {line ? (
        <>
          <LineNo value={side === "old" ? line.oldNo : line.newNo} />
          <LineText line={line} />
        </>
      ) : null}
    </div>
  );
}

export type DiffViewProps = Omit<ComponentProps<"div">, "title"> & {
  lines: DiffLine[];
  /** What is compared, such as "task · v7 → v8" or "task · live → draft". */
  title?: ReactNode;
  defaultLayout?: DiffLayout;
  /** Unchanged lines kept on each side of a change; longer unchanged runs fold. */
  context?: number;
};

/** A line diff of a Task: a Studio draft against the live Task, or a revision against the one before it. */
export function DiffView({
  lines,
  title,
  defaultLayout = "unified",
  context = 3,
  className,
  ...props
}: DiffViewProps) {
  const [layout, setLayout] = useState<DiffLayout>(defaultLayout);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const added = lines.filter((line) => line.kind === "add").length;
  const removed = lines.filter((line) => line.kind === "del").length;
  const blocks = useMemo(() => foldContext(lines, context, expanded), [lines, context, expanded]);

  return (
    <div className={cn("overflow-hidden rounded-lg bg-paper text-fg", className)} {...props}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
        <Icon icon={GitCompare} size={14} className="text-muted" />
        {title !== undefined ? (
          <span className="min-w-0 font-mono text-xs font-medium">{title}</span>
        ) : null}
        <Pill size="xs" fill="tide-tint" className="h-5 font-bold" title={`${added} added`}>
          +{added}
        </Pill>
        <Pill size="xs" fill="plum-tint" className="h-5 font-bold" title={`${removed} removed`}>
          −{removed}
        </Pill>
        <span className="flex-1" />
        <Segmented
          label="Diff layout"
          value={layout}
          onValueChange={setLayout}
          options={[
            { value: "unified", label: "Unified" },
            { value: "split", label: "Split" },
          ]}
        />
      </div>
      <div className="py-1.5 font-mono text-xs leading-5">
        {added + removed === 0 ? (
          <p className="px-3 py-1 font-sans text-sm text-muted">No changes.</p>
        ) : (
          blocks.map((block) => (
            <Fragment
              key={
                block.type === "fold"
                  ? `fold-${block.id}`
                  : `lines-${block.lines[0]?.oldNo ?? 0}-${block.lines[0]?.newNo ?? 0}`
              }
            >
              {block.type === "fold" ? (
                <button
                  type="button"
                  onClick={() => setExpanded((prev) => new Set(prev).add(block.id))}
                  className="flex w-full cursor-pointer items-center gap-2 bg-surface py-0.5 pr-3 pl-4 text-left text-muted transition-colors hover:bg-well hover:text-fg"
                >
                  <Icon icon={UnfoldVertical} size={14} />
                  {block.lines.length} unchanged lines
                </button>
              ) : layout === "unified" ? (
                block.lines.map((line) => (
                  <UnifiedRow
                    key={`${line.kind}-${line.oldNo ?? ""}-${line.newNo ?? ""}`}
                    line={line}
                  />
                ))
              ) : (
                pairRows(block.lines).map((row) => (
                  <div
                    key={`${row.left?.oldNo ?? ""}-${row.right?.newNo ?? ""}-${row.left?.kind ?? row.right?.kind}`}
                    className="grid grid-cols-2"
                  >
                    <SplitHalf line={row.left} side="old" />
                    <SplitHalf line={row.right} side="new" />
                  </div>
                ))
              )}
            </Fragment>
          ))
        )}
      </div>
    </div>
  );
}
