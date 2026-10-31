/**
 * Reports the page's failures to the orchestrator (`POST /api/client-errors`): uncaught errors,
 * unhandled rejections, React render errors, and API calls that fail on the server or the network.
 * Each tab carries one request id, sent with every API call so server logs line up with its
 * reports. Reports are deduplicated for 30 s and capped at 10 a minute.
 */

const storageKey = "guilds-request-id";
const endpoint = "/api/client-errors";
const maxPerMinute = 10;
const dedupeMs = 30_000;

let tabId: string | null = null;
const sentAt: number[] = [];
const recent = new Map<string, number>();

/** The request id this tab stored; null when it stored none or session storage is unavailable. */
export function storedRequestId(): string | null {
  try {
    return sessionStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

/** Keeps a request id in session storage for the tab's life; false when storage is unavailable. */
export function storeRequestId(id: string): boolean {
  try {
    sessionStorage.setItem(storageKey, id);
    return true;
  } catch {
    return false;
  }
}

/** This tab's request id, kept for the tab's life; without session storage, for the page's. */
export function requestId(): string {
  if (tabId) return tabId;
  tabId = storedRequestId();
  if (tabId) return tabId;
  tabId = crypto.randomUUID();
  storeRequestId(tabId);
  return tabId;
}

export type ClientReport = {
  /** `onerror`, `unhandledrejection`, `react` or `api`. */
  kind: string;
  message: string;
  stack?: string | undefined;
};

function allowed(report: ClientReport, now: number): boolean {
  const key = `${report.kind}|${report.message}|${(report.stack ?? "").slice(0, 200)}`;
  const last = recent.get(key);
  if (last !== undefined && now - last < dedupeMs) return false;
  recent.set(key, now);
  while (sentAt.length && now - (sentAt[0] ?? 0) > 60_000) sentAt.shift();
  if (sentAt.length >= maxPerMinute) return false;
  sentAt.push(now);
  return true;
}

/** Sends one report, unless it repeats a recent one or the minute's quota is spent. */
export function reportClientError(report: ClientReport): void {
  if (report.message === "Script error." && !report.stack) return;
  if (!allowed(report, Date.now())) return;
  const body = JSON.stringify({
    kind: report.kind,
    message: report.message.slice(0, 500),
    stack: (report.stack ?? "").slice(0, 4000),
    href: window.location.href.slice(0, 500),
    request_id: requestId(),
  });
  void deliverReport(body);
}

/** Posts a report; resolves whether the orchestrator took it, false when the request failed. */
export async function deliverReport(body: string): Promise<boolean> {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-Id": requestId() },
      body,
      keepalive: true,
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** The report for anything thrown. */
export function reportThrown(kind: string, error: unknown): void {
  reportClientError({
    kind,
    message: error instanceof Error ? error.message : String(error ?? kind),
    stack: error instanceof Error ? error.stack : undefined,
  });
}

/** Reports what escapes the page's own handling: uncaught errors and unhandled rejections. */
export function installClientLog(): void {
  window.addEventListener("error", (event) => {
    reportClientError({
      kind: "onerror",
      message:
        event.message || (event.error instanceof Error ? event.error.message : "client error"),
      stack: event.error instanceof Error ? event.error.stack : undefined,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportThrown("unhandledrejection", event.reason);
  });
}
