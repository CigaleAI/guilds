import assert from "node:assert/strict";
import { test } from "node:test";
import { agentRepositoriesProblem } from "../../src/coding/agent-repositories.js";
import { pickedRepositories } from "../../src/coding/repositories.js";
import { codingRepository } from "../helpers/repositories.js";

const usable = [codingRepository({ name: "shop" }), codingRepository({ name: "docs" }), codingRepository({ name: "site" })];

test("an agent's picks come in its config's order, and a name it cannot use is gone", () => {
  const picked = pickedRepositories(usable, ["site", "billing", "shop"]);
  assert.deepEqual(
    picked.repositories.map((row) => row.name),
    ["site", "shop"],
  );
  assert.deepEqual(picked.gone, ["billing"]);
  assert.deepEqual(pickedRepositories(usable, []), { repositories: [], gone: [] });
});

test("a run starts on the agent's picks; a gone name is named first, else no pick is missing", () => {
  assert.equal(agentRepositoriesProblem(pickedRepositories(usable, ["shop"])), null);
  const gone = agentRepositoriesProblem(pickedRepositories(usable, ["shop", "billing", "wiki"]));
  assert.equal(gone?.code, "coding.repositories_gone");
  assert.match(String(gone?.message), /this agent picks billing, wiki, which it can no longer use/);
  const allGone = agentRepositoriesProblem(pickedRepositories(usable, ["billing"]));
  assert.equal(allGone?.code, "coding.repositories_gone");
  const missing = agentRepositoriesProblem(pickedRepositories(usable, []));
  assert.equal(missing?.code, "coding.repositories_missing");
  assert.match(String(missing?.message), /this agent has no repository: pick one in its Settings under Repositories/);
});
