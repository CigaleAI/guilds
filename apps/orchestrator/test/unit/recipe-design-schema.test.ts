import assert from "node:assert/strict";
import { test } from "node:test";
import { readBuilderSystemTemplate, readBuilderWriteExample } from "../../src/conversation/templates.js";
import { parseRecipe } from "../../src/recipes/schema.js";
import { applyBlockingErrors, blockingErrors, validateRecipe } from "../../src/recipes/validate.js";
import { crmQueueColumns, linkedInNotionRecipe } from "../helpers/recipe-docs.js";

const ctx = {
  publishedServers: new Set(["notion", "tavily"]),
  remainingAgents: 20,
  remainingBrowserAgents: 5,
  remainingCodingAgents: 5,
  groupLimit: 20,
};

const codesFor = (recipe: ReturnType<typeof linkedInNotionRecipe>, name: string) =>
  validateRecipe(recipe, ctx)
    .filter((item) => item.path === `collections.${name}`)
    .map((item) => item.code);

test("a collection without columns blocks validation and apply", () => {
  const recipe = linkedInNotionRecipe();
  assert.deepEqual(codesFor(recipe, "crm-queue"), []);
  assert.deepEqual(codesFor(recipe, "seen-posts"), []);
  recipe.collections.find((item) => item.name === "crm-queue")!.columns = [];
  assert.deepEqual(codesFor(recipe, "crm-queue"), ["design.untyped_collection"]);
  const findings = validateRecipe(recipe, ctx);
  assert.ok(blockingErrors(findings).some((item) => item.code === "design.untyped_collection"));
  assert.ok(applyBlockingErrors(findings).some((item) => item.code === "design.untyped_collection"));
});

test("a hand-off collection needs a required text column with values", () => {
  const recipe = linkedInNotionRecipe();
  const queue = recipe.collections.find((item) => item.name === "crm-queue")!;
  queue.columns = crmQueueColumns().filter((column) => column.name !== "status");
  assert.deepEqual(codesFor(recipe, "crm-queue"), ["design.handoff_state"]);
  // a seen-set is a dedupe target, not a hand-off: no state column expected
  assert.deepEqual(codesFor(recipe, "seen-posts"), []);

  // the state column only counts when it is required and closed
  queue.columns = [
    ...crmQueueColumns().filter((column) => column.name !== "status"),
    { name: "status", type: "text", description: "state", required: false, unique: false, values: ["new", "written"] },
  ];
  assert.deepEqual(codesFor(recipe, "crm-queue"), ["design.handoff_state"]);
  queue.columns = [
    ...crmQueueColumns().filter((column) => column.name !== "status"),
    { name: "status", type: "text", description: "state", required: true, unique: false },
  ];
  assert.deepEqual(codesFor(recipe, "crm-queue"), ["design.handoff_state"]);

  queue.columns = crmQueueColumns();
  assert.deepEqual(codesFor(recipe, "crm-queue"), []);
});

test("hand-off and dedupe roles must be able to write the collection", () => {
  const recipe = linkedInNotionRecipe();
  const queue = recipe.collections.find((item) => item.name === "crm-queue")!;
  queue.guild = "read";
  const findings = validateRecipe(recipe, ctx).filter((item) => item.code === "design.collection_access");
  assert.equal(findings.length, 2);
  assert.ok(findings.every((item) => item.severity === "error" && item.path === "collections.crm-queue"));
  assert.ok(findings.some((item) => /watcher cannot write crm-queue \(hand-off producer\)/.test(item.message)));
  assert.ok(findings.some((item) => /writer cannot write crm-queue \(hand-off consumer\)/.test(item.message)));

  queue.writers = ["watcher", "writer"];
  assert.deepEqual(codesFor(recipe, "crm-queue"), []);

  const seen = recipe.collections.find((item) => item.name === "seen-posts")!;
  seen.writers = [];
  const dedupe = validateRecipe(recipe, ctx).find((item) => item.code === "design.collection_access");
  assert.ok(dedupe);
  assert.match(dedupe.message, /watcher cannot write seen-posts \(dedupe store of routine watch-feed\)/);
});

