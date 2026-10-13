import assert from "node:assert/strict";
import { test } from "node:test";
import type { MachineAgent, MachineBox, MachineWithAgents } from "../../src/machines/index.js";
import { machineFindings } from "../../src/recipes/apply.js";
import type { RecipeDocument } from "../../src/recipes/schema.js";
import { cryptoThreeRoleRecipe } from "../helpers/recipe-docs.js";

function machineWith(box: MachineBox, agents: number): MachineWithAgents {
  return {
    id: "mach_1",
    org_id: "org_1",
    name: "shared",
    box,
    cpu: box === "custom" ? 2 : null,
    memory_mib: box === "custom" ? 3072 : null,
    max_workspace_mib: 10240,
    workspace_mib: null,
    agents: Array.from(
      { length: agents },
      (_, slot): MachineAgent => ({
        id: `a_${slot}`,
        name: `agent-${slot}`,
        guild_id: "g_1",
        guild_name: "desk",
        slot,
        browser: false,
        coding: false,
      }),
    ),
  };
}

/** The three-role recipe with `coding` on for the roles named. */
function recipeCoding(...roles: string[]): RecipeDocument {
  const recipe = cryptoThreeRoleRecipe();
  for (const role of recipe.roles) {
    if (roles.includes(role.role)) {
      role.config = { ...role.config, coding: true };
    }
  }
  return recipe;
}

const ROOMY = { maxAgents: 32, private: false };

test("a coding role on a standard machine is refused once per coding role", () => {
  const findings = machineFindings(recipeCoding("researcher", "fund"), machineWith("standard", 0), ROOMY);
  assert.deepEqual(
    findings.map((finding) => [finding.code, finding.severity, finding.path]),
    [
      ["machine.coding", "error", "roles.researcher.config.coding"],
      ["machine.coding", "error", "roles.fund.config.coding"],
    ],
  );
  assert.match(findings[0]!.message, /researcher codes and needs a code or custom machine; shared is standard/);
});

test("coding roles fit a code or custom machine, and a recipe without coding fits a standard one", () => {
  assert.deepEqual(machineFindings(recipeCoding("researcher"), machineWith("code", 0), ROOMY), []);
  assert.deepEqual(machineFindings(recipeCoding("researcher", "ta"), machineWith("custom", 0), ROOMY), []);
  assert.deepEqual(machineFindings(recipeCoding(), machineWith("standard", 0), ROOMY), []);
});

test("more roles than the machine has room for under the cap is one finding naming the room left", () => {
  const recipe = recipeCoding();
  assert.deepEqual(machineFindings(recipe, machineWith("standard", 1), { maxAgents: 4, private: false }), []);
  const full = machineFindings(recipe, machineWith("standard", 2), { maxAgents: 4, private: false });
  assert.deepEqual(
    full.map((finding) => [finding.code, finding.path, finding.message]),
    [["machine.full", "machine_id", "shared has room for 2 more agents"]],
  );
  const over = machineFindings(recipe, machineWith("standard", 6), { maxAgents: 4, private: false });
  assert.equal(over[0]!.message, "shared has room for 0 more agents", "room is never negative");
});

test("a machine hosting a guild the operator cannot see is refused, alongside the other findings", () => {
  const findings = machineFindings(recipeCoding("ta"), machineWith("standard", 3), { maxAgents: 4, private: true });
  assert.deepEqual(
    findings.map((finding) => finding.code),
    ["machine.coding", "machine.full", "machine.private"],
  );
  assert.match(findings[2]!.message, /shared hosts agents of a guild you cannot see/);
});
