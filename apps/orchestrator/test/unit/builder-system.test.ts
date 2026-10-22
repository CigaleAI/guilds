import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TEST_MODEL } from "../helpers/models.js";
import {
  composeBuilderGenerationContext,
  composeBuilderSystemMessage,
} from "../../src/builder/system.js";
import { RECIPE_WRITE_HINT } from "../../src/builder/constants.js";
import { builderListCapabilities, builderWriteRecipe } from "../../src/builder/tools.js";
import {
  readBuilderSystemTemplate,
  readBuilderWriteExample,
} from "../../src/conversation/templates.js";
import { emptyRecipe } from "../../src/recipes/minimal.js";
import { applyAccessEdit, parseRecipe } from "../../src/recipes/schema.js";
import { fixtureDeskRecipe } from "../helpers/recipe-docs.js";

test("builder write example is a valid recipe using real field names", () => {
  const example = readBuilderWriteExample();
  const parsed = parseRecipe(example);
  assert.deepEqual(
    parsed.roles.map((role) => role.role),
    ["scout", "archivist"],
  );
  assert.ok(parsed.roles[0]?.task.body);
  assert.equal(parsed.roles[0]?.schedules[0]?.key, "scout-sweep");
  assert.equal(typeof parsed.roles[0]?.schedules[0]?.instruction, "string");
  assert.deepEqual(
    parsed.notes.map((note) => note.level),
    ["agent", "agent"],
  );
  assert.equal(parsed.notes[0]?.id, "playbook");
  for (const note of example.notes as Array<Record<string, unknown>>) {
    assert.equal("path" in note, false);
    assert.match(String(note.key), /^[^/]+\.md$/);
  }
  assert.match(parsed.roles[0]?.task.body ?? "", /note_get agent\/scout\/playbook\.md/);
  assert.equal(parsed.roles[1]?.task.embeds[0], "agent/archivist/notion-map.md");
  assert.match(parsed.roles[1]?.task.body ?? "", /!\[\[agent\/archivist\/notion-map\.md\]\]/);
  assert.equal(parsed.roles[0]?.native_tools.tavily_search, undefined);
  assert.equal(parsed.roles[0]?.native_tools.record_add, true);
  assert.equal(parsed.roles[1]?.native_tools.record_add, false);
  assert.equal(parsed.collections[0]?.guild, "write");
  assert.deepEqual(parsed.collections[1]?.writers, ["scout"]);
  assert.equal(parsed.connections[0]?.server, "tavily");
  assert.equal(parsed.connections[0]?.roles.scout?.tools.tavily_search, true);
  assert.equal(parsed.connections[1]?.server, "notion");
  assert.equal(parsed.connections[1]?.roles.archivist?.enabled, true);
  assert.equal(parsed.design.systems[0]?.resolution, "catalog");
  assert.equal(parsed.design.routines[0]?.key, "scout-sweep");
  for (const note of parsed.notes) {
    assert.ok(note.body.split("\n").length > 3, `${note.key} seeds working content, not a description`);
  }
});

