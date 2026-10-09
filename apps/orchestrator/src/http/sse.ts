const FLOAT_KEYS = new Set(["cost_usd"]);

export function dumpsSse(value: unknown): string {
  return encodeValue(value, false);
}

function encodeValue(value: unknown, asFloat: boolean): string {
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
    return encodeNumber(value, asFloat);
  }
  if (typeof value === "string") {
    return encodeString(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => encodeValue(item, false)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const parts: string[] = [];
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) {
        continue;
      }
      parts.push(`${encodeString(key)}: ${encodeValue(item, FLOAT_KEYS.has(key))}`);
    }
    return `{${parts.join(", ")}}`;
  }
  return encodeString(String(value));
}

function encodeNumber(value: number, asFloat: boolean): string {
  if (!Number.isFinite(value)) {
    throw new TypeError("sse json cannot encode non-finite numbers");
  }
  if (asFloat || !Number.isInteger(value)) {
    const raw = JSON.stringify(value);
    if (raw.includes(".") || raw.includes("e") || raw.includes("E")) {
      return raw;
    }
    return `${raw}.0`;
  }
  return String(value);
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
