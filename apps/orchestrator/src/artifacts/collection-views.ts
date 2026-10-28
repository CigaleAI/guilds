// Collections and their records as the Tables page and the settings surfaces show them.
import { isPlainRecord } from "../db/json.js";
import { ArtifactError } from "./errors.js";
import type { ArtifactActor } from "./types.js";
import type { ArtifactStore } from "./store.js";
import * as collections from "./collections.js";
import * as recordStore from "./records.js";

export async function listCollections(
  store: ArtifactStore,
  actor: ArtifactActor,
): Promise<Array<Record<string, unknown>>> {
  return collections.listCollectionsWithCounts(store, actor);
}

export async function createCollection(
  store: ArtifactStore,
  actor: ArtifactActor,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return collections.createCollection(store, actor, {
    name: String(body.name ?? ""),
    purpose: String(body.purpose ?? ""),
    columns: body.columns ?? [],
    ...(body.guild_id !== undefined
      ? { guildId: body.guild_id === null ? null : String(body.guild_id) }
      : {}),
  });
}

export async function getCollection(
  store: ArtifactStore,
  actor: ArtifactActor,
  collectionId: string,
): Promise<Record<string, unknown>> {
  return collections.getCollection(store, actor, collectionId);
}

export async function updateCollection(
  store: ArtifactStore,
  actor: ArtifactActor,
  collectionId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return collections.updateCollection(store, actor, collectionId, {
    ...(body.name !== undefined ? { name: String(body.name) } : {}),
    ...(body.purpose !== undefined ? { purpose: String(body.purpose) } : {}),
    ...(body.columns !== undefined ? { columns: body.columns } : {}),
    ...(body.guild_id !== undefined
      ? { guildId: body.guild_id === null ? null : String(body.guild_id) }
      : {}),
  });
}

export async function deleteCollection(
  store: ArtifactStore,
  actor: ArtifactActor,
  collectionId: string,
): Promise<void> {
  await collections.deleteCollection(store, actor, collectionId);
}

export async function clearRecords(
  store: ArtifactStore,
  actor: ArtifactActor,
  collectionId: string,
): Promise<void> {
  await collections.clearRecords(store, actor, collectionId);
}

function parseJsonQuery(raw: string | undefined, label: string): unknown {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ArtifactError(`${label} must be JSON`, 422);
  }
}

/**
 * Records of a collection for the page: `query` runs the text search, the
 * rest are the `record_list` arguments (`where` and `order` as JSON).
 */
export async function listRecords(
  store: ArtifactStore,
  actor: ArtifactActor,
  collectionId: string,
  query: Record<string, string>,
): Promise<Record<string, unknown>> {
  const collection = await collections.getCollection(store, actor, collectionId);
  const text = (query.query ?? "").trim();
  if (text) {
    const found = await recordStore.searchRecords(store, actor, {
      collection: collection.name,
      query: text,
      where: parseJsonQuery(query.where, "where"),
      limit: query.limit,
    });
    const records = found.records.map((record) =>
      withDisplayPath(actor.orgId, collection.name, record),
    );
    return { total: records.length, records, columns: collection.columns };
  }
  const listed = await recordStore.listRecords(store, actor, {
    collection: collection.name,
    where: parseJsonQuery(query.where, "where"),
    since: query.since,
    order:
      parseJsonQuery(query.order, "order") ??
      (query.order_by
        ? { column: query.order_by, direction: query.direction ?? "asc" }
        : undefined),
    limit: query.limit,
    offset: query.offset,
  });
  return {
    total: listed.total,
    records: listed.records.map((record) => withDisplayPath(actor.orgId, collection.name, record)),
    columns: listed.columns,
  };
}

function withDisplayPath(
  orgId: string,
  collectionName: string,
  record: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...record,
    display_path: `org/${orgId}/collections/${collectionName}/${String(record.id)}`,
  };
}

export async function getRecord(
  store: ArtifactStore,
  actor: ArtifactActor,
  collectionId: string,
  recordId: string,
): Promise<Record<string, unknown>> {
  const collection = await collections.getCollection(store, actor, collectionId);
  const record = await recordStore.getRecord(store, actor, collection.name, recordId);
  return withDisplayPath(actor.orgId, collection.name, record);
}

export async function addRecord(
  store: ArtifactStore,
  actor: ArtifactActor,
  collectionId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const collection = await collections.getCollection(store, actor, collectionId);
  const result = await recordStore.addRecord(store, actor, {
    collection: collection.name,
    body: asRecord(body),
  });
  return {
    record: withDisplayPath(actor.orgId, collection.name, result.record),
    merged: result.merged,
  };
}

/** A record by its collection's id and its own. */
export type RecordKey = { collectionId: string; recordId: string };

export async function updateRecord(
  store: ArtifactStore,
  actor: ArtifactActor,
  key: RecordKey,
  body: unknown,
): Promise<Record<string, unknown>> {
  const collection = await collections.getCollection(store, actor, key.collectionId);
  const result = await recordStore.updateRecord(store, actor, {
    collection: collection.name,
    id: key.recordId,
    body: asRecord(body),
  });
  return {
    record: withDisplayPath(actor.orgId, collection.name, result.record),
    warnings: result.warnings,
  };
}

export async function removeRecord(
  store: ArtifactStore,
  actor: ArtifactActor,
  collectionId: string,
  recordId: string,
): Promise<void> {
  const collection = await collections.getCollection(store, actor, collectionId);
  await recordStore.removeRecord(store, actor, { collection: collection.name, id: recordId });
}

export async function exportCollection(
  store: ArtifactStore,
  actor: ArtifactActor,
  collectionId: string,
): Promise<{ name: string; body: string }> {
  const exported = await recordStore.exportRecords(store, actor, collectionId);
  const lines = exported.records.map((record) => {
    const { collection: _collection, version: _version, ...rest } = record;
    return JSON.stringify(rest);
  });
  return { name: exported.name, body: lines.join("\n") + (lines.length ? "\n" : "") };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (isPlainRecord(value)) {
    return value;
  }
  throw new ArtifactError("body must be an object of column: value", 422);
}
