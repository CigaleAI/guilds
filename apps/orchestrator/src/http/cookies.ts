import type { IncomingHttpHeaders } from "node:http";

/** A request as a reader of its headers sees it. */
export type RequestWithHeaders = {
  headers: IncomingHttpHeaders;
};

/** The request's cookie `name`, decoded; the last one when it is sent more than once. */
export function requestCookie(request: RequestWithHeaders, name: string): string | undefined {
  const raw = request.headers.cookie;
  const header = Array.isArray(raw) ? raw.join("; ") : raw;
  let value: string | undefined;
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index !== -1 && part.slice(0, index).trim() === name) {
      value = decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return value;
}

/** Whether cookies this server sets carry `Secure`: it is reached over HTTPS. */
export function cookieSecure(publicBaseUrl: string): boolean {
  return publicBaseUrl.startsWith("https://");
}
