import { useId, useMemo, useState } from "react";
import { FileText, Link2Off, ScrollText, Table2, type LucideIcon } from "lucide-react";
import { cn, Icon } from "@guildsrun/ui";
import type {
  ReferenceEdgeStatus,
  ReferenceNodeKind,
  StudioReferences,
} from "../../../api/types/studio";
import { useWidth } from "../activity/parts";
import {
  isBroken,
  isOverBudget,
  layoutReferences,
  litIds,
  referenceColumnLabels,
  referenceMeta,
  type PlacedReference,
  type ReferenceMapView,
} from "./referencesModel";

const MIN_WIDTH = 720;

export const referenceKindIcon: Record<ReferenceNodeKind, LucideIcon> = {
  task: ScrollText,
  note: FileText,
  table: Table2,
  unresolved: Link2Off,
};

const edgeTone: Record<ReferenceEdgeStatus, { stroke: string; fill: string }> = {
  inlined: { stroke: "stroke-rule", fill: "fill-rule" },
  too_deep: { stroke: "stroke-ochre", fill: "fill-ochre" },
  unreached: { stroke: "stroke-line-3", fill: "fill-line-3" },
  broken: { stroke: "stroke-outcome-failed", fill: "fill-outcome-failed" },
  named: { stroke: "stroke-rule-2", fill: "fill-rule-2" },
};

const edgeStatuses = Object.keys(edgeTone) as ReferenceEdgeStatus[];

/**
 * Every Task in the first column, then the notes and tables its embeds reach, one column per hop,
 * with the files no Task reaches in a band below. A solid line is an embed, a dotted one a path
 * named in the text. Hovering or selecting a box lights what it pulls in and what pulls it in.
 */
export function ReferencesMap({
  data,
  view,
  selected,
  onSelect,
}: {
  data: StudioReferences;
  view: ReferenceMapView;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [measure, width] = useWidth();
  const [hover, setHover] = useState<string | null>(null);
  const markers = useId();
  const layout = useMemo(
    () => layoutReferences(view, data, Math.max(MIN_WIDTH, width)),
    [view, data, width],
  );
  const focus = hover ?? selected;
  const lit = useMemo(() => (focus ? litIds(data, focus) : null), [data, focus]);
  const labels = referenceColumnLabels(data.depth);

  return (
    <div ref={measure} className="overflow-x-auto">
      <div className="relative" style={{ width: layout.width, height: layout.height }}>
        {labels.map((label, index) => (
          <span
            key={label}
            className="absolute type-label text-muted"
            style={{ left: layout.columnX[index], top: 0 }}
          >
            {label}
          </span>
        ))}
        {layout.bandY !== null ? (
          <span className="absolute type-label text-muted" style={{ left: 0, top: layout.bandY }}>
            No Task reaches these
          </span>
        ) : null}
        <svg
          className="pointer-events-none absolute inset-0 overflow-visible"
          width={layout.width}
          height={layout.height}
          aria-hidden="true"
        >
          <defs>
            {edgeStatuses.map((status) => (
              <marker
                key={status}
                id={`${markers}-${status}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                markerUnits="userSpaceOnUse"
                orient="auto-start-reverse"
              >
                <path d="M0,1 L10,5 L0,9 z" className={edgeTone[status].fill} />
              </marker>
            ))}
          </defs>
          {layout.links.map(({ edge, path }) => (
            <path
              key={`${edge.kind}:${edge.from}:${edge.to}`}
              d={path}
              fill="none"
              strokeWidth={edge.status === "broken" ? 2 : 1.5}
              strokeDasharray={edge.kind === "name" ? "2 4" : undefined}
              strokeLinecap="round"
              markerEnd={`url(#${markers}-${edge.status})`}
              className={cn(
                "transition-opacity",
                edgeTone[edge.status].stroke,
                lit && !(lit.has(edge.from) && lit.has(edge.to)) && "opacity-15",
              )}
            />
          ))}
        </svg>
        {layout.nodes.map((placed) => (
          <ReferenceBox
            key={placed.node.id}
            data={data}
            placed={placed}
            selected={placed.node.id === selected}
            faded={lit ? !lit.has(placed.node.id) : false}
            onHover={(on) => setHover(on ? placed.node.id : null)}
            onSelect={() => onSelect(placed.node.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ReferenceBox({
  data,
  placed,
  selected,
  faded,
  onHover,
  onSelect,
}: {
  data: StudioReferences;
  placed: PlacedReference;
  selected: boolean;
  faded: boolean;
  onHover: (on: boolean) => void;
  onSelect: () => void;
}) {
  const { node } = placed;
  const failing = isBroken(node) || isOverBudget(node, data.budget);
  return (
    <button
      type="button"
      aria-pressed={selected}
      title={node.id}
      onClick={onSelect}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
      style={{ left: placed.x, top: placed.y, width: placed.w, height: placed.h }}
      className={cn(
        "absolute flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-paper px-2.5 text-left transition-opacity hover:border-rule",
        failing && "border-outcome-failed",
        selected && "border-signal-t ring-1 ring-signal-t",
        faded && "opacity-40",
      )}
    >
      <Icon
        icon={referenceKindIcon[node.kind]}
        size={16}
        className={failing ? "text-outcome-failed" : "text-muted"}
      />
      <span className="flex min-w-0 flex-col">
        <span className={cn("truncate text-sm font-medium", node.kind !== "task" && "font-mono")}>
          {node.label}
        </span>
        <span className="truncate text-2xs text-muted">{referenceMeta(node, data)}</span>
      </span>
    </button>
  );
}
