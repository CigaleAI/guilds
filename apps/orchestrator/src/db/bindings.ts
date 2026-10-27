import type { InferSelectModel } from "drizzle-orm";
import type pg from "pg";
import { bindingChange } from "../access/changes.js";
import { ownerRefs } from "../credentials/validate.js";
import { pickColumns } from "./columns.js";
import { recordChangeIfAny, type ChangeActor } from "./config-changes.js";
import { RowMissing } from "./errors.js";
import { type Queryable, stamp, withTransaction } from "./pg.js";
import { bindings } from "./schema/index.js";

export type BindingKey = {
  catalogKind: string;
  catalogId: string;
  scope: string;
  scopeId: string | null;
};

const BINDING_KEYS = [
  "id",
  "catalog_kind",
  "catalog_id",
  "scope",
  "scope_id",
  "enabled",
  "connection_id",
  "created_at",
  "updated_at",
] as const;

export type BindingRow = Pick<InferSelectModel<typeof bindings>, (typeof BINDING_KEYS)[number]>;

export type DeletedBindingRow = Pick<BindingRow, "id" | "enabled">;

export type NewBinding = BindingKey & {
  bindingId: string;
  enabled: boolean;
};

export type Binding = NewBinding & {
  connectionId: string | null;
};

export type PlatformBinding = {
  bindingId: string;
  catalogKind: string;
  catalogId: string;
  enabled: boolean;
  connectionId: string | null;
};

/** A binding of an MCP server, at its owner's scope, to one of its logins. */
export type McpConnectionBinding = {
  bindingId: string;
  serverId: string;
  ownerScope: string;
  ownerId: string | null;
  connectionId: string;
};

const BINDING_COLUMNS = pickColumns(bindings, BINDING_KEYS);

export async function listBindingsCovering(
  pool: Queryable,
  options: {
    orgId?: string | null;
    guildId?: string | null;
    agentId?: string | null;
  },
): Promise<BindingRow[]> {
  const result = await pool.query<BindingRow>(
    `SELECT ${BINDING_COLUMNS}
     FROM bindings
     WHERE scope = 'platform'
        OR (scope = 'org' AND scope_id = $1)
        OR (scope = 'guild' AND scope_id = $2)
        OR (scope = 'agent' AND scope_id = $3)
     ORDER BY created_at`,
    [options.orgId ?? null, options.guildId ?? null, options.agentId ?? null],
  );
  return result.rows;
}

export async function listBindingsForConnection(
  pool: Queryable,
  connectionId: string,
): Promise<BindingRow[]> {
  const result = await pool.query<BindingRow>(
    `SELECT ${BINDING_COLUMNS}
     FROM bindings
     WHERE connection_id = $1
     ORDER BY created_at`,
    [connectionId],
  );
  return result.rows;
}

export async function getBinding(pool: Queryable, key: BindingKey): Promise<BindingRow | null> {
  const result =
    key.scope === "platform"
      ? await pool.query<BindingRow>(
          `SELECT ${BINDING_COLUMNS}
           FROM bindings
           WHERE catalog_kind = $1 AND catalog_id = $2 AND scope = 'platform'`,
          [key.catalogKind, key.catalogId],
        )
      : await pool.query<BindingRow>(
          `SELECT ${BINDING_COLUMNS}
           FROM bindings
           WHERE catalog_kind = $1 AND catalog_id = $2
             AND scope = $3 AND scope_id = $4`,
          [key.catalogKind, key.catalogId, key.scope, key.scopeId],
        );
  return result.rows[0] ?? null;
}

export async function insertBindingIfAbsent(
  pool: Queryable,
  binding: NewBinding,
  now: Date,
): Promise<BindingRow> {
  const found = await getBinding(pool, binding);
  if (found) {
    return found;
  }
  const [orgId, guildId, agentId] = ownerRefs(binding.scope, binding.scopeId);
  const inserted = await pool.query<BindingRow>(
    `INSERT INTO bindings (
       id, catalog_kind, catalog_id, scope, scope_id,
       org_id, guild_id, agent_id, enabled, connection_id,
       created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $10)
     RETURNING ${BINDING_COLUMNS}`,
    [
      binding.bindingId,
      binding.catalogKind,
      binding.catalogId,
      binding.scope,
      binding.scopeId,
      orgId,
      guildId,
      agentId,
      binding.enabled,
      stamp(now),
    ],
  );
  const row = inserted.rows[0] ?? null;
  if (!row) {
    throw new RowMissing("binding insert failed");
  }
  return row;
}

export async function upsertBinding(
  pool: pg.Pool,
  binding: Binding,
  now: Date,
  actor: ChangeActor,
): Promise<BindingRow> {
  const { bindingId, catalogKind, catalogId, scope, scopeId, enabled, connectionId } = binding;
  return withTransaction(pool, async (client) => {
    const existing = await client.query<{ id: string; enabled: boolean }>(
      `SELECT id, enabled FROM bindings
       WHERE catalog_kind = $1 AND catalog_id = $2
         AND scope = $3 AND scope_id = $4
       FOR UPDATE`,
      [catalogKind, catalogId, scope, scopeId],
    );
    const found = existing.rows[0] ?? null;
    const key = { catalogKind, catalogId, scope, scopeId };
    if (found === null) {
      const [orgId, guildId, agentId] = ownerRefs(scope, scopeId);
      const inserted = await client.query<BindingRow>(
        `INSERT INTO bindings (
           id, catalog_kind, catalog_id, scope, scope_id,
           org_id, guild_id, agent_id, enabled, connection_id,
           created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
         RETURNING ${BINDING_COLUMNS}`,
        [
          bindingId,
          catalogKind,
          catalogId,
          scope,
          scopeId,
          orgId,
          guildId,
          agentId,
          enabled,
          connectionId,
          stamp(now),
        ],
      );
      const row = inserted.rows[0] ?? null;
      if (!row) {
        throw new RowMissing("binding insert failed");
      }
      await recordChangeIfAny(client, actor, bindingChange(key, null, enabled));
      return row;
    }
    const updated = await client.query<BindingRow>(
      `UPDATE bindings
       SET enabled = $2, connection_id = $3, updated_at = $4
       WHERE id = $1
       RETURNING ${BINDING_COLUMNS}`,
      [found.id, enabled, connectionId, stamp(now)],
    );
    const row = updated.rows[0] ?? null;
    if (!row) {
      throw new RowMissing("binding update failed");
    }
    await recordChangeIfAny(client, actor, bindingChange(key, found.enabled, enabled));
    return row;
  });
}

