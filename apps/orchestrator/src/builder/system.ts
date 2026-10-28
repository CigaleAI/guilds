import { createHash } from "node:crypto";
import { utcClock } from "../lib/clock.js";
import { wrapEvidence } from "../conversation/trust.js";
import { readBuilderSystemTemplate, readBuilderWriteExample } from "../conversation/templates.js";
import { operatorAccessCuts } from "../recipes/access-edits.js";
import type { RecipeDocument } from "../recipes/schema.js";

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

/** The coach settings the model reads; the session snapshot also stores audit fields it never needs. */
const COACH_CONFIG_KEYS = [
  "model",
  "temperature",
  "max_tokens",
  "max_steps",
  "max_tool_calls",
  "max_input_tokens",
] as const;

function coachConfigOf(snapshot: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    COACH_CONFIG_KEYS.filter((key) => snapshot[key] !== undefined).map((key) => [key, snapshot[key]]),
  );
}

/** The example ships only until the session's own recipe has a role to copy field names from. */
function writeExampleBlock(recipe: RecipeDocument): string[] {
  if (recipe.roles.length) {
    return [];
  }
  return [
    "## Recipe write shape",
    "Copy field names from this example. It is not this session's document.",
    "```json",
    JSON.stringify(readBuilderWriteExample(), null, 2),
    "```",
    "",
  ];
}

export function composeBuilderSystemMessage(args: {
  config: Record<string, unknown>;
  recipe: RecipeDocument;
  expectedBodyVersion: number;
  /** The agent Guidelines template the coach is shown; the repository's own when absent. */
  guidelinesPath?: string | undefined;
  now?: Date;
}): { content: string; hash: string } {
  const template = readBuilderSystemTemplate({ guidelinesPath: args.guidelinesPath });
  const clock = utcClock(args.now);
  const lines = [
    template.replace(/\s+$/, ""),
    "",
    "## Coach configuration",
    JSON.stringify(coachConfigOf(args.config), null, 2),
    "",
    ...writeExampleBlock(args.recipe),
    "## Current recipe",
    "Instance data for this session. Empty arrays mean unset, not omitted keys. Do not copy `meta.name` onto a role.",
    wrapEvidence({
      source: "builder.recipe",
      body: JSON.stringify(args.recipe, null, 2),
    }),
    ...accessCutsBlock(args.recipe),
    "",
    "## Session",
    `- utc_now: ${clock.utc_now}`,
    `- utc_date: ${clock.utc_date}`,
    `- expected_body_version: ${args.expectedBodyVersion}`,
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
