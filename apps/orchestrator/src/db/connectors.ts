import type { InferSelectModel } from "drizzle-orm";
import { loadConnector, type LoadedConnector } from "../connectors/load.js";
import { tableColumns } from "./columns.js";
import { RowMissing } from "./errors.js";
import { isPlainRecord, jsonObj } from "./json.js";
import { type Queryable, stamp, withTransaction } from "./pg.js";
import { connectors, type Manifest, type Overrides } from "./schema/index.js";

/** A `connectors` row as stored: the manifest a folder, the registry, or the Admin form wrote. */
export type ConnectorRow = InferSelectModel<typeof connectors>;

export type NewConnector = {
  id: string;
  slug: string;
  toolPrefix: string;
  ownerOrgId: string | null;
  manifest: Manifest;
  source: string;
  version?: string;
  verified: boolean;
  experimental?: boolean;
  publisher: string;
  enabled: boolean;
};

export type ConnectorPatch = {
  slug?: string;
  manifest?: Manifest;
  overrides?: Overrides;
  enabled?: boolean;
  version?: string;
  verified?: boolean;
  experimental?: boolean;
  publisher?: string;
};

const CONNECTOR_COLUMNS = tableColumns(connectors);

/**
 * The connectors an organisation sees, loaded with their overrides, by slug: the platform's,
 * and with `orgId` that organisation's own. Without one, the platform's alone.
 */
export async function listMcpServers(
  pool: Queryable,
  orgId: string | null = null,
): Promise<LoadedConnector[]> {
  const result = await pool.query<ConnectorRow>(
    `SELECT ${CONNECTOR_COLUMNS}
     FROM connectors
     WHERE owner_org_id IS NULL OR owner_org_id = $1
     ORDER BY slug`,
    [orgId],
  );
  return result.rows.map((row) => loadConnector(row));
}

export async function getMcpServer(
  pool: Queryable,
  serverId: string,
): Promise<LoadedConnector | null> {
  const result = await pool.query<ConnectorRow>(
    `SELECT ${CONNECTOR_COLUMNS}
     FROM connectors
     WHERE id = $1`,
    [serverId],
  );
  const row = result.rows[0] ?? null;
  return row === null ? null : loadConnector(row);
}

/** The connector an organisation sees under a slug: the platform's, or with `orgId` its own. */
export async function getMcpServerBySlug(
  pool: Queryable,
  slug: string,
  orgId: string | null = null,
): Promise<LoadedConnector | null> {
  const result = await pool.query<ConnectorRow>(
    `SELECT ${CONNECTOR_COLUMNS}
     FROM connectors
     WHERE slug = $1 AND (owner_org_id IS NULL OR owner_org_id = $2)
     ORDER BY owner_org_id NULLS FIRST
     LIMIT 1`,
    [slug, orgId],
  );
  const row = result.rows[0] ?? null;
  return row === null ? null : loadConnector(row);
}

/** Stores the OAuth client a server's `config.oauth_client` carries: the one registered with its authorization server. */
export async function updateMcpServerConfig(
  pool: Queryable,
  serverId: string,
  config: unknown,
  now: Date,
): Promise<LoadedConnector | null> {
  const parsed = jsonObj(config);
  const client = isPlainRecord(parsed) ? (parsed.oauth_client ?? null) : null;
  const result = await pool.query<ConnectorRow>(
    `UPDATE connectors
     SET oauth_client = $2::jsonb, updated_at = $3
     WHERE id = $1
     RETURNING ${CONNECTOR_COLUMNS}`,
    [serverId, client === null ? null : JSON.stringify(client), stamp(now)],
  );
  const row = result.rows[0] ?? null;
  return row === null ? null : loadConnector(row);
}

/** Who holds a slug: the platform (null) or each organisation that added a server under it. */
export async function listConnectorSlugOwners(
  pool: Queryable,
  slug: string,
): Promise<Array<string | null>> {
  const result = await pool.query<{ owner_org_id: string | null }>(
    `SELECT owner_org_id FROM connectors WHERE slug = $1`,
    [slug],
  );
  return result.rows.map((row) => row.owner_org_id);
}

/** Calls an organisation made on a connector's platform login in one month (`YYYY-MM`). */
export async function countConnectorCalls(
  pool: Queryable,
  orgId: string,
  connectorId: string,
  month: string,
): Promise<number> {
  const result = await pool.query<{ calls: number }>(
    `SELECT calls FROM connector_calls WHERE org_id = $1 AND connector_id = $2 AND month = $3`,
    [orgId, connectorId, month],
  );
  return result.rows[0]?.calls ?? 0;
}

