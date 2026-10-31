import type { CatalogServer } from "../../api/types/admin";
import type { RemoteServerDraft } from "./types";

/** How a remote server added on this box gets its OAuth client: none, registered at sign-in, or configured. */
export const OAUTH_STRATEGIES = [
  "none",
  "dynamic",
  "configured",
] as const satisfies readonly CatalogServer["oauth_strategy"][];

/** Whether a picked value is one of the OAuth strategies a catalog server takes. */
export function isOAuthStrategy(value: string): value is CatalogServer["oauth_strategy"] {
  return OAUTH_STRATEGIES.some((strategy) => strategy === value);
}

/** The form of a remote server not added yet: blank, signing in with a token. */
export const emptyRemoteServerDraft: RemoteServerDraft = {
  slug: "",
  display_name: "",
  url: "",
  auth: "token",
  oauth_strategy: "none",
  description: "",
  limitations: "",
  setup_hint: "",
};

/** A remote server's fields as its edit form holds them; an absent value is empty text. */
export function remoteServerDraft(
  server: Pick<CatalogServer, keyof RemoteServerDraft>,
): RemoteServerDraft {
  return {
    slug: server.slug,
    display_name: server.display_name,
    url: server.url ?? "",
    auth: server.auth,
    oauth_strategy: server.oauth_strategy,
    description: server.description,
    limitations: server.limitations ?? "",
    setup_hint: server.setup_hint ?? "",
  };
}

/** How a new login starts a catalog tool: as its connector says, on, or off. */
export const TOOL_STARTS = ["manifest", "on", "off"] as const;

export type ToolStart = (typeof TOOL_STARTS)[number];

/** Whether a picked value is one of the ways a new login starts a catalog tool. */
export function isToolStart(value: string): value is ToolStart {
  return TOOL_STARTS.some((start) => start === value);
}
