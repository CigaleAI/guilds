import {
  deleteBinding,
  insertBinding,
  lockBinding,
  updateBinding,
  type Binding,
  type BindingKey,
  type BindingRow,
  type DeletedBindingRow,
} from "../db/bindings.js";
import { recordChangeIfAny } from "../db/config-changes.js";
import { type Queryable, withTransaction } from "../db/pg.js";
import type { ChangeActor } from "../lib/change-actor.js";
import { bindingChange } from "./changes.js";

/** Sets a binding at its scope, creating it when the scope has none, and logs the change against `actor`. */
export async function writeBinding(
  db: Queryable,
  binding: Binding,
  now: Date,
  actor: ChangeActor,
): Promise<BindingRow> {
  const { catalogKind, catalogId, scope, scopeId, enabled, connectionId } = binding;
  const key = { catalogKind, catalogId, scope, scopeId };
  return withTransaction(db, async (client) => {
    const found = await lockBinding(client, key);
    const row =
      found === null
        ? await insertBinding(client, binding, now)
        : await updateBinding(client, found.id, { enabled, connectionId }, now);
    await recordChangeIfAny(client, actor, bindingChange(key, found?.enabled ?? null, enabled));
    return row;
  });
}

/** Removes a binding, so its scope inherits, and logs the change against `actor`; null when there was none. */
export async function resetBinding(
  db: Queryable,
  key: BindingKey,
  actor: ChangeActor,
): Promise<DeletedBindingRow | null> {
  return withTransaction(db, async (client) => {
    const row = await deleteBinding(client, key);
    await recordChangeIfAny(client, actor, row ? bindingChange(key, row.enabled, null) : null);
    return row;
  });
}
