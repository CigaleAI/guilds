/**
 * What a proxy that forwards a request to another server leaves out: the headers that belong to
 * one connection, never to the request it carries.
 */
export const HOP_REQ = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
]);

/** The headers of an upstream answer a proxy does not pass on, since it sends the body itself. */
export const HOP_RESP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
]);

/** The WebSocket URL of an HTTP URL: `ws:` for `http:`, `wss:` for `https:`. */
export function wsUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** `headers` without the ones `excluded` names, each as one string. */
export function filterHeaders(
  headers: Record<string, string | string[] | undefined>,
  excluded: Set<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || excluded.has(key.toLowerCase())) {
      continue;
    }
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}