export async function recordConnectorCall(
  pool: Queryable,
  orgId: string,
  connectorId: string,
  month: string,
  now: Date,
): Promise<void> {
  await pool.query(
    `INSERT INTO connector_calls (org_id, connector_id, month, calls, updated_at)
     VALUES ($1, $2, $3, 1, $4)
     ON CONFLICT (org_id, connector_id, month)
     DO UPDATE SET calls = connector_calls.calls + 1, updated_at = EXCLUDED.updated_at`,
    [orgId, connectorId, month, stamp(now)],
  );
}

/** An organisation's counted calls in one month, by connector slug. */
export async function listConnectorCalls(
  pool: Queryable,
  orgId: string,
  month: string,
): Promise<Record<string, number>> {
  const result = await pool.query<{ slug: string; calls: number }>(
    `SELECT c.slug, k.calls
     FROM connector_calls k JOIN connectors c ON c.id = k.connector_id
     WHERE k.org_id = $1 AND k.month = $2`,
    [orgId, month],
  );
  return Object.fromEntries(result.rows.map((row) => [row.slug, row.calls]));
}

export async function countOrgConnectors(pool: Queryable, orgId: string): Promise<number> {
  const result = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM connectors WHERE owner_org_id = $1`,
    [orgId],
  );
  return result.rows[0]?.n ?? 0;
}

/** Removes a connector with its logins, their listed tools, and the bindings on them. */
export async function deleteConnector(pool: Queryable, serverId: string): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const tools = await client.query<{ namespaced_name: string }>(
      `SELECT namespaced_name FROM mcp_tools WHERE mcp_server_id = $1`,
      [serverId],
    );
    await client.query(
      `DELETE FROM bindings
       WHERE (catalog_kind = 'mcp' AND catalog_id = $1)
          OR (catalog_kind = 'mcp_tool' AND catalog_id = ANY($2::text[]))`,
      [serverId, tools.rows.map((row) => row.namespaced_name)],
    );
    const deleted = await client.query(`DELETE FROM connectors WHERE id = $1`, [serverId]);
    return (deleted.rowCount ?? 0) > 0;
  });
}

/** Inserts a connector row: a server created by hand, or one a registry install writes. */
export async function insertConnector(
  pool: Queryable,
  connector: NewConnector,
  now: Date,
): Promise<LoadedConnector> {
  const result = await pool.query<ConnectorRow>(
    `INSERT INTO connectors (
       id, slug, tool_prefix, owner_org_id, manifest, source, version, verified, publisher, enabled,
       oauth_client, overrides, installed_at, updated_at, experimental
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, NULL, '{}'::jsonb, $11, $11, $12)
     RETURNING ${CONNECTOR_COLUMNS}`,
    [
      connector.id,
      connector.slug,
      connector.toolPrefix,
      connector.ownerOrgId,
      JSON.stringify(connector.manifest),
      connector.source,
      connector.version ?? "",
      connector.verified,
      connector.publisher,
      connector.enabled,
      stamp(now),
      connector.experimental ?? false,
    ],
  );
  const inserted = result.rows[0] ?? null;
  if (!inserted) {
    throw new RowMissing("connector insert failed");
  }
  return loadConnector(inserted);
}

/** Updates a connector's manifest and where it came from (a folderless row), its overrides, or its switch. */
export async function updateConnector(
  pool: Queryable,
  serverId: string,
  patch: ConnectorPatch,
  now: Date,
): Promise<LoadedConnector | null> {
  const result = await pool.query<ConnectorRow>(
    `UPDATE connectors SET
       slug = COALESCE($2, slug),
       manifest = COALESCE($3::jsonb, manifest),
       overrides = COALESCE($4::jsonb, overrides),
       enabled = COALESCE($5, enabled),
       version = COALESCE($7, version),
       verified = COALESCE($8, verified),
       publisher = COALESCE($9, publisher),
       experimental = COALESCE($10, experimental),
       updated_at = $6
     WHERE id = $1
     RETURNING ${CONNECTOR_COLUMNS}`,
    [
      serverId,
      patch.slug ?? null,
      patch.manifest === undefined ? null : JSON.stringify(patch.manifest),
      patch.overrides === undefined ? null : JSON.stringify(patch.overrides),
      patch.enabled ?? null,
      stamp(now),
      patch.version ?? null,
      patch.verified ?? null,
      patch.publisher ?? null,
      patch.experimental ?? null,
    ],
  );
  const row = result.rows[0] ?? null;
  return row === null ? null : loadConnector(row);
}

export async function listTakenToolPrefixes(pool: Queryable): Promise<string[]> {
  const result = await pool.query<{ tool_prefix: string }>(`SELECT tool_prefix FROM connectors`);
  return result.rows.map((row) => row.tool_prefix);
}
