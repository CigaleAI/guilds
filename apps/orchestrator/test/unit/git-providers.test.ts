import assert from "node:assert/strict";
import { test } from "node:test";
import { AccessTokenProvider, credentialTarget } from "../../src/coding/access-token-provider.js";
import { pullRequestToolOf, RepositoryTokens, type GitProvider, type TokenEntry } from "../../src/coding/git.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import { RepositoryAccessError } from "../../src/github/tokens.js";
import { HEX_MASTER_KEY } from "../helpers/env.js";
import { codingRepository } from "../helpers/repositories.js";

process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;

/** A stored secret holding `value`, as `getSecret` reads it. */
function storedSecret(id: string, name: string, value: string) {
  const [ciphertext, nonce] = encryptPayload({ value });
  return { id, name, ciphertext, nonce };
}

/** An access-token provider reading the secrets given, by id. */
function accessTokens(secrets: Array<ReturnType<typeof storedSecret>>): AccessTokenProvider {
  return new AccessTokenProvider({
    getSecret: async (id: string) => secrets.find((secret) => secret.id === id) ?? null,
  } as never);
}

/** A provider that answers each repository with a fixed entry, and records the names it was asked for. */
function fixedProvider(entry: Omit<TokenEntry, "path">, asked: string[][]): GitProvider {
  return {
    mint: async (repositories) => {
      asked.push(repositories.map((row) => row.name));
      return new Map(repositories.map((row) => [row.name, { ...entry, path: row.name }]));
    },
  };
}

test("git asks for a repository's credential with its URL's host, a port other than 443, and its path", () => {
  assert.deepEqual(credentialTarget("https://GitLab.com/acme/shop.git"), { host: "gitlab.com", path: "acme/shop.git" });
  assert.deepEqual(credentialTarget("https://git.example.com:8443/team/app"), { host: "git.example.com:8443", path: "team/app" });
  assert.deepEqual(credentialTarget("https://git.example.com:443/team/app"), { host: "git.example.com", path: "team/app" });
  assert.deepEqual(credentialTarget("https://dev.azure.com/acme/web/_git/app"), { host: "dev.azure.com", path: "acme/web/_git/app" });
});

test("an access token is the value of its repository's secret, sent with its username, for its own host and path, and never expires", async () => {
  const provider = accessTokens([storedSecret("sec_1", "GITLAB_TOKEN", "glpat-secret")]);
  const entries = await provider.mint([
    codingRepository({
      name: "shop",
      url: "https://gitlab.com/acme/shop.git",
      provider: "access_token",
      secret_id: "sec_1",
      username: "oauth2",
    }),
  ]);
  assert.deepEqual([...entries], [
    [
      "shop",
      {
        token: "glpat-secret",
        expires_at: null,
        host: "gitlab.com",
        path: "acme/shop.git",
        username: "oauth2",
        provider: "access_token",
      },
    ],
  ]);
});

test("an access token whose secret is gone, unreadable, or spans lines is refused, naming the repository", async () => {
  const unreadable = { ...storedSecret("sec_bad", "BROKEN", "x"), nonce: Buffer.alloc(12) };
  const provider = accessTokens([unreadable, storedSecret("sec_lines", "MULTI", "one\ntwo")]);
  const repository = (secretId: string | null, username: string | null = "git") =>
    codingRepository({ name: "app", url: "https://git.example.com/app.git", provider: "access_token", secret_id: secretId, username });
  const refusal = (pattern: RegExp) => (error: unknown) => error instanceof RepositoryAccessError && pattern.test(error.message);
  await assert.rejects(provider.mint([repository("sec_gone")]), refusal(/^app: the secret that holds its access token is gone$/));
  await assert.rejects(provider.mint([repository("sec_bad")]), refusal(/^app: the secret BROKEN that holds its access token cannot be read$/));
  await assert.rejects(provider.mint([repository("sec_lines")]), refusal(/^app: the secret MULTI holds a line break/));
  await assert.rejects(provider.mint([repository(null)]), refusal(/^app has no access token$/));
  await assert.rejects(provider.mint([repository("sec_lines", null)]), refusal(/^app has no access token$/));
});

