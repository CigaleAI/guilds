export const LIST_DEFAULT = 15;
export const LIST_CAP = 30;

export function pythonG(value: number, precision: number): string {
  if (value === 0) {
    return "0";
  }
  const sign = value < 0 ? "-" : "";
  let abs = Math.abs(value);
  let exp = Math.floor(Math.log10(abs));
  const factor = 10 ** (precision - 1 - exp);
  abs = Math.round(abs * factor) / factor;
  if (abs > 0) {
    exp = Math.floor(Math.log10(abs));
  }
  const scientific = exp < -4 || exp >= precision;
  if (scientific) {
    const mantissa = abs / 10 ** exp;
    const decimals = Math.max(0, precision - 1);
    const body = mantissa.toFixed(decimals).replace(/\.?0+$/, "");
    const expSign = exp >= 0 ? "+" : "-";
    const expBody = String(Math.abs(exp)).padStart(2, "0");
    return `${sign}${body}e${expSign}${expBody}`;
  }
  const decimals = Math.max(0, precision - exp - 1);
  return sign + abs.toFixed(decimals).replace(/\.?0+$/, "");
}

export function fmtNum(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "string") {
    const stripped = value.trim();
    if (!stripped) {
      return "-";
    }
    const numeric = Number(stripped.replaceAll(",", "").replaceAll("$", "").replaceAll("%", ""));
    if (!Number.isNaN(numeric)) {
      return fmtNum(numeric);
    }
    return stripped;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value === 0) {
      return "0";
    }
    const magnitude = Math.abs(value);
    if (magnitude >= 1_000_000 || magnitude < 0.001) {
      return pythonG(value, 4);
    }
    return pythonG(value, 6);
  }
  return String(value);
}

export function clipRows(rows: string[], limit: number): string {
  if (!rows.length) {
    return "no results";
  }
  const shown = rows.slice(0, limit);
  const extra = rows.length - shown.length;
  if (extra > 0) {
    shown.push(`+${extra} more`);
  }
  return shown.join("\n");
}

/** Whitespace-collapsed text cut to `limit` with an ellipsis. */
export function clipText(value: unknown, limit: number): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

export function joinParts(...parts: unknown[]): string {
  const values: string[] = [];
  for (const part of parts) {
    if (part === null || part === undefined) {
      continue;
    }
    const text = String(part).trim();
    if (text) {
      values.push(text);
    }
  }
  return values.join("  ");
}

export function argStr(arguments_: Record<string, unknown>, key: string, fallback = ""): string {
  const value = arguments_[key] ?? fallback;
  if (value === null || value === undefined) {
    return fallback;
  }
  return String(value).trim();
}

export function argInt(arguments_: Record<string, unknown>, key: string, fallback: number): number {
  const value = arguments_[key] ?? fallback;
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) {
    return fallback;
  }
  return Number.parseInt(text, 10);
}

export function rowLimit(arguments_: Record<string, unknown>): number {
  return Math.max(1, Math.min(LIST_CAP, argInt(arguments_, "limit", LIST_DEFAULT)));
}

export function pythonRound(value: number): number {
  const floor = Math.floor(value);
  const frac = value - floor;
  if (frac < 0.5) {
    return floor;
  }
  if (frac > 0.5) {
    return floor + 1;
  }
  return floor % 2 === 0 ? floor : floor + 1;
}

export function downsample<T>(points: T[], count = 48): T[] {
  if (count <= 0 || points.length <= count) {
    return points;
  }
  if (count === 1) {
    return [points[points.length - 1]!];
  }
  const step = (points.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, index) => points[pythonRound(index * step)]!);
}

export function tsSec(value: unknown): string {
  const stamp = Number(value);
  if (!Number.isFinite(stamp)) {
    return "-";
  }
  let seconds = Math.trunc(stamp);
  if (seconds > 10_000_000_000) {
    seconds = Math.trunc(seconds / 1000);
  }
  return String(seconds);
}
