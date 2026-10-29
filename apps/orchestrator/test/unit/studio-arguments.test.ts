import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "@sinclair/typebox";
import { decodeStudioArguments, studioFunctionSchema } from "../../src/studio/arguments.js";
import { StudioUnprocessableError } from "../../src/studio/errors.js";

const Parameters = Type.Object({
  agent_id: Type.String(),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer()),
});

test("decode_returns_the_arguments_that_match_the_schema", () => {
  assert.deepEqual(decodeStudioArguments(Parameters, { agent_id: "a_1", limit: 5, extra: true }), {
    agent_id: "a_1",
    limit: 5,
    extra: true,
  });
});

test("decode_treats_a_null_optional_argument_as_absent", () => {
  assert.deepEqual(decodeStudioArguments(Parameters, { agent_id: "a_1", cursor: null }), {
    agent_id: "a_1",
  });
});

test("decode_refuses_a_null_required_argument", () => {
  const Required = Type.Object({ run_id: Type.String() });
  assert.throws(
    () => decodeStudioArguments(Required, { run_id: null }),
    /\/run_id: Expected string/,
  );
});

test("decode_reads_agent_id_as_the_handle_any_alias_names", () => {
  assert.equal(decodeStudioArguments(Parameters, { agent_name: " scout " }).agent_id, "scout");
  assert.equal(
    decodeStudioArguments(Parameters, { agent: "scout", agent_id: "  " }).agent_id,
    "scout",
  );
  assert.equal(decodeStudioArguments(Parameters, { agent_id: 7 }).agent_id, "");
});

test("decode_leaves_agent_aliases_alone_for_a_tool_without_agent_id", () => {
  const NoAgent = Type.Object({ run_id: Type.String() });
  assert.deepEqual(decodeStudioArguments(NoAgent, { run_id: "r_1", agent_name: "scout" }), {
    run_id: "r_1",
    agent_name: "scout",
  });
});

test("decode_names_the_first_mismatch_in_a_studio_unprocessable_error", () => {
  assert.throws(
    () => decodeStudioArguments(Parameters, { limit: 5 }),
    (error: unknown) =>
      error instanceof StudioUnprocessableError &&
      error.status === 422 &&
      error.message === "/agent_id: Expected required property",
  );
  assert.throws(
    () => decodeStudioArguments(Parameters, { agent_id: "a_1", limit: "5" }),
    /\/limit: Expected integer/,
  );
});

test("function_schema_offers_the_parameters_properties_and_required_list", () => {
  const schema = studioFunctionSchema("studio_example", "Example.", Parameters);
  const parameters = JSON.parse(JSON.stringify(schema)).function.parameters;
  assert.deepEqual(parameters.required, ["agent_id"]);
  assert.deepEqual(Object.keys(parameters.properties), ["agent_id", "cursor", "limit"]);
  assert.equal(parameters.properties.limit.type, "integer");
  assert.deepEqual(
    JSON.parse(JSON.stringify(studioFunctionSchema("studio_none", "None.", Type.Object({}))))
      .function.parameters.required,
    [],
  );
});
