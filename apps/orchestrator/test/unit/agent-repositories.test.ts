import assert from "node:assert/strict";
import { test } from "node:test";
import { agentRepositoriesProblem } from "../../src/coding/agent-repositories.js";
import { pickedRepositories } from "../../src/coding/repositories.js";
import { codingRepository } from "../helpers/repositories.js";

/** An agent's picks of `names`, none of them read-only unless `readOnly` names it. */
function picks(names: string[], readOnly: string[] = []) {
  return { repositories: names, read_only_repositories: readOnly };
}

const usable = [codingRepository({ name: "shop" }), codingRepository({ name: "docs" }), codingRepository({ name: "site" })];

test("an agent's picks come in its config's order, and a name it cannot use is gone", () => {
  const picked = pickedRepositories(usable, picks(["site", "billing", "shop"]));
  assert.deepEqual(
    picked.repositories.map((row) => row.name),
    ["site", "shop"],
  );
  assert.deepEqual(picked.gone, ["billing"]);
  assert.deepEqual(pickedRepositories(usable, picks([])), { repositories: [], gone: [] });
});

test("a pick the config reads only is read-only, and every other one is not", () => {
  const picked = pickedRepositories(usable, picks(["site", "shop"], ["shop"]));
  assert.deepEqual(
    picked.repositories.map((row) => [row.name, row.read_only]),
    [
      ["site", false],
      ["shop", true],
    ],
  );
});

test("a run starts on the agent's picks; a gone name is named first, else no pick is missing", () => {
  assert.equal(agentRepositoriesProblem(pickedRepositories(usable, picks(["shop"]))), null);
  const gone = agentRepositoriesProblem(pickedRepositories(usable, picks(["shop", "billing", "wiki"])));
  assert.equal(gone?.code, "coding.repositories_gone");
  assert.match(String(gone?.message), /this agent picks billing, wiki, which it can no longer use/);
  const allGone = agentRepositoriesProblem(pickedRepositories(usable, picks(["billing"])));
  assert.equal(allGone?.code, "coding.repositories_gone");
  const missing = agentRepositoriesProblem(pickedRepositories(usable, picks([])));
  assert.equal(missing?.code, "coding.repositories_missing");
  assert.match(String(missing?.message), /this agent has no repository: pick one in its Settings under Repositories/);
});
