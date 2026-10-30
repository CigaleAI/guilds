import assert from "node:assert/strict";
import { test } from "node:test";
import { isGithubSelectedRepository, selectedRepositories } from "./githubSettings";

const repository = {
  name: "acme/site",
  url: "https://github.com/acme/site",
  default_branch: "main",
};

test("a_repository_names_its_name_url_and_default_branch", () => {
  assert.equal(isGithubSelectedRepository(repository), true);
  assert.equal(isGithubSelectedRepository({ name: "acme/site", url: repository.url }), false);
  assert.equal(isGithubSelectedRepository("acme/site"), false);
});

test("the_settings_list_keeps_only_repositories", () => {
  assert.deepEqual(selectedRepositories({ repositories: [repository, { name: 3 }] }), [repository]);
});

test("settings_without_a_list_select_no_repositories", () => {
  assert.deepEqual(selectedRepositories({}), []);
  assert.deepEqual(selectedRepositories({ repositories: "acme/site" }), []);
});