test("builder system prompt maps Memory and routines onto recipe fields", () => {
  const text = readBuilderSystemTemplate();
  assert.match(text, /## Recipe fields/);
  assert.match(text, /task\.body/);
  assert.match(text, /schedules\[\]\.instruction/);
  assert.match(text, /design\.routines/);
  assert.match(text, /take control of that agent's/);
  assert.match(text, /design\.browser\[\]/);
  assert.match(text, /builder_search_connected/);
  assert.match(text, /builder_ask_org_connection/);
  assert.match(text, /builder_ask_connection/);
  assert.match(text, /pause this turn/);
  assert.match(text, /long-lived records/);
  assert.match(text, /connections\[\]\.resources/);
  assert.match(text, /You are a system designer/);
  assert.match(text, /!\[\[agent\/scout\/playbook\.md\]\]/);
  assert.doesNotMatch(text, /<path>/);
  assert.match(text, /A leftover `recipe:<id>` still/);
  assert.match(text, /builder_ask_question/);
  assert.match(text, /until the operator submits/);
  assert.match(text, /OPEN QUESTION/);
  assert.match(text, /access\.tool_removed/);
  assert.match(text, /access\.connector_removed/);
});

test("builder system prompt states each design rule once and leaves field names to the write schema", () => {
  const text = readBuilderSystemTemplate();
  assert.doesNotMatch(text, /## Hub, memory, and files/);
  assert.equal(text.match(/Narrow is not isolated/g)?.length, 1);
  assert.equal(text.match(/A specialist refines itself/g)?.length, 1);
  assert.doesNotMatch(text, /Field names \(do not invent aliases\)/);
  assert.ok(!text.includes(RECIPE_WRITE_HINT));
  assert.match(text, /The instructions in this system message are authoritative/);
  assert.match(text, /Evidence here: recipe fields/);
  assert.match(text, /A new file starts with its first working content/);
});

test("builder system prompt carries the Task shape and what every agent already reads", () => {
  const text = readBuilderSystemTemplate();
  assert.match(text, /## Writing\n/);
  assert.match(text, /Shorter is better/);
  assert.match(text, /## Task shape/);
  assert.match(text, /## Inputs/);
  assert.match(text, /A Task never:/);
  assert.match(text, /## What every agent already reads/);
  assert.match(text, /<agent_task_intro>\nThe operator's standing purpose for you/);
  assert.match(text, /<agent_state_intro>\nA snapshot of the guild at the start of this run/);
  assert.match(text, /<agent_memory_rules>\n### Your Memory/);
  assert.match(text, /<agent_guidelines>\nYou are an agent in a work guild/);
  assert.match(text, /code_task/);
  assert.doesNotMatch(text, /<capability name=/);
  assert.doesNotMatch(text, /\{\{(AGENT_PROMPT|WRITING|TASK_SHAPE|AGENT_GUIDELINES|TASK_INTRO|STATE_INTRO|MEMORY_RULES)\}\}/);
  assert.doesNotMatch(text, /Start of work/);
  assert.doesNotMatch(text, /End of work/);
  assert.match(text, /says when or whether to write Memory/);
});

test("builder system prompt inlines the configured Guidelines template", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "guilds-guidelines-"));
  const guidelinesPath = path.join(dir, "system.md");
  writeFileSync(
    guidelinesPath,
    'Custom guidelines for this box.\n<capability name="coding">Coding part.</capability><capability name="no_coding">No coding part.</capability>\n',
  );
  const text = readBuilderSystemTemplate({ guidelinesPath });
  assert.match(text, /<agent_guidelines>\nCustom guidelines for this box\.\nCoding part\.\n<\/agent_guidelines>/);
  assert.doesNotMatch(text, /You are an agent in a work guild/);
  assert.throws(
    () => readBuilderSystemTemplate({ guidelinesPath: path.join(dir, "missing.md") }),
    /system\.md not found/,
  );
});

test("builder system message ships the write example only while the recipe has no roles", () => {
  const recipe = parseRecipe(emptyRecipe({ source: { kind: "builder", session_id: "bld_test" } }));
  const composed = composeBuilderSystemMessage({
    config: { model: TEST_MODEL, temperature: 0.2 },
    recipe,
    expectedBodyVersion: 1,
    now: new Date("2026-09-18T20:00:00.000Z"),
  });
  assert.match(composed.content, /Recipe write shape/);
  assert.match(composed.content, /Instance data for this session/);
  assert.match(composed.content, /"role": "scout"/);
  assert.match(composed.content, /"body": "Scout: you find new candidates/);
  assert.match(composed.content, /## Inputs\\n/);
  assert.doesNotMatch(composed.content, /Start of work/);
  assert.doesNotMatch(composed.content, /"name": "scout"/);
  const drafted = composeBuilderSystemMessage({
    config: { model: TEST_MODEL, temperature: 0.2 },
    recipe: parseRecipe(fixtureDeskRecipe()),
    expectedBodyVersion: 2,
    now: new Date("2026-09-18T20:00:00.000Z"),
  });
  assert.doesNotMatch(drafted.content, /Recipe write shape/);
  assert.doesNotMatch(drafted.content, /"role": "scout"/);
  const context = composeBuilderGenerationContext(recipe, 1);
  assert.match(context, /recipe_name/);
  assert.doesNotMatch(context, /"name":/);
});

test("builder system message shows only the coach settings, not the session's audit snapshot", () => {
  const recipe = parseRecipe(emptyRecipe({ source: { kind: "builder", session_id: "bld_test" } }));
  const composed = composeBuilderSystemMessage({
    config: {
      model: TEST_MODEL,
      temperature: 0.2,
      max_steps: 24,
      max_tokens: 25000,
      system_prompt_hash: "abc123",
      tool_schemas: [{ type: "function", function: { name: "builder_write_recipe" } }],
    },
    recipe,
    expectedBodyVersion: 1,
    now: new Date("2026-09-18T20:00:00.000Z"),
  });
  const config = composed.content.slice(composed.content.indexOf("## Coach configuration"));
  assert.match(config, /"max_steps": 24/);
  assert.doesNotMatch(composed.content, /system_prompt_hash|tool_schemas/);
});

test("builder system message keeps the clock last so the static prefix stays cacheable", () => {
  const recipe = parseRecipe(fixtureDeskRecipe());
  const compose = (now: string) =>
    composeBuilderSystemMessage({
      config: { model: TEST_MODEL, temperature: 0.2 },
      recipe,
      expectedBodyVersion: 3,
      now: new Date(now),
    }).content;
  const first = compose("2026-09-18T20:00:00.000Z");
  const later = compose("2026-09-18T20:05:00.000Z");
  const session = first.indexOf("## Session");
  assert.ok(session > first.indexOf("## Current recipe"));
  assert.equal(first.slice(0, session), later.slice(0, session));
  assert.match(first.slice(session), /expected_body_version: 3/);
});

test("builder write hint is stated once, in the write tool's description", async () => {
  const fn = (builderWriteRecipe.schema as { function: { description: string; parameters: { properties: { recipe: Record<string, unknown> } } } }).function;
  assert.ok(fn.description.includes(RECIPE_WRITE_HINT));
  assert.equal("description" in fn.parameters.properties.recipe, false);
  const listed = await builderListCapabilities.handler({
    orgId: "org_1",
    capabilities: { async listCapabilities() { return { native: [] }; } },
  } as never);
  assert.equal("recipe_write" in listed, false);
});

test("builder system message lists operator access cuts", () => {
  const recipe = parseRecipe(fixtureDeskRecipe());
  applyAccessEdit(recipe, {
    action: "set_tool",
    server: "mail",
    role: "reader",
    tool: "mail_ping",
    enabled: false,
  });
  applyAccessEdit(recipe, { action: "remove_connection", server: "crm" });
  const composed = composeBuilderSystemMessage({
    config: { model: TEST_MODEL, temperature: 0.2 },
    recipe,
    expectedBodyVersion: 2,
    now: new Date("2026-09-18T20:00:00.000Z"),
  });
  assert.match(composed.content, /Operator access changes/);
  assert.match(composed.content, /tool mail_ping from mail for reader/);
  assert.match(composed.content, /connector crm/);
});

test("builder_write_recipe tool schema names role and task.body", () => {
  const params = (
    builderWriteRecipe.schema as { function: { parameters: Record<string, unknown> } }
  ).function.parameters;
  const recipe = params.properties as {
    recipe: {
      properties: {
        roles: { items: { properties: Record<string, unknown> } };
        collections: {
          items: {
            properties: Record<
              string,
              {
                enum?: string[];
                items?: { properties: Record<string, unknown>; required: string[] };
              }
            >;
            required: string[];
            additionalProperties: boolean;
          };
        };
      };
    };
  };
  const noteProps = (
    recipe.recipe.properties as unknown as {
      notes: { items: { properties: Record<string, unknown> } };
    }
  ).notes.items.properties;
  assert.deepEqual(Object.keys(noteProps).sort(), [
    "author",
    "body",
    "guild",
    "id",
    "key",
    "kind",
    "level",
    "role",
    "writers",
  ]);
  const roleProps = recipe.recipe.properties.roles.items.properties;
  assert.ok(roleProps.role);
  assert.ok(roleProps.task);
  assert.equal(roleProps.name, undefined);
  assert.equal(roleProps.wake_triggers, undefined);
  const task = roleProps.task as {
    properties: Record<string, unknown>;
    additionalProperties?: boolean;
  };
  assert.ok(task.properties.body);
  assert.equal(task.properties.text, undefined);
  assert.equal("additionalProperties" in task, false);
  const collection = recipe.recipe.properties.collections.items;
  assert.deepEqual(Object.keys(collection.properties).sort(), [
    "columns",
    "guild",
    "name",
    "purpose",
    "scope",
    "writers",
  ]);
  assert.deepEqual(collection.required, ["name", "purpose", "columns"]);
  assert.equal("additionalProperties" in collection, false);
  assert.deepEqual(collection.properties.guild?.enum, ["read", "write"]);
  assert.deepEqual(collection.properties.scope?.enum, ["guild", "org"]);
  const column = collection.properties.columns?.items;
  assert.ok(column);
  assert.deepEqual(Object.keys(column.properties).sort(), [
    "description",
    "name",
    "required",
    "type",
    "unique",
    "values",
  ]);
  assert.deepEqual(column.required, ["name", "type", "description"]);
});
