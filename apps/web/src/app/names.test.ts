import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentHandleError,
  handleError,
  handleHint,
  liveHandleError,
  repositoryNameError,
  repositoryNameFrom,
  repositoryNamePattern,
} from "./names";

test("an empty handle is not yet an error", () => {
  assert.equal(handleError(""), undefined);
  assert.equal(agentHandleError(""), undefined);
});

test("a handle must be lowercase letters, digits and hyphens, starting with a letter", () => {
  assert.equal(handleError("research"), undefined);
  assert.equal(handleError("lab-2"), undefined);
  assert.equal(handleError("Research"), handleHint);
  assert.equal(handleError("1lab"), handleHint);
  assert.equal(handleError("lab_name"), handleHint);
});

test("user is reserved as an agent handle", () => {
  assert.equal(agentHandleError("user"), "Reserved for tagging every operator.");
  assert.equal(handleError("user"), undefined);
});

test("live handle errors stay quiet until the operator has started, then follow as they type", () => {
  assert.equal(liveHandleError("", false), undefined);
  assert.equal(liveHandleError("", true), handleHint);
  assert.equal(liveHandleError("Lab", true), handleHint);
  assert.equal(liveHandleError("lab", true), undefined);
  assert.equal(liveHandleError("user", true, "agent"), "Reserved for tagging every operator.");
  assert.equal(liveHandleError("user", true, "guild"), undefined);
});

test("a GitHub repository name becomes a folder name the server accepts", () => {
  assert.equal(repositoryNameFrom("Shop.API"), "shop-api");
  assert.equal(repositoryNameFrom("2024-site"), "site");
  assert.equal(repositoryNameFrom("___"), "repo");
  for (const name of ["Shop.API", "2024-site", "___", "a".repeat(90)]) {
    assert.ok(repositoryNamePattern.test(repositoryNameFrom(name)), name);
  }
});

test("a repository name is refused once typed outside the server's rule", () => {
  assert.equal(repositoryNameError(""), undefined);
  assert.equal(repositoryNameError("shop_api-2"), undefined);
  assert.match(repositoryNameError("Shop") ?? "", /^Lowercase/);
  assert.match(repositoryNameError("2shop") ?? "", /^Lowercase/);
});
