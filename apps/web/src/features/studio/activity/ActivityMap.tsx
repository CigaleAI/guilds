import { useId, useMemo, useState } from "react";
import { cn, Icon, OutcomeStrip, wakeOutcomeLabel } from "@guildsrun/ui";
import {
  WAKE_BUCKETS,
  formatUsd,
  plural,
  type MapSelection,
  type OutcomeCounts,
} from "./activityModel";
import { layoutActivityMap, type PlacedMapLink, type PlacedMapNode } from "./mapLayout";
import { AgentMark, AgentName, nodeName, sourceIcon, useWidth, type ActivityData } from "./parts";

const MIN_WIDTH = 560;

function outcomeText(counts: OutcomeCounts): string {
  return WAKE_BUCKETS.filter((outcome) => counts[outcome] > 0)
    .map((outcome) => `${counts[outcome]} ${wakeOutcomeLabel[outcome]}`)
    .join(", ");
}

type ActivityMapProps = {
  data: ActivityData;
  selection: MapSelection | null;
  onSelect: (selection: MapSelection) => void;
};

/**
 * Who woke whom over the window: routines, the operator's messages and direct chats on the left,
 * agents in columns to the right, and a line for each "A woke B", thicker the more often it
 * happened. Hovering reads out its counts; clicking selects it.
 */
export function ActivityMap({ data, selection, onSelect }: ActivityMapProps) {
  const [measure, width] = useWidth();
  const [hover, setHover] = useState<MapSelection | null>(null);
  const markers = useId();
  const layout = useMemo(
    () => layoutActivityMap(data.map, Math.max(MIN_WIDTH, width)),
    [data.map, width],
  );
  const { index, map } = data;
  const name = (id: string) => nodeName(index, id);

  const touches = (focus: MapSelection, link: PlacedMapLink) =>
    focus.kind === "link"
      ? link.from === focus.from && link.to === focus.to
      : link.from === focus.id || link.to === focus.id;
  const nodeLit = (focus: MapSelection, id: string) =>
    focus.kind === "link"
      ? id === focus.from || id === focus.to
      : id === focus.id ||
        map.links.some(
          (link) =>
            (link.from === focus.id && link.to === id) ||
            (link.to === focus.id && link.from === id),
        );

  const readout = (() => {
    if (!hover) return "Hover a line or a box for its counts; click it to list those chains.";
    if (hover.kind === "link") {
      const link = map.links.find((item) => item.from === hover.from && item.to === hover.to);
      if (!link) return "";
      return `${name(link.from)} → ${name(link.to)}: ${plural(link.count, "wake")} (${outcomeText(link.counts)}) · ${formatUsd(link.cost)}`;
    }
    const node = [...map.sources, ...map.agents].find((item) => item.id === hover.id);
    if (!node) return "";
    if (node.kind !== "agent") {
      const routine = node.kind === "routine" ? index.routines.get(node.id.slice(8)) : undefined;
      const started = node.count
        ? `started ${plural(node.count, "chain")}`
        : "didn't fire in this window";
      return [name(node.id), routine?.label, started].filter(Boolean).join(" · ");
    }
    const wokenBy = map.links
      .filter((link) => link.to === node.id)
      .map((link) => `${name(link.from)} ×${link.count}`);
    const woke = map.links
      .filter((link) => link.from === node.id)
      .map((link) => `${name(link.to)} ×${link.count}`);
    return [
      `${name(node.id)}: ${plural(node.count, "wake")}${node.count ? ` (${outcomeText(node.counts)})` : ""}`,
      wokenBy.length ? `woken by ${wokenBy.join(", ")}` : null,
      woke.length ? `its posts woke ${woke.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  })();

  const selectedLink = (link: PlacedMapLink) =>
    selection?.kind === "link" && link.from === selection.from && link.to === selection.to;
  const selectedNode = (id: string) =>
    selection?.kind === "node"
      ? selection.id === id
      : selection?.kind === "link" && (selection.from === id || selection.to === id);
  const faded = (lit: boolean) => (hover ? !lit : false);

  return (
    <div className="flex flex-col gap-2">
      <div ref={measure} className="overflow-x-auto">
        <div className="relative" style={{ width: layout.width, height: layout.height }}>
          <svg
            className="absolute inset-0 overflow-visible"
            width={layout.width}
            height={layout.height}
          >
            <defs>
              {(
                [
                  ["rule", "fill-rule"],
                  ["posted", "fill-outcome-posted"],
                  ["selected", "fill-signal-t"],
                ] as const
              ).map(([key, fill]) => (
                <marker
                  key={key}
                  id={`${markers}-${key}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="9"
                  markerHeight="9"
                  markerUnits="userSpaceOnUse"
                  orient="auto-start-reverse"
                >
                  <path d="M0,1 L10,5 L0,9 z" className={fill} />
                </marker>
              ))}
            </defs>
            {[...layout.links]
              .sort((left, right) => right.count - left.count)
              .map((link) => {
                const selected = selectedLink(link);
                const tone = selected ? "selected" : link.fromAgent ? "posted" : "rule";
                const focus: MapSelection = { kind: "link", from: link.from, to: link.to };
                const labelWidth = 10 + String(link.count).length * 6.6;
                return (
                  <g
                    key={link.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`${name(link.from)} woke ${name(link.to)} ${plural(link.count, "time")}`}
                    aria-pressed={selected}
                    className={cn(
                      "cursor-pointer outline-none transition-opacity",
                      faded(hover ? touches(hover, link) : true) && "opacity-15",
                      !hover &&
                        selection &&
                        !selected &&
                        !(selection.kind === "node" && touches(selection, link)) &&
                        "opacity-40",
                    )}
                    onPointerEnter={() => setHover(focus)}
                    onPointerLeave={() => setHover(null)}
                    // A pressed SVG group takes focus by scrolling to it, which moves it from under
                    // the pointer before the click lands; keyboard focus is unaffected.
                    onMouseDown={(event) => event.preventDefault()}
                    onFocus={() => setHover(focus)}
                    onBlur={() => setHover(null)}
                    onClick={() => onSelect(focus)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(focus);
                      }
                    }}
                  >
                    <path
                      d={link.path}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={Math.max(16, link.width + 10)}
                    />
                    <path
                      d={link.path}
                      fill="none"
                      strokeWidth={link.width}
                      strokeLinecap="round"
                      markerEnd={`url(#${markers}-${tone})`}
                      className={cn(
                        selected
                          ? "stroke-signal-t"
                          : link.fromAgent
                            ? "stroke-outcome-posted opacity-80"
                            : "stroke-rule",
                      )}
                    />
                    <rect
                      x={link.label.x - labelWidth / 2}
                      y={link.label.y - 8}
                      width={labelWidth}
                      height={16}
                      rx={8}
                      className="fill-surface stroke-line"
                    />
                    <text
                      x={link.label.x}
                      y={link.label.y + 3.5}
                      textAnchor="middle"
                      className="fill-fg-2 font-mono text-[10.5px]"
                    >
                      {link.count}
                    </text>
                  </g>
                );
              })}
          </svg>
          {layout.nodes.map((node) => (
            <MapBox
              key={node.id}
              data={data}
              node={node}
              selected={selectedNode(node.id)}
              faded={faded(hover ? nodeLit(hover, node.id) : true)}
              onHover={(on) => setHover(on ? { kind: "node", id: node.id } : null)}
              onSelect={() => onSelect({ kind: "node", id: node.id })}
            />
          ))}
        </div>
      </div>
      <p className="min-h-4 text-xs text-muted" aria-live="polite">
        {readout}
      </p>
    </div>
  );
}

