import type { OrgServerInput } from "../../api/types/access";

/** How a remote MCP server signs in: none, an API key or token, or OAuth at the server. */
export const REMOTE_SERVER_AUTHS = [
  "none",
  "token",
  "oauth",
] as const satisfies readonly OrgServerInput["auth"][];

/** Whether a picked value is one of the ways a remote MCP server signs in. */
export function isRemoteServerAuth(value: string): value is OrgServerInput["auth"] {
  return REMOTE_SERVER_AUTHS.some((auth) => auth === value);
}
