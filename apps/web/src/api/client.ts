import { reportClientError, requestId } from "./clientLog";
import { authMode, identityHeaders, signInUrl } from "./session";

/** A failed API call; `message` is the server's `detail` made readable. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The server's `detail` as one readable line, or `fallback` when it carries none. */
export function detailText(detail: unknown, fallback: string): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => (item && typeof item === "object" && "msg" in item ? String(item.msg) : ""))
      .filter(Boolean);
    if (messages.length) return messages.join("; ");
  } else if (detail && typeof detail === "object" && "message" in detail) {
    const message = String(detail.message ?? "").trim();
    if (message) return message;
  }
  return fallback;
}

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
};

/**
 * Calls the orchestrator API as the current operator, with the tab's request id. A signed-out
 * session goes to the extension's sign-in page when it has one; server errors and network failures
 * are reported.
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, signal } = options;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Request-Id": requestId(),
    ...identityHeaders(),
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (!signal?.aborted) {
      reportClientError({
        kind: "api",
        message: `${method} ${path}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    throw error;
  }
  if (response.status >= 500) {
    reportClientError({ kind: "api", message: `${method} ${path} ${response.status}` });
  }
  const signIn = response.status === 401 && authMode() !== "compat-cookie" ? signInUrl() : null;
  if (signIn) {
    window.location.assign(signIn);
  }
  if (!response.ok) {
    let detail: unknown = null;
    try {
      detail = ((await response.json()) as { detail?: unknown }).detail;
    } catch {
      // Not JSON; the status text stands in.
    }
    throw new ApiError(
      response.status,
      detailText(detail, response.statusText || `HTTP ${response.status}`),
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