test("the builder example declares columns for every collection and its tasks name the state", () => {
  const example = parseRecipe(readBuilderWriteExample());
  assert.equal(example.version, 2);
  assert.equal(example.collections.length, 2);
  for (const collection of example.collections) {
    assert.ok(collection.columns.length > 0, collection.name);
    assert.ok(collection.columns.every((column) => column.description.trim().length > 0), collection.name);
    assert.match(collection.purpose, /One record per/);
  }
  const queue = example.collections.find((item) => item.name === "scout-queue")!;
  const status = queue.columns.find((column) => column.name === "status");
  assert.deepEqual(status?.values, ["new", "archived", "rejected"]);
  assert.equal(status?.required, true);
  assert.equal(queue.guild, "write");
  const seen = example.collections.find((item) => item.name === "seen-set")!;
  assert.equal(seen.columns.filter((column) => column.unique).length, 1);
  assert.equal(seen.guild, "read");
  assert.deepEqual(seen.writers, ["scout"]);
  assert.ok(example.collections.every((item) => item.columns.every((column) => !/^(id|created_at|updated_at)$/.test(column.name))));
  const findings = validateRecipe(example, ctx).map((item) => item.code);
  assert.equal(findings.includes("design.untyped_collection"), false);
  assert.equal(findings.includes("design.handoff_state"), false);
  assert.equal(findings.includes("design.collection_access"), false);
  assert.equal(findings.includes("collection.writer"), false);
  const scout = example.roles.find((role) => role.role === "scout")!;
  const archivist = example.roles.find((role) => role.role === "archivist")!;
  assert.match(scout.task.body, /status new/);
  assert.match(scout.task.body, /record_list where key/);
  assert.match(archivist.task.body, /record_list where status new/);
  assert.match(archivist.task.body, /record_update .* status archived/);
  assert.equal(scout.native_tools.record_add, true);
  assert.equal(archivist.native_tools.record_update, true);
  assert.equal("object_put" in scout.native_tools, false);
});

test("validation warns when a builder design loads roles with what their work does not use", () => {
  const narrow = ["design.shared_note_roles", "access.broad_native", "access.broad_connection"];
  const example = parseRecipe(readBuilderWriteExample());
  assert.deepEqual(
    validateRecipe(example, ctx).filter((item) => narrow.includes(item.code)),
    [],
  );

  example.notes.push({
    id: "roles",
    level: "guild",
    key: "roles.md",
    body: "The scout finds candidates. The archivist writes them to Notion.",
    kind: "seed",
    author: { by: "builder", reviewed: false },
  } as (typeof example.notes)[number]);
  for (const role of example.roles) {
    role.task.body = `${role.task.body}\n\n![[guild/roles.md]]`;
  }
  example.roles[0]!.native_tools = { note_get: true };
  example.connections[1]!.roles.archivist!.tools = {};
  const findings = validateRecipe(example, ctx).filter((item) => narrow.includes(item.code));
  assert.deepEqual(
    findings.map((item) => [item.code, item.path]),
    [
      ["design.shared_note_roles", "notes.roles"],
      ["access.broad_native", "roles.scout.native_tools"],
      ["access.broad_connection", "connections.notion.roles.archivist.tools"],
    ],
  );
  assert.ok(findings.every((item) => item.severity === "warning"));
  assert.match(findings[0]!.message, /scout, archivist/);
});

test("the builder prompt teaches column design and grants", () => {
  const text = readBuilderSystemTemplate();
  assert.match(text, /## Collections/);
  assert.match(text, /typed table, either the guild's own or the\s+organisation's/);
  assert.match(text, /`\{ name, type, description, required\?, unique\?, values\? \}`/);
  assert.match(text, /one required `text`\s+column with `values`/);
  assert.match(text, /one `unique`\s+column/);
  assert.match(text, /One record shape per collection/);
  assert.match(text, /never `since`/);
  assert.match(text, /Do not declare an id or a timestamp column/);
  assert.match(text, /`scope` decides who the table belongs to/);
  assert.match(text, /`guild` is the\s+mode every agent in the guild gets/);
  assert.match(text, /`writers` lists\s+the roles/);
  assert.match(text, /Agents never create or\s+alter a table/);
  assert.doesNotMatch(text, /observed_at|object_put|object_find|JSON Schema/);
});
