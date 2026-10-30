import { Type } from "@sinclair/typebox";
import type { FastifyRequest } from "fastify";
import { loadOperatorActor } from "../artifacts/actors.js";
import type { ArtifactActor } from "../artifacts/types.js";
import {
  addRecord,
  clearRecords,
  CollectionDraftSchema,
  CollectionPatchSchema,
  createCollection,
  deleteCollection,
  exportCollection,
  getCollection,
  getRecord,
  listCollections,
  listRecords,
  RecordListQuerySchema,
  RecordValuesSchema,
  removeRecord,
  updateCollection,
  updateRecord,
} from "../artifacts/collection-views.js";
import type { RouteApp, RouteDeps } from "./deps.js";
import { currentOrg, currentUser } from "./identity.js";

/** The path of one collection. */
const CollectionParams = Type.Object({ collection_id: Type.String() });

/** The path of one record of a collection. */
const RecordParams = Type.Object({ collection_id: Type.String(), record_id: Type.String() });

/** Collections live at the organisation: the Tables page builds them and browses their records. */
export async function registerCollectionRoutes(app: RouteApp, deps: RouteDeps): Promise<void> {
  const { db, artifacts: store } = deps;

  async function orgActor(request: FastifyRequest): Promise<ArtifactActor> {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    return loadOperatorActor(db, user, { orgId: String(org.id) });
  }

  app.get("/api/collections", async (request) => listCollections(store, await orgActor(request)));

  app.post(
    "/api/collections",
    { schema: { body: CollectionDraftSchema } },
    async (request, reply) => {
      const actor = await orgActor(request);
      return reply.code(201).send(await createCollection(store, actor, request.body));
    },
  );

  app.get(
    "/api/collections/:collection_id",
    { schema: { params: CollectionParams } },
    async (request) =>
      getCollection(store, await orgActor(request), request.params.collection_id),
  );

  app.patch(
    "/api/collections/:collection_id",
    { schema: { params: CollectionParams, body: CollectionPatchSchema } },
    async (request) =>
      updateCollection(
        store,
        await orgActor(request),
        request.params.collection_id,
        request.body,
      ),
  );

  app.delete(
    "/api/collections/:collection_id",
    { schema: { params: CollectionParams } },
    async (request, reply) => {
      await deleteCollection(store, await orgActor(request), request.params.collection_id);
      return reply.code(204).send();
    },
  );

  app.get(
    "/api/collections/:collection_id/export",
    { schema: { params: CollectionParams } },
    async (request, reply) => {
      const exported = await exportCollection(
        store,
        await orgActor(request),
        request.params.collection_id,
      );
      return reply
        .header("content-disposition", `attachment; filename="${exported.name}.jsonl"`)
        .type("application/jsonl")
        .send(exported.body);
    },
  );

  app.get(
    "/api/collections/:collection_id/records",
    { schema: { params: CollectionParams, querystring: RecordListQuerySchema } },
    async (request) =>
      listRecords(store, await orgActor(request), request.params.collection_id, request.query),
  );

  app.post(
    "/api/collections/:collection_id/records",
    { schema: { params: CollectionParams, body: RecordValuesSchema } },
    async (request, reply) => {
      const actor = await orgActor(request);
      const collectionId = request.params.collection_id;
      return reply.code(201).send(await addRecord(store, actor, collectionId, request.body.body));
    },
  );

  app.delete(
    "/api/collections/:collection_id/records",
    { schema: { params: CollectionParams } },
    async (request, reply) => {
      await clearRecords(store, await orgActor(request), request.params.collection_id);
      return reply.code(204).send();
    },
  );

  app.get(
    "/api/collections/:collection_id/records/:record_id",
    { schema: { params: RecordParams } },
    async (request) =>
      getRecord(
        store,
        await orgActor(request),
        request.params.collection_id,
        request.params.record_id,
      ),
  );

  app.patch(
    "/api/collections/:collection_id/records/:record_id",
    { schema: { params: RecordParams, body: RecordValuesSchema } },
    async (request) => {
      const actor = await orgActor(request);
      const record = {
        collectionId: request.params.collection_id,
        recordId: request.params.record_id,
      };
      return updateRecord(store, actor, record, request.body.body);
    },
  );

  app.delete(
    "/api/collections/:collection_id/records/:record_id",
    { schema: { params: RecordParams } },
    async (request, reply) => {
      const actor = await orgActor(request);
      const { collection_id: collectionId, record_id: recordId } = request.params;
      await removeRecord(store, actor, collectionId, recordId);
      return reply.code(204).send();
    },
  );
}
