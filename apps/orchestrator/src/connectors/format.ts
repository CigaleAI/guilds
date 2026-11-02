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

/** A finite number in six significant digits, four from a million up and under a thousandth. */
function fmtFinite(value: number): string {
  if (value === 0) {
    return "0";
  }
  const magnitude = Math.abs(value);
  return pythonG(value, magnitude >= 1_000_000 || magnitude < 0.001 ? 4 : 6);
}

/**
 * A number as a provider sends it, as a number or as text, in six significant digits: text reads
 * as one without its commas, `$` and `%`. `-` when it is absent or blank; text that reads as no
 * finite number, trimmed.
 */
export function fmtNum(value: string | number | null | undefined): string {
  const text = String(value ?? "").trim();
  if (!text) {
    return "-";
  }
  const numeric = Number(text.replaceAll(",", "").replaceAll("$", "").replaceAll("%", ""));
  return Number.isFinite(numeric) ? fmtFinite(numeric) : text;
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

/** Whitespace-collapsed text cut to `limit` with an ellipsis; empty when there is none. */
export function clipText(value: string | undefined, limit: number): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

/** The parts of a row that are present, a number as it is and text trimmed, two spaces apart; a blank part is left out. */
export function joinParts(...parts: Array<string | number | null | undefined>): string {
  return parts
    .map((part) => part?.toString().trim() ?? "")
    .filter(Boolean)
    .join("  ");
}

/** The first of the texts that is not blank, trimmed: an argument's spellings, then its default; empty when none is. */
export function given(...texts: Array<string | undefined>): string {
  for (const text of texts) {
    const trimmed = text?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return "";
}

/** The rows a list shows for a call's `limit`: `LIST_DEFAULT` when it is absent, kept between 1 and `LIST_CAP`. */
export function listRows(limit: number | undefined): number {
  return Math.max(1, Math.min(LIST_CAP, limit ?? LIST_DEFAULT));
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

/** A timestamp in whole seconds: one in milliseconds is cut to seconds; `-` when it is not finite. */
export function tsSec(value: number): string {
  if (!Number.isFinite(value)) {
    return "-";
  }
  let seconds = Math.trunc(value);
  if (seconds > 10_000_000_000) {
    seconds = Math.trunc(seconds / 1000);
  }
  return String(seconds);
}
