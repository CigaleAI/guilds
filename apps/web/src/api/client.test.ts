import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, readApiFailure, readErrorBody } from "./client";

function reply(body: string, status: number, statusText = ""): Response {
  return new Response(body, { status, statusText });
}

test("readErrorBody reads the server's detail", async () => {
  assert.equal(
    await readErrorBody(reply(JSON.stringify({ detail: "Name taken" }), 409)),
    "Name taken",
  );
});

test("readErrorBody falls back to the status line when the body carries no detail", async () => {
  assert.equal(await readErrorBody(reply("{}", 409, "Conflict")), "Conflict");
  assert.equal(await readErrorBody(reply("[]", 409)), "HTTP 409");
});

test("readErrorBody is null when the body is not JSON", async () => {
  assert.equal(await readErrorBody(reply("<html>Bad gateway</html>", 404, "Not Found")), null);
});

test("readApiFailure carries the status and the detail", async () => {
  const failure = await readApiFailure(
    "GET",
    "/api/x",
    reply(JSON.stringify({ detail: "Gone" }), 404),
  );
  assert.ok(failure instanceof ApiError);
  assert.equal(failure.status, 404);
  assert.equal(failure.message, "Gone");
});

test("readApiFailure takes the status line when the body is not JSON", async () => {
  const failure = await readApiFailure("GET", "/api/x", reply("not json", 404, "Not Found"));
  assert.equal(failure.message, "Not Found");
});
