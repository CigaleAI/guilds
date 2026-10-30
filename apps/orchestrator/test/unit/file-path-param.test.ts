import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { HttpError } from "../../src/http/errors.js";
import { filePathParam } from "../../src/http/request.js";

/** A server whose notes route answers the file path it names, or the status that path is refused with. */
function notesServer(): FastifyInstance {
  const app = Fastify();
  app.get("/notes/*", async (request, reply) => {
    try {
      return { path: filePathParam(request) };
    } catch (error) {
      if (error instanceof HttpError) {
        return reply.code(error.statusCode).send({ refused: error.statusCode });
      }
      throw error;
    }
  });
  return app;
}

test("a wildcard path is the decoded path it names, and one that climbs out with .. is a 404", async () => {
  const app = notesServer();
  try {
    const plain = await app.inject({ method: "GET", url: "/notes/plans/a%20b.md" });
    assert.deepEqual(plain.json(), { path: "plans/a b.md" });
    const climbing = await app.inject({ method: "GET", url: "/notes/a/..%2Fescape.md" });
    assert.deepEqual(climbing.json(), { refused: 404 });
  } finally {
    await app.close();
  }
});

test("a path whose percent-encoding is malformed is read as written", () => {
  const url = "/notes/bad%E0.md";
  const request = { raw: { url }, url, params: {} } as unknown as FastifyRequest;
  assert.equal(filePathParam(request), "bad%E0.md");
  const climbing = "/notes/bad%E0/../escape.md";
  const escape = { raw: { url: climbing }, url: climbing, params: {} } as unknown as FastifyRequest;
  assert.throws(() => filePathParam(escape), HttpError);
});