export async function upsertPlatformBinding(
  pool: Queryable,
  binding: PlatformBinding,
  now: Date,
): Promise<BindingRow> {
  const { bindingId, catalogKind, catalogId, enabled, connectionId } = binding;
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM bindings
     WHERE catalog_kind = $1 AND catalog_id = $2 AND scope = 'platform'`,
    [catalogKind, catalogId],
  );
  const found = existing.rows[0] ?? null;
  if (found === null) {
    const inserted = await pool.query<BindingRow>(
      `INSERT INTO bindings (
         id, catalog_kind, catalog_id, scope, scope_id, enabled,
         connection_id, created_at, updated_at
       )
       VALUES ($1, $2, $3, 'platform', NULL, $4, $5, $6, $6)
       RETURNING ${BINDING_COLUMNS}`,
      [bindingId, catalogKind, catalogId, enabled, connectionId, stamp(now)],
    );
    const row = inserted.rows[0] ?? null;
    if (!row) {
      throw new RowMissing("platform binding insert failed");
    }
    return row;
  }
  const updated = await pool.query<BindingRow>(
    `UPDATE bindings
     SET enabled = $2, connection_id = $3, updated_at = $4
     WHERE id = $1
     RETURNING ${BINDING_COLUMNS}`,
    [found.id, enabled, connectionId, stamp(now)],
  );
  const row = updated.rows[0] ?? null;
  if (!row) {
    throw new RowMissing("platform binding update failed");
  }
  return row;
}

export async function deleteBinding(
  pool: pg.Pool,
  key: BindingKey,
  actor: ChangeActor,
): Promise<DeletedBindingRow | null> {
  const { catalogKind, catalogId, scope, scopeId } = key;
  return withTransaction(pool, async (client) => {
    const result =
      scope === "platform"
        ? await client.query<DeletedBindingRow>(
            `DELETE FROM bindings
             WHERE catalog_kind = $1 AND catalog_id = $2 AND scope = 'platform'
             RETURNING id, enabled`,
            [catalogKind, catalogId],
          )
        : await client.query<DeletedBindingRow>(
            `DELETE FROM bindings
             WHERE catalog_kind = $1 AND catalog_id = $2
               AND scope = $3 AND scope_id = $4
             RETURNING id, enabled`,
            [catalogKind, catalogId, scope, scopeId],
          );
    const row = result.rows[0] ?? null;
    await recordChangeIfAny(client, actor, row ? bindingChange(key, row.enabled, null) : null);
    return row;
  });
}

export async function upsertMcpBinding(
  client: pg.PoolClient,
  binding: McpConnectionBinding,
  now: Date,
): Promise<void> {
  const { bindingId, serverId, ownerScope, ownerId, connectionId } = binding;
  const [orgId, guildId, agentId] = ownerRefs(ownerScope, ownerId);
  if (ownerScope === "platform") {
    const lookup = await client.query<{ id: string }>(
      `SELECT id FROM bindings
       WHERE catalog_kind = 'mcp' AND catalog_id = $1
         AND scope = 'platform'`,
      [serverId],
    );
    const existing = lookup.rows[0] ?? null;
    if (existing === null) {
      await client.query(
        `INSERT INTO bindings (
           id, catalog_kind, catalog_id, scope, scope_id, enabled,
           connection_id, created_at, updated_at
         )
         VALUES ($1, 'mcp', $2, 'platform', NULL, TRUE, $3, $4, $4)`,
        [bindingId, serverId, connectionId, stamp(now)],
      );
      return;
    }
    await client.query(
      `UPDATE bindings
       SET enabled = TRUE, connection_id = $2, updated_at = $3
       WHERE id = $1`,
      [existing.id, connectionId, stamp(now)],
    );
    return;
  }
  const lookup = await client.query<{ id: string }>(
    `SELECT id FROM bindings
     WHERE catalog_kind = 'mcp' AND catalog_id = $1
       AND scope = $2 AND scope_id = $3`,
    [serverId, ownerScope, ownerId],
  );
  const existing = lookup.rows[0] ?? null;
  if (existing === null) {
    await client.query(
      `INSERT INTO bindings (
         id, catalog_kind, catalog_id, scope, scope_id,
         org_id, guild_id, agent_id, enabled, connection_id,
         created_at, updated_at
       )
       VALUES (
         $1, 'mcp', $2, $3, $4, $5, $6, $7, TRUE, $8, $9, $9
       )`,
      [bindingId, serverId, ownerScope, ownerId, orgId, guildId, agentId, connectionId, stamp(now)],
    );
    return;
  }
  await client.query(
    `UPDATE bindings
     SET enabled = TRUE, connection_id = $2, updated_at = $3
     WHERE id = $1`,
    [existing.id, connectionId, stamp(now)],
  );
}
