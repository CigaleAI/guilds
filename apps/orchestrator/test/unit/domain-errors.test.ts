import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError, domainHttp } from "../../src/http/errors.js";
import { numberOrNull } from "../../src/lib/numbers.js";
import { ModelNotConnectedError } from "../../src/llm/credentials.js";
import { MachineError } from "../../src/machines/index.js";
import { GuildAgentLimitError } from "../../src/guilds/errors.js";
import { LimitError, PolicyError } from "../../src/policy/index.js";

test("a domain refusal answers with its own status and message", () => {
  const cases: Array<[Error, number, string]> = [
    [new MachineError(404, "machine not found"), 404, "machine not found"],
    [new PolicyError(402, "organisation is suspended"), 402, "organisation is suspended"],
    [new LimitError("plan", "machines"), 409, "plan limit reached: machines"],
    [new ModelNotConnectedError("anthropic", "connect anthropic first"), 422, "connect anthropic first"],
    [new GuildAgentLimitError(3), 409, "this guild is limited to 3 agents"],
  ];
  for (const [error, status, message] of cases) {
    const http = domainHttp(error);
    assert.ok(http instanceof HttpError, error.name);
    assert.equal(http.status, status);
    assert.equal(http.statusCode, status);
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
