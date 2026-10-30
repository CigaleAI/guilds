import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { api, ApiError, readApiFailure, readErrorBody } from "./client";

function reply(body: string, status: number, statusText = ""): Response {
  return new Response(body, { status, statusText });
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answers every request with `response`, keeping the requests made. */
function answer(response: () => Response): Request[] {
  const requests: Request[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push(new Request(new URL(String(input), "http://app.test"), init));
    return response();
  };
  return requests;
}

test("api sends a body as JSON with the tab's request id", async () => {
  const requests = answer(() => Response.json({ id: "g1" }));
  assert.deepEqual(await api("/api/guilds", { method: "POST", body: { name: "Ops" } }), {
    id: "g1",
  });
  const [request] = requests;
  assert.equal(request?.method, "POST");
  assert.equal(request?.headers.get("Content-Type"), "application/json");
  assert.ok(request?.headers.get("X-Request-Id"));
  assert.deepEqual(await request?.json(), { name: "Ops" });
});

test("api sends a GET without a body or a content type", async () => {
  const requests = answer(() => Response.json([]));
  await api("/api/guilds");
  assert.equal(requests[0]?.method, "GET");
  assert.equal(requests[0]?.headers.get("Content-Type"), null);
});

test("api reads nothing from a 204 reply", async () => {
  answer(() => new Response(null, { status: 204 }));
  assert.equal(await api("/api/guilds/g1", { method: "DELETE" }), undefined);
});

test("api throws the ApiError of a failed reply", async () => {
  answer(() => Response.json({ detail: "Name taken" }, { status: 409 }));
  await assert.rejects(api("/api/guilds", { method: "POST", body: {} }), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 409);
    assert.equal(error.message, "Name taken");
    return true;
  });
});

test("api rethrows a network failure of an aborted call without reporting it", async () => {
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = async () => {
    throw new DOMException("aborted", "AbortError");
  };
  await assert.rejects(api("/api/guilds", { signal: controller.signal }), DOMException);
});

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
