import type pg from "pg";
import { decryptPayload, encryptPayload } from "../../credentials/crypto.js";
import { newId } from "../../lib/ids.js";
import {
  DROPPED_MCP_SERVERS,
  DROPPED_NATIVE_TOOLS,
  PLATFORM_NATIVE_TOOLS,
} from "./catalog.js";
import { installedConnectors } from "../../connectors/index.js";

/**
 * Writes every installed connector's row from its folder, replacing the manifest and where it
 * came from whole; the box's state for it (its switch, its OAuth client, the admin's overrides)
 * stays. A new row takes its slug as tool prefix.
 */
export async function projectConnectors(pool: pg.Pool, now = new Date()): Promise<void> {
  const timestamp = now.toISOString();
  for (const entry of installedConnectors().entries()) {
    await pool.query(
      `
      INSERT INTO connectors (
        id, slug, tool_prefix, owner_org_id, manifest, source, version, verified, publisher, enabled,
        oauth_client, overrides, installed_at, updated_at
      )
      VALUES ($1, $2, $2, NULL, $3::jsonb, $4, '', $5, $6, TRUE, NULL, '{}'::jsonb, $7, $7)
      ON CONFLICT (id) DO UPDATE SET
        slug = EXCLUDED.slug,
        manifest = EXCLUDED.manifest,
        source = EXCLUDED.source,
        version = EXCLUDED.version,
        verified = EXCLUDED.verified,
        publisher = EXCLUDED.publisher,
        updated_at = EXCLUDED.updated_at
      `,
      [
        entry.id,
        entry.manifest.slug,
        JSON.stringify(entry.manifest),
        entry.source,
        entry.verified,
        entry.publisher,
        timestamp,
      ],
    );
  }
}

/**
 * Moves the folder a Drive login picked out of its encrypted payload into its settings, where
 * the connector's `settings_schema` names it. A login already moved, or one this box cannot
 * decrypt, is left as it is.
 */
export async function moveDriveFolders(pool: pg.Pool, now = new Date()): Promise<void> {
  const rows = await pool.query(
    `SELECT id, ciphertext, nonce FROM mcp_connections
     WHERE mcp_server_id = 'mcp_drive' AND NOT (settings ? 'folder_id')`,
  );
  for (const row of rows.rows as Array<{ id: string; ciphertext: Buffer; nonce: Buffer }>) {
    let payload: Record<string, unknown>;
    try {
      payload = decryptPayload(row.ciphertext, row.nonce);
    } catch {
      continue;
    }
    const folderId = payload.drive_folder_id;
    if (typeof folderId !== "string" || !folderId.trim()) {
      continue;
    }
    const { drive_folder_id: _id, drive_folder_name: _name, ...rest } = payload;
    const [ciphertext, nonce] = encryptPayload(rest);
    await pool.query(
      `UPDATE mcp_connections
       SET ciphertext = $2, nonce = $3,
           settings = jsonb_set(settings, '{folder_id}', to_jsonb($4::text)), updated_at = $5
       WHERE id = $1`,
      [row.id, ciphertext, nonce, folderId.trim(), now.toISOString()],
    );
  }
}

export async function seedSystem(pool: pg.Pool, now = new Date()): Promise<void> {
  const timestamp = now.toISOString();
  await projectConnectors(pool, now);
  await moveDriveFolders(pool, now);
  for (const server of DROPPED_MCP_SERVERS) {
    await pool.query(`DELETE FROM connectors WHERE id = $1`, [server.id]);
    await pool.query(
      `
      DELETE FROM bindings
      WHERE (catalog_kind = 'mcp' AND catalog_id = $1)
         OR (catalog_kind = 'mcp_tool' AND catalog_id = ANY($2::text[]))
      `,
      [server.id, server.tools],
    );
  }
  if (DROPPED_NATIVE_TOOLS.length > 0) {
    await pool.query(
      `
      DELETE FROM bindings
      WHERE catalog_kind = 'native_tool'
        AND catalog_id = ANY($1::text[])
      `,
      [DROPPED_NATIVE_TOOLS],
    );
  }
  for (const catalogId of PLATFORM_NATIVE_TOOLS) {
    await pool.query(
      `
      INSERT INTO bindings (
        id, catalog_kind, catalog_id, scope, scope_id, enabled,
        connection_id, created_at, updated_at
      )
      SELECT $1, 'native_tool', $2, 'platform', NULL, TRUE, NULL, $3, $3
      WHERE NOT EXISTS (
        SELECT 1 FROM bindings
        WHERE catalog_kind = 'native_tool'
          AND catalog_id = $2
          AND scope = 'platform'
      )
      `,
      [newId("bind"), catalogId, timestamp],
    );
  }
}
