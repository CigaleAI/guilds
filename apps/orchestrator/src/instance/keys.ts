import { decryptPayload, encryptPayload } from "../credentials/crypto.js";
import { writeLog } from "../observability/log.js";
import {
  setInstanceKeys,
  type Integration,
  type InstanceKeyRow,
  type InstanceKeySnapshot,
} from "./integrations.js";
import type { Queryable } from "../db/pg.js";

/** A write the store refuses: an env-sourced integration, a missing required field, a field the integration lacks. */
export class InstanceKeyError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "InstanceKeyError";
    this.status = status;
  }
}

/**
 * The values a write stores for an integration: each field trimmed, every required field present
 * and non-empty, an optional field left out when empty, nothing the integration does not declare.
 */
export function validateKeyValues(integration: Integration, raw: unknown): Record<string, string> {
  if (integration.source !== "store") {
    throw new InstanceKeyError(`${integration.label} is read from the environment`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InstanceKeyError("values must be an object");
  }
  const given = raw as Record<string, unknown>;
  const known = new Set(integration.fields.map((field) => field.name));
  for (const name of Object.keys(given)) {
    if (!known.has(name)) {
      throw new InstanceKeyError(`${integration.label} has no field ${name}`);
    }
  }
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const field of integration.fields) {
    const value = given[field.name];
    if (value !== undefined && typeof value !== "string") {
      throw new InstanceKeyError(`${field.label} must be a string`);
    }
    const trimmed = (value ?? "").trim();
    if (trimmed) {
      values[field.name] = trimmed;
    } else if (!field.optional) {
      missing.push(field.label);
    }
  }
  if (missing.length) {
    throw new InstanceKeyError(`${integration.label} needs ${missing.join(", ")}`);
  }
  return values;
}

function setByOf(row: Record<string, unknown>): string | null {
  const name = typeof row.set_by_name === "string" ? row.set_by_name.trim() : "";
  const email = typeof row.set_by_email === "string" ? row.set_by_email.trim() : "";
  return name || email || null;
}

/**
 * The instance keys: one encrypted row per store integration, decrypted into the process snapshot
 * at boot and after every write, so the sync readers see a change without a restart.
 */
export class InstanceKeys {
  constructor(
    public db: Queryable,
    private masterKey?: Buffer,
  ) {}

  private snapshot: InstanceKeySnapshot = {};

  /** The values the process holds for an integration, or null while it has none. */
  current(integrationId: string): Record<string, string> | null {
    return this.snapshot[integrationId]?.values ?? null;
  }

  /** Reads and decrypts every row into the snapshot readers resolve from. A row that fails to decrypt is skipped and logged. */
  async load(): Promise<InstanceKeySnapshot> {
    const result = await this.db.query(
      `SELECT k.integration, k.ciphertext, k.nonce, k.updated_at,
              u.name AS set_by_name, u.email AS set_by_email
         FROM instance_keys k
         LEFT JOIN users u ON u.id = k.set_by_user_id
        ORDER BY k.integration`,
    );
    const next: Record<string, InstanceKeyRow> = {};
    for (const row of result.rows as Array<Record<string, unknown>>) {
      const integration = String(row.integration);
      try {
        const payload = decryptPayload(row.ciphertext as Buffer, row.nonce as Buffer, this.masterKey);
        const values: Record<string, string> = {};
        for (const [name, value] of Object.entries(payload)) {
          if (typeof value === "string" && value.trim()) {
            values[name] = value.trim();
          }
        }
        next[integration] = {
          values,
          updated_at: (row.updated_at instanceof Date ? row.updated_at : new Date(String(row.updated_at))).toISOString(),
          set_by: setByOf(row),
        };
      } catch (error) {
        writeLog("warn", `instance key unreadable: ${integration}`, {
          operation: "instance_keys.load",
          error_type: error instanceof Error ? error.name : "Error",
        });
      }
    }
    this.snapshot = next;
    setInstanceKeys(next);
    return next;
  }

  /** Stores an integration's values, replacing what it had, and reloads the snapshot. */
  async put(
    integration: Integration,
    values: Record<string, string>,
    userId: string | null,
    now = new Date(),
  ): Promise<{ previous: Record<string, string> | null }> {
    const previous = this.current(integration.id);
    const [ciphertext, nonce] = encryptPayload(values, this.masterKey);
    await this.db.query(
      `INSERT INTO instance_keys (integration, ciphertext, nonce, set_by_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (integration) DO UPDATE
         SET ciphertext = EXCLUDED.ciphertext,
             nonce = EXCLUDED.nonce,
             set_by_user_id = EXCLUDED.set_by_user_id,
             updated_at = EXCLUDED.updated_at`,
      [integration.id, ciphertext, nonce, userId, now.toISOString()],
    );
    await this.load();
    return { previous };
  }

  /** Removes an integration's values and reloads the snapshot. */
  async remove(integrationId: string): Promise<{ previous: Record<string, string> | null }> {
    const previous = this.current(integrationId);
    await this.db.query(`DELETE FROM instance_keys WHERE integration = $1`, [integrationId]);
    await this.load();
    return { previous };
  }
}
