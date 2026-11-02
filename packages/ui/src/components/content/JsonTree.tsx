import { ChevronRight } from "lucide-react";
import { useState, type ComponentProps } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";

/** A value JSON carries: a string, number, boolean or null, or an array or object of them. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** A JSON object. A field held as `undefined` is one JSON leaves out. */
export type JsonObject = { [key: string]: JsonValue | undefined };

/** A JSON value the tree folds: an array or an object. */
type JsonBranch = JsonValue[] | JsonObject;

/** A JSON value the tree shows on one line: a string, number, boolean or null. */
type JsonLeaf = Exclude<JsonValue, JsonBranch>;

/** Strings longer than this show their start until opened. */
const longString = 160;

export type JsonTreeProps = Omit<ComponentProps<"div">, "children"> & {
  /** The value to show, as JSON parses it; a value JSON cannot carry shows nothing. */
  value: unknown;
  /** Levels open at first; deeper objects and lists start folded. */
  openDepth?: number;
};

/** Whether a value is one JSON carries, every element and field of it included. */
function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

/** Whether a value is a JSON object: a plain object, every field of it a JSON value or left out. */
function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((field) => field === undefined || isJsonValue(field));
}

/** Whether a JSON value shows on one line rather than folding. */
function isJsonLeaf(value: JsonValue): value is JsonLeaf {
  return value === null || typeof value !== "object";
}

/** Whether a JSON value on one line is a string. */
function isJsonString(value: JsonLeaf): value is string {
  return typeof value === "string";
}

/** A branch's children with the name each shows: an array's index, an object's field. */
function branchEntries(value: JsonBranch): [string, JsonValue][] {
  if (Array.isArray(value)) return value.map((item, index) => [String(index), item]);
  return Object.entries(value).flatMap<[string, JsonValue]>(([name, field]) =>
    field === undefined ? [] : [[name, field]],
  );
}

function summary(value: JsonBranch): string {
  const count = branchEntries(value).length;
  return Array.isArray(value)
    ? `${count} item${count === 1 ? "" : "s"}`
    : `${count} key${count === 1 ? "" : "s"}`;
}

function Scalar({ value }: { value: JsonLeaf }) {
  const [open, setOpen] = useState(false);
  if (value === null) return <span className="text-muted">null</span>;
  if (value === true || value === false) {
    return <span className="text-plum-t">{String(value)}</span>;
  }
  if (isJsonString(value)) {
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
  return <span className="text-signal-t">{value}</span>;
}

function Node({
  name,
  value,
  depth,
  openDepth,
}: {
  name: string | null;
  value: JsonValue;
  depth: number;
  openDepth: number;
}) {
  const [open, setOpen] = useState(depth < openDepth);
  const key = name !== null ? <span className="text-fg">{name}: </span> : null;
  if (isJsonLeaf(value)) {
    return (
      <div className="pl-4 wrap-anywhere">
        {key}
        <Scalar value={value} />
      </div>
    );
  }
  const list = Array.isArray(value);
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
          {list ? "[" : "{"}
          {open ? "" : ` ${summary(value)} ${list ? "]" : "}"}`}
        </span>
      </button>
      {open ? (
        <div className="ml-1.5 border-l border-line pl-2">
          {branchEntries(value).map(([childName, child]) => (
            <Node
              key={childName}
              name={list ? null : childName}
              value={child}
              depth={depth + 1}
              openDepth={openDepth}
            />
          ))}
          <span className="text-muted">{list ? "]" : "}"}</span>
        </div>
      ) : null}
    </div>
  );
}

/** A JSON value as a tree: objects and lists fold, long strings shorten until opened. */
export function JsonTree({ value, openDepth = 2, className, ...props }: JsonTreeProps) {
  return (
    <div className={cn("font-mono text-xs leading-5 text-fg-2", className)} {...props}>
      {isJsonValue(value) ? (
        <Node name={null} value={value} depth={0} openDepth={openDepth} />
      ) : null}
    </div>
  );
}
