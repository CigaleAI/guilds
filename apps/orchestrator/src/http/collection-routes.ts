import type { FastifyInstance, FastifyRequest } from "fastify";
import { loadOperatorActor, type ArtifactActor } from "../artifacts/index.js";
import {
  addRecord,
  clearRecords,
  createCollection,
  deleteCollection,
  exportCollection,
  getCollection,
  getRecord,
  listCollections,
  listRecords,
  removeRecord,
  updateCollection,
  updateRecord,
} from "../artifacts/collection-views.js";
import type { RouteDeps } from "./deps.js";
import { missingBodyFields } from "./errors.js";
import { currentOrg, currentUser } from "./identity.js";
import { identityDatabase } from "../users/identity.js";
import { bodyOf, param, queryOf } from "./request.js";

/** Collections live at the organisation: the Tables page builds them and browses their records. */
export async function registerCollectionRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  const { db, artifacts: store } = deps;
  const identityDb = identityDatabase(db);

  async function orgActor(request: FastifyRequest): Promise<ArtifactActor> {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    return loadOperatorActor(db, user, { orgId: String(org.id) });
  }

  function requireBody(request: FastifyRequest, fields: string[]): void {
    const missing = missingBodyFields(request.body, fields);
    if (missing) {
      throw missing;
    }
  }

  app.get("/api/collections", async (request) => listCollections(store, await orgActor(request)));

  app.post("/api/collections", async (request, reply) => {
    const actor = await orgActor(request);
    requireBody(request, ["name", "purpose"]);
    return reply.code(201).send(await createCollection(store, actor, bodyOf(request)));
  });

  app.get("/api/collections/:collection_id", async (request) =>
    getCollection(store, await orgActor(request), param(request, "collection_id")),
  );

  app.patch("/api/collections/:collection_id", async (request) =>
    updateCollection(
      store,
      await orgActor(request),
      param(request, "collection_id"),
      bodyOf(request),
    ),
  );

  app.delete("/api/collections/:collection_id", async (request, reply) => {
    await deleteCollection(store, await orgActor(request), param(request, "collection_id"));
    return reply.code(204).send();
  });

  app.get("/api/collections/:collection_id/export", async (request, reply) => {
    const exported = await exportCollection(
      store,
      await orgActor(request),
      param(request, "collection_id"),
    );
    return reply
      .header("content-disposition", `attachment; filename="${exported.name}.jsonl"`)
      .type("application/jsonl")
      .send(exported.body);
  });

  app.get("/api/collections/:collection_id/records", async (request) =>
    listRecords(store, await orgActor(request), param(request, "collection_id"), queryOf(request)),
  );

  app.post("/api/collections/:collection_id/records", async (request, reply) => {
    const actor = await orgActor(request);
    requireBody(request, ["body"]);
    const added = await addRecord(
      store,
      actor,
      param(request, "collection_id"),
      bodyOf(request).body,
    );
    return reply.code(201).send(added);
  });

  app.delete("/api/collections/:collection_id/records", async (request, reply) => {
    await clearRecords(store, await orgActor(request), param(request, "collection_id"));
    return reply.code(204).send();
  });

  app.get("/api/collections/:collection_id/records/:record_id", async (request) =>
    getRecord(
      store,
      await orgActor(request),
      param(request, "collection_id"),
      param(request, "record_id"),
    ),
  );

  app.patch("/api/collections/:collection_id/records/:record_id", async (request) => {
    const actor = await orgActor(request);
    requireBody(request, ["body"]);
    const record = {
      collectionId: param(request, "collection_id"),
      recordId: param(request, "record_id"),
    };
    return updateRecord(store, actor, record, bodyOf(request).body);
  });

  app.delete("/api/collections/:collection_id/records/:record_id", async (request, reply) => {
    const actor = await orgActor(request);
    await removeRecord(store, actor, param(request, "collection_id"), param(request, "record_id"));
    return reply.code(204).send();
  });
}
