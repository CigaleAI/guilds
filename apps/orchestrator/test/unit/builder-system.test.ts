import assert from "node:assert/strict";
import { test } from "node:test";
import { TEST_MODEL } from "../helpers/models.js";
import {
  composeBuilderGenerationContext,
  composeBuilderSystemMessage,
} from "../../src/builder/system.js";
import { RECIPE_WRITE_HINT } from "../../src/builder/constants.js";
import { builderWriteRecipe } from "../../src/builder/tools.js";
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
  assert.equal(parsed.notes[0]?.id, "field-map");
  assert.equal(parsed.notes[1]?.id, "playbook");
  for (const note of example.notes as Array<Record<string, unknown>>) {
    assert.equal("path" in note, false);
    assert.match(String(note.key), /^[^/]+\.md$/);
  }
  assert.equal(parsed.roles[0]?.task.embeds[0], "guild/field-map.md");
  assert.match(parsed.roles[0]?.task.body ?? "", /!\[\[guild\/field-map\.md\]\]/);
  assert.equal(parsed.roles[0]?.native_tools.tavily_search, undefined);
  assert.equal(parsed.roles[0]?.native_tools.record_add, true);
  assert.equal(parsed.collections[0]?.guild, "write");
  assert.deepEqual(parsed.collections[1]?.writers, ["scout"]);
  assert.equal(parsed.connections[0]?.server, "tavily");
  assert.equal(parsed.connections[0]?.roles.scout?.tools.tavily_search, true);
  assert.equal(parsed.connections[1]?.server, "notion");
  assert.equal(parsed.connections[1]?.roles.archivist?.enabled, true);
  assert.equal(parsed.design.systems[0]?.resolution, "catalog");
  assert.equal(parsed.design.routines[0]?.key, "scout-sweep");
});

test("builder system prompt maps Memory and routines onto recipe fields", () => {
  const text = readBuilderSystemTemplate();
  assert.match(text, /Do not emit role keys named/);
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
  assert.match(text, /!\[\[guild\/<key>\]\]/);
  assert.match(text, /!\[\[agent\/<role>\/<key>\]\]/);
  assert.doesNotMatch(text, /<path>/);
  assert.match(text, /A leftover `recipe:<id>` still resolves/);
  assert.match(text, /builder_ask_question/);
  assert.match(text, /until the operator submits/);
  assert.match(text, /OPEN QUESTION/);
  assert.match(text, /access\.tool_removed/);
  assert.match(text, /access\.connector_removed/);
  assert.match(text, /Do not set `avatar_shape` or `avatar_color`/);
});

test("builder system message ships a write shape separate from the session document", () => {
  const recipe = parseRecipe(emptyRecipe({ source: { kind: "builder", session_id: "bld_test" } }));
  const composed = composeBuilderSystemMessage({
    config: { model: TEST_MODEL, temperature: 0.2 },
    recipe,
    expectedBodyVersion: 1,
    now: new Date("2026-09-18T20:00:00.000Z"),
  });
  assert.match(composed.content, /Recipe write shape/);
  assert.match(composed.content, /Instance data for this session/);
  assert.ok(composed.content.includes(RECIPE_WRITE_HINT));
  assert.match(composed.content, /"role": "scout"/);
  assert.match(composed.content, /"body": "Start of work: read Memory/);
  assert.doesNotMatch(composed.content, /"name": "scout"/);
  const context = composeBuilderGenerationContext(recipe, 1);
  assert.match(context, /recipe_name/);
  assert.doesNotMatch(context, /"name":/);
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
    "id",
    "key",
    "kind",
    "level",
    "role",
  ]);
  const roleProps = recipe.recipe.properties.roles.items.properties;
  assert.ok(roleProps.role);
  assert.ok(roleProps.task);
  assert.equal(roleProps.name, undefined);
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
