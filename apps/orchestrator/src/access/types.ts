import type { agentDetail } from "../agents/view.js";
import type { ConnectorFacts, LoadedConnector } from "../connectors/servers.js";
import type { McpConnectionRow } from "../db/mcp.js";
import type { SecretRef } from "../db/schema/index.js";
import type { oauthSetupState } from "../oauth/index.js";
import type { ListedToolFields, Overlay, Resolved } from "./index.js";

/**
 * A catalog item as an access view shows it: whether it is on, the scope whose binding decided
 * that (null when none does), and the viewed scope's own binding when it has one.
 */
export type AccessBinding = Pick<Resolved, "enabled" | "source_scope"> & {
  name: string;
  overlay: Pick<Overlay, "enabled"> | null;
};

/** A tool a connector lists, as an access view shows it: its binding state and what the listing says of it. */
export type McpToolAccess = AccessBinding & Pick<ListedToolFields, "remote_name" | "description" | "input_schema">;

/**
 * A connector as an access view shows it: the server, whether it is on for the scope and through
 * which login, that login's state and settings, and the tools it lists.
 */
export type McpServerAccess = Pick<Resolved, "enabled" | "source_scope" | "connection_id"> &
  Pick<LoadedConnector, "id" | "slug" | "auth" | "description" | "limitations" | "setup_hint" | "oauth_strategy"> &
  ConnectorFacts & {
    name: LoadedConnector["display_name"];
    oauth_setup_state: ReturnType<typeof oauthSetupState>;
    /** Whether the connector is on for this box. */
    catalog_enabled: boolean;
    /** A remote server an organisation added of its own. */
    org_owned: boolean;
    status: McpConnectionRow["status"] | null;
    account_hint: McpConnectionRow["account_hint"];
    /** Which scope's login the scope uses: its own, or one it inherits. */
    connection_owner_scope: McpConnectionRow["owner_scope"] | null;
    overlay: Pick<Overlay, "enabled" | "connection_id"> | null;
    tools: McpToolAccess[];
    settings: McpConnectionRow["settings"];
    /** The login is signed in and connects once its settings are saved. */
    needs_settings: boolean;
  };

/** The native tools and connectors a scope sees, each resolved for it. */
export type AccessView = {
  tools: AccessBinding[];
  mcp: McpServerAccess[];
};

/** An agent as its page shows it: its detail, and its access with the secrets it reaches. */
export type AgentView = ReturnType<typeof agentDetail> & {
  access: AccessView & { secrets: SecretRef[] };
};

/** The values a run's secrets set, by environment variable name. */
export type SecretEnv = Record<string, string>;
