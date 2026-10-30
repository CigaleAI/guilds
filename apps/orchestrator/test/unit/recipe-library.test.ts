import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import type { RecipeRow } from "../../src/db/recipes.js";
import { RegistryError, RegistryNotFoundError } from "../../src/registry/index.js";
import { RecipeError } from "../../src/recipes/errors.js";
import { exportRecipe, importRegistryRecipe } from "../../src/recipes/library.js";
import { linkedInNotionRecipe } from "../helpers/recipe-docs.js";
import { fakeRegistry } from "../helpers/registry.js";

function recipeRow(status: RecipeRow["status"], body = linkedInNotionRecipe()): RecipeRow {
  const now = "2026-10-01T00:00:00.000Z";
  return {
    id: "rcp_1",
    org_id: "org_1",
    created_by_user_id: "user_1",
    name: body.meta.name,
    description: body.meta.description,
    visibility: "private",
    status,
    body,
    body_version: 1,
    source_kind: "file",
    source_guild_id: null,
    source_builder_session_id: null,
    created_at: now,
    updated_at: now,
  };
}

const OWNER = { orgId: "org_1", userId: "user_1" };

test("exports_the_document_of_a_ready_recipe", () => {
  const row = recipeRow("ready");
  assert.equal(exportRecipe(row), row.body);
});

test("refuses_to_export_a_draft_with_409", () => {
  assert.throws(
    () => exportRecipe(recipeRow("draft")),
    (error) => error instanceof RecipeError && error.status === 409 && error.message === "export refused while draft",
  );
});

test("refuses_to_export_a_document_that_carries_secrets_with_422", () => {
  const body = linkedInNotionRecipe();
  body.meta.description = "paste the refresh_token here";
  assert.throws(
    () => exportRecipe(recipeRow("ready", body)),
    (error) => error instanceof RecipeError && error.status === 422 && error.message === "recipe must not contain secrets",
  );
});

test("refuses_a_registry_recipe_the_index_lacks_with_404_naming_it", async () => {
  const registry = fakeRegistry();
  const db = new pg.Pool();
  try {
    await assert.rejects(
      importRegistryRecipe(db, registry.client, { name: "crm-desk", version: undefined }, OWNER),
      (error) => error instanceof RegistryNotFoundError && error.status === 404 && error.message === "the registry has no recipe crm-desk",
    );
  } finally {
    await db.end();
  }
});

test("refuses_a_registry_file_that_is_not_a_recipe_naming_the_registry_recipe", async () => {
  const registry = fakeRegistry();
  registry.recipe("crm-desk", "1.0.0", { format: "not-a-recipe" });
  const db = new pg.Pool();
  try {
    await assert.rejects(
      importRegistryRecipe(db, registry.client, { name: "crm-desk", version: undefined }, OWNER),
      (error) => error instanceof RegistryError && error.status === 422 && error.message.startsWith("recipe crm-desk: "),
    );
  } finally {
    await db.end();
  }
});

test("refuses_a_registry_file_that_is_not_json_naming_the_registry_recipe", async () => {
  const registry = fakeRegistry();
  registry.recipe("crm-desk", "1.0.0", {});
  const [entry] = registry.index.recipes;
  assert.ok(entry);
  const body = Buffer.from("{ not json", "utf8");
  registry.files.set(entry.path, body);
  entry.size = body.length;
  entry.sha256 = createHash("sha256").update(body).digest("hex");
  const db = new pg.Pool();
  try {
    await assert.rejects(
      importRegistryRecipe(db, registry.client, { name: "crm-desk", version: undefined }, OWNER),
      (error) => error instanceof RegistryError && error.status === 422 && error.message.startsWith("recipe crm-desk: "),
    );
  } finally {
    await db.end();
  }
});

test("refuses_a_registry_recipe_version_the_index_lacks_with_404_naming_the_version", async () => {
  const registry = fakeRegistry();
  registry.recipe("crm-desk", "1.0.0", linkedInNotionRecipe());
  const db = new pg.Pool();
  try {
    await assert.rejects(
      importRegistryRecipe(db, registry.client, { name: "crm-desk", version: "2.0.0" }, OWNER),
      (error) =>
        error instanceof RegistryNotFoundError && error.status === 404 && error.message === "the registry has no recipe crm-desk@2.0.0",
    );
  } finally {
    await db.end();
  }
});
