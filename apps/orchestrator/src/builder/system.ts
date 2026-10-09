import { createHash } from "node:crypto";
import { utcClock } from "../lib/clock.js";
import { wrapEvidence } from "../conversation/trust.js";
import { readBuilderSystemTemplate, readBuilderWriteExample } from "../conversation/templates.js";
import { operatorAccessCuts, type RecipeDocument } from "../recipes/schema.js";
import { RECIPE_WRITE_HINT } from "./constants.js";

function accessCutsBlock(recipe: RecipeDocument): string[] {
  const cuts = operatorAccessCuts(recipe);
  if (!cuts.length) {
    return [];
  }
  return [
    "",
    "## Operator access changes",
    "The operator removed the following access. Keep these cuts. Update standing prompts that mention them, or ask why they were removed. Do not restore a tool or connector unless the operator asks.",
    ...cuts.map((cut) =>
      cut.kind === "tool"
        ? `- tool ${cut.tool} from ${cut.server} for ${cut.role}`
        : `- connector ${cut.server}`,
    ),
  ];
}

export function composeBuilderSystemMessage(args: {
  config: Record<string, unknown>;
  recipe: RecipeDocument;
  expectedBodyVersion: number;
  now?: Date;
}): { content: string; hash: string } {
  const template = readBuilderSystemTemplate();
  const clock = utcClock(args.now);
  const lines = [
    template.replace(/\s+$/, ""),
    "",
    "## Session",
    `- utc_now: ${clock.utc_now}`,
    `- utc_date: ${clock.utc_date}`,
    `- expected_body_version: ${args.expectedBodyVersion}`,
    "",
    "## Coach configuration",
    JSON.stringify(args.config, null, 2),
    "",
    "## Recipe write shape",
    RECIPE_WRITE_HINT,
    "Copy field names from this example. It is not this session's document.",
    "```json",
    JSON.stringify(readBuilderWriteExample(), null, 2),
    "```",
    "",
    "## Current recipe",
    "Instance data for this session. Empty arrays mean unset, not omitted keys. Do not copy `meta.name` onto a role.",
    wrapEvidence({
      source: "builder.recipe",
      body: JSON.stringify(args.recipe, null, 2),
    }),
    ...accessCutsBlock(args.recipe),
    "",
    "Call builder_write_recipe with expected_body_version from the Session block. The current recipe is the document this session owns; do not put body_version inside it. Arguments must be complete JSON. Truncation is not a version conflict — shrink standing-prompt prose, not the roster. Never replace a multi-role draft with a one-role probe.",
  ];
  const content = `${lines.join("\n")}\n`;
  return { content, hash: createHash("sha256").update(content, "utf8").digest("hex") };
}

export function composeBuilderGenerationContext(recipe: RecipeDocument, expectedBodyVersion: number): string {
  return wrapEvidence({
    source: "builder.recipe_map",
    body: JSON.stringify(
      {
        recipe_name: recipe.meta.name,
        roles: recipe.roles.map((role) => role.role),
        expected_body_version: expectedBodyVersion,
        body_hint: `${recipe.roles.length} roles, ${recipe.connections.length} connections`,
      },
      null,
      2,
    ),
  });
}
