export function parseInt8(value: string): number {
  if (!/^-?\d+$/.test(value)) {
    throw new RangeError(`int8 is not an integer: ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`int8 exceeds Number.MAX_SAFE_INTEGER: ${value}`);
  }
  return parsed;
}

const OFFSET = /([+-])(\d{2})(?::?(\d{2}))?$/;

export function formatColumnTimestamp(value: string): string {
  const normalized = normalizeTimestamp(value);
  return toOffsetIso(normalized, "offset");
}

/** Lexicographic order of these strings matches chronological order, including short fractions. */
export function sortableColumnTimestamp(value: string): string {
  return formatColumnTimestamp(value).replace(
    /(\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2}:\d{2})$/,
    (_all, hms: string, frac: string | undefined, off: string) =>
      `${hms}.${(frac ?? ".").slice(1).padEnd(6, "0")}${off}`,
  );
}

export function compareColumnTimestamps(left: string, right: string): number {
  return sortableColumnTimestamp(left).localeCompare(sortableColumnTimestamp(right));
}

export function formatOperationalTimestamp(value: string): string {
  return formatColumnTimestamp(value).replace("+00:00", "Z").replace("-00:00", "Z");
}

export function utcIso(value: string): string {
  const date = stripFraction(normalizeTimestamp(value));
  return `${date.slice(0, 19)}Z`;
}

export function utcStamp(value: string): string {
  return utcIso(value).replaceAll(":", "-");
}

function stripFraction(iso: string): string {
  return iso.replace(/\.\d+/, "");
}

function normalizeTimestamp(value: string): string {
  let text = value.trim();
  if (text.includes(" ")) {
    text = text.replace(" ", "T");
  }
  text = text.replace(/([+-]\d{2})$/, "$1:00");
  text = text.replace(/Z$/, "+00:00");
  return text;
}

function toOffsetIso(value: string, _mode: "offset"): string {
  const match = OFFSET.exec(value);
  if (!match) {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) {
      return `${value}+00:00`;
    }
    return value;
  }
  const sign = match[1] ?? "+";
  const hours = match[2] ?? "00";
  const minutes = match[3] ?? "00";
  const head = value.slice(0, match.index);
  const fractionMatch = /\.(\d+)$/.exec(head);
  const fraction = fractionMatch?.[1];
  if (fractionMatch && fraction && fraction === "0".repeat(fraction.length)) {
    return `${head.slice(0, fractionMatch.index)}${sign}${hours}:${minutes}`;
  }
  return `${head}${sign}${hours}:${minutes}`;
}