test("each repository's token is minted by its own provider; one without a provider gets none", async () => {
  const githubAsked: string[][] = [];
  const tokenAsked: string[][] = [];
  const tokens = new RepositoryTokens(
    {
      github: fixedProvider(
        { token: "ghs_1", expires_at: "2026-09-30T13:00:00Z", host: "github.com", username: "x-access-token", provider: "github" },
        githubAsked,
      ),
      access_token: fixedProvider(
        { token: "glpat", expires_at: null, host: "gitlab.com", username: "oauth2", provider: "access_token" },
        tokenAsked,
      ),
    },
    [
      codingRepository({ name: "shop", connection_id: "conn_a" }),
      codingRepository({ name: "infra", url: "https://gitlab.com/acme/infra", provider: "access_token", secret_id: "sec_1", username: "oauth2" }),
      codingRepository({ name: "public", url: "https://git.example.com/public.git" }),
    ],
    "push_and_pull_requests",
  );
  await tokens.mint();
  assert.deepEqual(githubAsked, [["shop"]]);
  assert.deepEqual(tokenAsked, [["infra"]]);
  assert.deepEqual(Object.keys(tokens.entries).sort(), ["infra", "shop"]);
  assert.deepEqual(tokens.values.sort(), ["ghs_1", "glpat"]);
  assert.equal(tokens.hasExpiringTokens, true);
  assert.equal(tokens.needsRefresh(new Date("2026-09-30T12:00:00Z")), false);
  assert.equal(tokens.needsRefresh(new Date("2026-09-30T12:55:00Z")), true);
});

test("access tokens alone never need a refresh", async () => {
  const tokens = new RepositoryTokens(
    {
      github: fixedProvider({ token: "unused", expires_at: null, host: "github.com", username: "x", provider: "github" }, []),
      access_token: fixedProvider({ token: "glpat", expires_at: null, host: "gitlab.com", username: "oauth2", provider: "access_token" }, []),
    },
    [codingRepository({ name: "infra", url: "https://gitlab.com/acme/infra", provider: "access_token", secret_id: "sec_1", username: "oauth2" })],
    "push",
  );
  await tokens.mint();
  assert.equal(tokens.hasExpiringTokens, false);
  assert.equal(tokens.needsRefresh(new Date("2999-01-01T00:00:00Z")), false);
});

test("a run's pull request tool is the one it is offered of the connector of a repository's provider, by the name the run calls it", () => {
  const github = codingRepository({ name: "shop", url: "https://github.com/acme/shop", provider: "github", connection_id: "conn_a" });
  const elsewhere = codingRepository({ name: "app", url: "https://git.example.com/team/app.git", provider: "access_token" });
  const connector = (serverId: string, remoteName: string) => ({
    server_id: serverId,
    tools: [
      { name: "github_get_issue", remote_name: "get_issue" },
      { name: `github_${remoteName}`, remote_name: remoteName },
    ],
  });
  assert.equal(pullRequestToolOf([github], [connector("mcp_github", "create_pull_request")]), "github_create_pull_request");
  assert.equal(pullRequestToolOf([elsewhere, github], [connector("mcp_github", "create_pull_request")]), "github_create_pull_request");
  assert.equal(pullRequestToolOf([github], [connector("mcp_github", "merge_pull_request")]), null, "a GitHub login whose pull request tool is not bound");
  assert.equal(pullRequestToolOf([github], [connector("mcp_other", "create_pull_request")]), null, "another connector's tool of that name");
  assert.equal(pullRequestToolOf([elsewhere], [connector("mcp_github", "create_pull_request")]), null, "a host without a connector");
  assert.equal(pullRequestToolOf([codingRepository({ name: "open", provider: null })], [connector("mcp_github", "create_pull_request")]), null);
});
