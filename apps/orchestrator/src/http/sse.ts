const FLOAT_KEYS = new Set(["cost_usd"]);

export function dumpsSse(value: unknown): string {
  return encodeValue(value);
}

function encodeValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (value === true) {
    return "true";
  }
  if (value === false) {
    return "false";
  }
  if (typeof value === "number") {
    return encodeNumber(value);
  }
  if (typeof value === "string") {
    return encodeString(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(encodeValue).join(", ")}]`;
  }
  if (typeof value === "object") {
    const parts: string[] = [];
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) {
        continue;
      }
      parts.push(`${encodeString(key)}: ${encodeEntryValue(key, item)}`);
    }
    return `{${parts.join(", ")}}`;
  }
  return encodeString(String(value));
}

/** A number under a key listed in FLOAT_KEYS is written as a float even when it is whole. */
function encodeEntryValue(key: string, item: unknown): string {
  if (typeof item === "number" && FLOAT_KEYS.has(key)) {
    return encodeFloat(item);
  }
  return encodeValue(item);
}

function encodeNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return encodeFloat(value);
}

/** Writes a number with a fraction or exponent so a reader parses it as a float. */
function encodeFloat(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError("sse json cannot encode non-finite numbers");
  }
  const raw = JSON.stringify(value);
  if (raw.includes(".") || raw.includes("e") || raw.includes("E")) {
    return raw;
  }
  return `${raw}.0`;
}

function encodeString(value: string): string {
  const json = JSON.stringify(value);
  return json.replace(/[\u007f-\uffff]/g, (char) => {
    const code = char.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${code}`;
  });
}

export function frameSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${dumpsSse(data)}\n\n`;
}

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;
