import { ChevronRight } from "lucide-react";
import { useState, type ComponentProps } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";

/** Strings longer than this show their start until opened. */
const longString = 160;

export type JsonTreeProps = Omit<ComponentProps<"div">, "children"> & {
  value: unknown;
  /** Levels open at first; deeper objects and lists start folded. */
  openDepth?: number;
};

function summary(value: object): string {
  return Array.isArray(value)
    ? `${value.length} item${value.length === 1 ? "" : "s"}`
    : `${Object.keys(value).length} key${Object.keys(value).length === 1 ? "" : "s"}`;
}

function Scalar({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false);
  if (value === null) return <span className="text-muted">null</span>;
  if (typeof value === "string") {
    const long = value.length > longString;
    return (
      <span className="text-tide-t">
        "{long && !open ? `${value.slice(0, longString)}…` : value}"
        {long ? (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="ml-1.5 cursor-pointer text-2xs text-muted underline hover:text-fg"
          >
            {open ? "less" : `${value.length} chars`}
          </button>
        ) : null}
      </span>
    );
  }
  if (typeof value === "number") return <span className="text-signal-t">{value}</span>;
  if (typeof value === "boolean") return <span className="text-plum-t">{String(value)}</span>;
  return <span>{String(value)}</span>;
}

function Node({
  name,
  value,
  depth,
  openDepth,
}: {
  name: string | null;
  value: unknown;
  depth: number;
  openDepth: number;
}) {
  const nested = value !== null && typeof value === "object";
  const [open, setOpen] = useState(depth < openDepth);
  const key = name !== null ? <span className="text-fg">{name}: </span> : null;
  if (!nested) {
    return (
      <div className="pl-4 wrap-anywhere">
        {key}
        <Scalar value={value} />
      </div>
    );
  }
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value as Record<string, unknown>);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex cursor-pointer items-center gap-0.5 text-left hover:text-fg"
      >
        <Icon
          icon={ChevronRight}
          size={14}
          className={cn("shrink-0 text-muted transition-transform", open && "rotate-90")}
        />
        {key}
        <span className="text-muted">
          {Array.isArray(value) ? "[" : "{"}
          {open ? "" : ` ${summary(value)} ${Array.isArray(value) ? "]" : "}"}`}
        </span>
      </button>
      {open ? (
        <div className="ml-1.5 border-l border-line pl-2">
          {entries.map(([childName, child]) => (
            <Node
              key={childName}
              name={Array.isArray(value) ? null : childName}
              value={child}
              depth={depth + 1}
              openDepth={openDepth}
            />
          ))}
          <span className="text-muted">{Array.isArray(value) ? "]" : "}"}</span>
        </div>
      ) : null}
    </div>
  );
}

/** A JSON value as a tree: objects and lists fold, long strings shorten until opened. */
export function JsonTree({ value, openDepth = 2, className, ...props }: JsonTreeProps) {
  return (
    <div className={cn("font-mono text-xs leading-5 text-fg-2", className)} {...props}>
      <Node name={null} value={value} depth={0} openDepth={openDepth} />
    </div>
  );
}
