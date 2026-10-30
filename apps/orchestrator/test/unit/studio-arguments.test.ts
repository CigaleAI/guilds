import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "@sinclair/typebox";
import { decodeStudioArguments, studioChoice, studioFunctionSchema, studioMap } from "../../src/studio/arguments.js";
import { StudioUnprocessableError } from "../../src/studio/errors.js";
import { STUDIO_TOOLS } from "../../src/studio/tools.js";

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

test("choice_offers_an_enum_and_refuses_any_other_string", () => {
  const Choice = Type.Object({ mode: studioChoice(["on", "off"], { description: "Mode." }) });
  const offered = JSON.parse(JSON.stringify(studioFunctionSchema("studio_example", "Example.", Choice)));
  assert.deepEqual(offered.function.parameters.properties.mode.enum, ["on", "off"]);
  assert.equal(offered.function.parameters.properties.mode.description, "Mode.");
  assert.deepEqual(decodeStudioArguments(Choice, { mode: "off" }), { mode: "off" });
  assert.throws(() => decodeStudioArguments(Choice, { mode: "maybe" }), /\/mode: Expected string to match/);
  assert.throws(() => decodeStudioArguments(Choice, { mode: "on " }), /\/mode: Expected string to match/);
});

test("map_takes_any_name_and_refuses_a_value_that_does_not_match", () => {
  const Settings = Type.Object({ tools: studioMap(studioChoice(["on", "off"])) });
  assert.deepEqual(decodeStudioArguments(Settings, { tools: { a: "on", b: "off" } }), { tools: { a: "on", b: "off" } });
  assert.throws(() => decodeStudioArguments(Settings, { tools: { a: true } }), /\/tools\/a: Expected string/);
  assert.throws(() => decodeStudioArguments(Settings, { tools: ["on"] }), /\/tools: Expected object/);
});

// One malformed call per tool that takes arguments, and the first mismatch it is refused with. The
// tool gets no services: a call that reached its work would fail on them instead.
const MALFORMED: Record<string, [Record<string, unknown>, RegExp]> = {
  studio_get_agent_context: [{ agent_id: "a_1", sections: ["prompt"] }, /^\/sections\/0: Expected string to match/],
  studio_list_routines: [{ paused: "yes" }, /^\/paused: Expected boolean$/],
  studio_list_runs: [{ error_only: "true" }, /^\/error_only: Expected boolean$/],
  studio_get_run: [{ seq_start: 0 }, /^\/run_id: Expected required property$/],
  studio_list_group_messages: [{ limit: 1.5 }, /^\/limit: Expected integer$/],
  studio_list_task_revisions: [{ agent_id: "a_1", cursor: 2 }, /^\/cursor: Expected string$/],
  studio_list_memory_revisions: [{ agent_id: "a_1", limit: "5" }, /^\/limit: Expected integer$/],
  studio_get_memory_version: [{ agent_id: "a_1", revision_id: 3 }, /^\/revision_id: Expected string$/],
  studio_find_artifacts: [{ level: "team" }, /^\/level: Expected string to match/],
  studio_get_artifact: [{ display_path: ["notes/a.md"] }, /^\/display_path: Expected string$/],
  studio_list_file_changes: [{ limit: 5 }, /^\/display_path: Expected required property$/],
  studio_get_script: [{ agent_id: "a_1" }, /^\/name: Expected required property$/],
  studio_get_agent_access: [{ cursor: "0" }, /^\/agent_id: Expected required property$/],
  studio_request_connection_access: [{ connection_id: "c_1" }, /^\/reason: Expected required property$/],
  studio_call_connection_tool: [{ connection_id: "c_1" }, /^\/tool: Expected required property$/],
  studio_create_task_draft: [{ agent_id: "a_1", proposed_content: "x" }, /^\/rationale: Expected required property$/],
  studio_list_guilds: [{ limit: "2" }, /^\/limit: Expected integer$/],
  studio_get_collection: [{}, /^\/collection: Expected required property$/],
  studio_edit_memory: [{ agent_id: "a_1", content: "x", reason: "r" }, /^\/base_version: Expected required property$/],
  studio_edit_note: [{ action: "create", level: "team", reason: "r" }, /^\/level: Expected string to match/],
  studio_edit_guild: [{ about: 1, reason: "r" }, /^\/about: Expected string$/],
  studio_edit_access: [
    { agent_id: "a_1", connections: { c_1: "yes" }, reason: "r" },
    /^\/connections\/c_1: Expected string to match/,
  ],
  studio_edit_collection: [
    { action: "create", columns: [{ name: "a", type: "json", description: "d" }], reason: "r" },
    /^\/columns\/0\/type: Expected string to match/,
  ],
  studio_edit_routine: [{ action: "rename", reason: "r" }, /^\/action: Expected string to match/],
};

test("every_tool_refuses_a_malformed_call_before_any_work", async () => {
  const takesArguments = STUDIO_TOOLS.filter((tool) => {
    const offered = JSON.parse(JSON.stringify(tool.schema));
    return Object.keys(offered.function.parameters.properties).length > 0;
  }).map((tool) => tool.name);
  assert.deepEqual(Object.keys(MALFORMED).sort(), [...takesArguments].sort());
  for (const tool of STUDIO_TOOLS) {
    const malformed = MALFORMED[tool.name];
    if (!malformed) continue;
    const [args, problem] = malformed;
    await assert.rejects(
      tool.handler({} as never, {} as never, args),
      (error: unknown) => error instanceof StudioUnprocessableError && problem.test(error.message),
      tool.name,
    );
  }
});
