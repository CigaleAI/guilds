import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError, domainHttp, validationHttp } from "../../src/http/errors.js";
import { numberOrNull } from "../../src/lib/numbers.js";
import { ModelNotConnectedError } from "../../src/llm/credentials.js";
import { MachineError } from "../../src/machines/index.js";
import { NotesError } from "../../src/notes/errors.js";
import { GuildAgentLimitError } from "../../src/guilds/errors.js";
import { LimitError, PolicyError } from "../../src/policy/index.js";
import { StudioConflictError, StudioNotFoundError, StudioUnprocessableError } from "../../src/studio/errors.js";

test("a domain refusal answers with its own status and message", () => {
  const cases: Array<[Error, number, string]> = [
    [new MachineError(404, "machine not found"), 404, "machine not found"],
    [new PolicyError(402, "organisation is suspended"), 402, "organisation is suspended"],
    [new LimitError("plan", "machines"), 409, "plan limit reached: machines"],
    [new ModelNotConnectedError("anthropic", "connect anthropic first"), 422, "connect anthropic first"],
    [new GuildAgentLimitError(3), 409, "this guild is limited to 3 agents"],
    [new StudioNotFoundError("draft not found"), 404, "draft not found"],
    [new StudioConflictError("stale draft head"), 409, "stale draft head"],
    [new StudioUnprocessableError("model is required"), 422, "model is required"],
  ];
  for (const [error, status, message] of cases) {
    const http = domainHttp(error);
    assert.ok(http instanceof HttpError, error.name);
    assert.equal(http.status, status);
    assert.equal(http.statusCode, status);
    assert.equal(http.detail, message);
  }
});

test("a notes store refusal answers by its message", () => {
  const cases: Array<[string, number]> = [
    ["agent folder already exists: scout", 409],
    ["invalid path", 422],
    ["path must end in .md", 422],
    ["routine notes cannot be overwritten", 422],
    ["cannot delete this file", 422],
    ["file not found", 404],
    ["system prompt template is missing", 500],
  ];
  for (const [message, status] of cases) {
    const http = domainHttp(new NotesError(message));
    assert.ok(http instanceof HttpError, message);
    assert.equal(http.status, status);
    assert.equal(http.detail, message);
  }
});

test("any other error, or a thrown non-error, has no domain answer", () => {
  for (const error of [new Error("boom"), new HttpError(400, "bad"), "text", null, undefined, { status: 409, message: "x" }]) {
    assert.equal(domainHttp(error), null);
  }
});

test("a nullable numeric column is a number, or null when null or absent", () => {
  assert.equal(numberOrNull(null), null);
  assert.equal(numberOrNull(undefined), null);
  assert.equal(numberOrNull("2.5"), 2.5);
  assert.equal(numberOrNull(0), 0);
  assert.equal(numberOrNull("0"), 0);
  assert.equal(numberOrNull(7), 7);
});

test("a field a route's schema requires is missing at its path, with the object around it", () => {
  // Ajv's verbose errors carry the value they found as `data`.
  const missing = {
    keyword: "required",
    instancePath: "/config",
    schemaPath: "#/properties/config/required",
    params: { missingProperty: "model" },
    message: "must have required property 'model'",
    data: { name: "a" },
  };
  const http = validationHttp([missing], "body");
  assert.equal(http.status, 422);
  assert.deepEqual(http.detail, [
    {
      type: "missing",
      loc: ["body", "config", "model"],
      msg: "Field required",
      input: { name: "a" },
    },
  ]);
});

test("a value of the wrong type is the keyword it broke at its path, with the value found", () => {
  const mistyped = {
    keyword: "type",
    instancePath: "/subjects/0/a~1b",
    schemaPath: "#/properties/subjects/items/properties/a~1b/type",
    params: { type: "string" },
    message: "must be string",
    data: 5,
  };
  const http = validationHttp([mistyped], "querystring");
  assert.deepEqual(http.detail, [
    { type: "type", loc: ["querystring", "subjects", "0", "a/b"], msg: "must be string", input: 5 },
  ]);
});
