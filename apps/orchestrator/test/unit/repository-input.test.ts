import assert from "node:assert/strict";
import { test } from "node:test";
import { repositoryItem, RepositoryValidationError, validateRepositoryInput } from "../../src/coding/repositories.js";

const refused = (pattern: RegExp) => (error: unknown) => error instanceof RepositoryValidationError && pattern.test(error.message);

test("a repository without a credential has no provider, on any HTTPS host", () => {
  assert.deepEqual(validateRepositoryInput({ name: "docs", url: " https://git.example.com/docs.git " }), {
    name: "docs",
    url: "https://git.example.com/docs.git",
    defaultBranch: null,
    provider: null,
    connectionId: null,
    secretId: null,
    username: null,
  });
});

test("a GitHub login takes the GitHub provider, and only a github.com URL", () => {
  assert.deepEqual(validateRepositoryInput({ name: "shop", url: "https://github.com/acme/shop", connection_id: "conn_a" }), {
    name: "shop",
    url: "https://github.com/acme/shop",
    defaultBranch: null,
    provider: "github",
    connectionId: "conn_a",
    secretId: null,
    username: null,
  });
  assert.throws(
    () => validateRepositoryInput({ name: "shop", url: "https://gitlab.com/acme/shop", connection_id: "conn_a" }),
    refused(/^with a GitHub connection, url must be https:\/\/github\.com\/<owner>\/<repository>$/),
  );
});

test("an access token takes the access-token provider on any HTTPS host, GitHub's included", () => {
  for (const url of [
    "https://gitlab.com/acme/shop.git",
    "https://bitbucket.org/acme/shop.git",
    "https://gitea.example.com:3000/acme/shop.git",
    "https://dev.azure.com/acme/web/_git/shop",
    "https://github.com/acme/shop",
  ]) {
    const input = validateRepositoryInput({ name: "shop", url, secret_id: "sec_1", username: " oauth2 " });
    assert.deepEqual([input.provider, input.secretId, input.username, input.connectionId], ["access_token", "sec_1", "oauth2", null], url);
  }
});

test("a repository takes one credential, and the whole of an access token", () => {
  const url = "https://gitlab.com/acme/shop.git";
  assert.throws(
    () => validateRepositoryInput({ name: "shop", url: "https://github.com/acme/shop", connection_id: "conn_a", secret_id: "sec_1" }),
    refused(/^a repository takes one credential/),
  );
  assert.throws(
    () => validateRepositoryInput({ name: "shop", url: "https://github.com/acme/shop", connection_id: "conn_a", username: "git" }),
    refused(/^a repository takes one credential/),
  );
  const half = refused(/^an access token takes secret_id and a username/);
  assert.throws(() => validateRepositoryInput({ name: "shop", url, secret_id: "sec_1" }), half);
  assert.throws(() => validateRepositoryInput({ name: "shop", url, username: "oauth2" }), half);
  assert.throws(() => validateRepositoryInput({ name: "shop", url, secret_id: "sec_1", username: "two words" }), half);
  assert.throws(() => validateRepositoryInput({ name: "shop", url, secret_id: "sec_1", username: "x".repeat(257) }), half);
  assert.equal(validateRepositoryInput({ name: "shop", url, secret_id: "", username: "  " }).provider, null, "blank fields name nothing");
});

test("an SSH URL is refused whatever the credential", () => {
  for (const url of ["ssh://git@gitlab.com/acme/shop.git", "git@gitlab.com:acme/shop.git"]) {
    assert.throws(() => validateRepositoryInput({ name: "shop", url, secret_id: "sec_1", username: "git" }), refused(/https git URL/));
  }
});

test("a listed repository shows its provider, its login or its access token's secret", () => {
  const stamp = "2026-11-01T00:00:00.000Z";
  const row = {
    id: "repo_1",
    guild_id: "guild_1",
    name: "shop",
    url: "https://gitlab.com/acme/shop.git",
    default_branch: "main",
    remote_id: null,
    created_at: stamp,
    updated_at: stamp,
    connection_status: null,
    connection_account: null,
  };
  const token = repositoryItem({ ...row, provider: "access_token", connection_id: null, secret_id: "sec_1", username: "oauth2", secret_name: "GITLAB_TOKEN" });
  assert.equal(token.provider, "access_token");
  assert.equal(token.username, "oauth2");
  assert.deepEqual(token.secret, { id: "sec_1", name: "GITLAB_TOKEN" });
  assert.equal(token.connection, null);
  const anonymous = repositoryItem({ ...row, provider: null, connection_id: null, secret_id: null, username: null, secret_name: null });
  assert.equal(anonymous.secret, null);
  assert.equal(anonymous.provider, null);
});
