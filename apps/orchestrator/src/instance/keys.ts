import type { InferSelectModel } from "drizzle-orm";
import { decryptPayload, encryptPayload } from "../credentials/crypto.js";
import { writeLog } from "../observability/log.js";
import {
  setInstanceKeys,
  type Integration,
  type InstanceKeyRow,
  type InstanceKeySnapshot,
} from "./integrations.js";
import { isPlainRecord } from "../db/json.js";
import type { Queryable } from "../db/pg.js";
import type { instanceKeys } from "../db/schema/index.js";
import type { UserRow } from "../db/users.js";

/** An instance key as the store holds it: its integration, its encrypted values, when it was written, and by whom. */
type StoredInstanceKey = Pick<
  InferSelectModel<typeof instanceKeys>,
  "integration" | "ciphertext" | "nonce" | "updated_at"
> & { set_by_name: UserRow["name"] | null; set_by_email: UserRow["email"] };

/** A stored key's values, or the name of the error that kept them from decrypting under the master key. */
type DecryptedValues = { readable: true; values: Record<string, string> } | { readable: false; errorType: string };

/**
 * A key write the box refuses: an unknown or env-sourced integration, a missing required field, a
 * field the integration lacks, a GitHub App name or owner GitHub would refuse.
 */
export class InstanceKeyError extends Error {
  status: number;
  /** What the refusal answers with, when it says more than its message. */
  detail: Record<string, unknown> | undefined;

  constructor(message: string, status = 400, detail?: Record<string, unknown>) {
    super(message);
    this.name = "InstanceKeyError";
    this.status = status;
    this.detail = detail;
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
  if (!isPlainRecord(raw)) {
    throw new InstanceKeyError("values must be an object");
  }
  const known = new Set(integration.fields.map((field) => field.name));
  const unknown = Object.keys(raw).find((name) => !known.has(name));
  if (unknown !== undefined) {
    throw new InstanceKeyError(`${integration.label} has no field ${unknown}`);
  }
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const field of integration.fields) {
    const value = raw[field.name];
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

function setByOf(row: StoredInstanceKey): string | null {
  return (row.set_by_name ?? "").trim() || (row.set_by_email ?? "").trim() || null;
}

/** A stored key's values, each trimmed and the empty ones left out, decrypted under `masterKey`. */
function decryptStoredValues(row: StoredInstanceKey, masterKey: Buffer | undefined): DecryptedValues {
  let payload: Record<string, unknown>;
  try {
    payload = decryptPayload(row.ciphertext, row.nonce, masterKey);
  } catch (error) {
    return { readable: false, errorType: error instanceof Error ? error.name : "Error" };
  }
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(payload)) {
    if (typeof value === "string" && value.trim()) {
      values[name] = value.trim();
    }
  }
  return { readable: true, values };
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
    const result = await this.db.query<StoredInstanceKey>(
      `SELECT k.integration, k.ciphertext, k.nonce, k.updated_at,
              u.name AS set_by_name, u.email AS set_by_email
         FROM instance_keys k
         LEFT JOIN users u ON u.id = k.set_by_user_id
        ORDER BY k.integration`,
    );
    const next: Record<string, InstanceKeyRow> = {};
    for (const row of result.rows) {
      const decrypted = decryptStoredValues(row, this.masterKey);
      if (!decrypted.readable) {
        writeLog("warn", `instance key unreadable: ${row.integration}`, {
          operation: "instance_keys.load",
          error_type: decrypted.errorType,
        });
        continue;
      }
      next[row.integration] = {
        values: decrypted.values,
        updated_at: new Date(row.updated_at).toISOString(),
        set_by: setByOf(row),
      };
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
