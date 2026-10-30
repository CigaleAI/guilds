import type { IncomingHttpHeaders } from "node:http";

/** A request as a reader of its headers sees it. */
export type RequestWithHeaders = {
  headers: IncomingHttpHeaders;
};

/** The request's cookies by name, values decoded. */
export function requestCookies(request: RequestWithHeaders): Record<string, string> {
  const raw = request.headers.cookie;
  const header = Array.isArray(raw) ? raw.join("; ") : raw;
  const out: Record<string, string> = {};
  if (!header) {
    return out;
  }
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    out[key] = decodeURIComponent(value);
  }
  return out;
}

/** Whether cookies this server sets carry `Secure`: it is reached over HTTPS. */
export function cookieSecure(publicBaseUrl: string): boolean {
  return publicBaseUrl.startsWith("https://");
}
