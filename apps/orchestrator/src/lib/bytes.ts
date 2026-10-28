const TRUNCATION_MARKER = "\n[truncated]";

/** The text cut to `maxBytes` of UTF-8, the cut marked, and whether it was cut. */
export function capBytes(text: string, maxBytes: number): [string, boolean] {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= maxBytes) {
    return [text, false];
  }
  const marker = Buffer.from(TRUNCATION_MARKER, "utf8");
  const budget = Math.max(0, maxBytes - marker.length);
  const cut = encoded.subarray(0, budget).toString("utf8");
  return [cut + TRUNCATION_MARKER, true];
}