type MapBoxProps = {
  data: ActivityData;
  node: PlacedMapNode;
  selected: boolean;
  faded: boolean;
  onHover: (on: boolean) => void;
  onSelect: () => void;
};

function MapBox({ data, node, selected, faded, onHover, onSelect }: MapBoxProps) {
  const { index } = data;
  const idle = node.count === 0;
  const common = {
    type: "button" as const,
    onClick: onSelect,
    onPointerEnter: () => onHover(true),
    onPointerLeave: () => onHover(false),
    onFocus: () => onHover(true),
    onBlur: () => onHover(false),
    "aria-pressed": selected,
    style: { left: node.x, top: node.y, width: node.w, height: node.h },
    className: cn(
      "absolute flex cursor-pointer rounded-lg border border-line bg-paper px-2.5 text-left transition-opacity hover:border-rule",
      selected && "border-signal-t ring-1 ring-signal-t",
      idle && "opacity-55",
      faded && "opacity-40",
    ),
  };
  if (node.kind === "agent") {
    const agent = index.agents.get(node.id);
    return (
      <button {...common} className={cn(common.className, "flex-col justify-center gap-1.5")}>
        <span className="flex min-w-0 items-center gap-2">
          <AgentMark agent={agent} size={20} />
          <AgentName agent={agent} className="min-w-0 flex-1 text-sm font-medium" />
          <span className="text-xs font-semibold tabular-nums">{node.count}</span>
        </span>
        {node.count ? (
          <OutcomeStrip counts={node.counts} />
        ) : (
          <span className="text-2xs text-muted">No wakes</span>
        )}
      </button>
    );
  }
  const routine = node.kind === "routine" ? index.routines.get(node.id.slice(8)) : undefined;
  const unit = node.kind === "routine" ? "firing" : node.kind === "direct" ? "chat" : "message";
  return (
    <button {...common} className={cn(common.className, "items-center gap-2.5")}>
      <Icon icon={sourceIcon[node.kind]} size={16} className="text-muted" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{nodeName(index, node.id)}</span>
        <span className="truncate text-2xs text-muted">
          {[routine?.label, idle ? "didn't fire" : plural(node.count, unit)]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
    </button>
  );
}
