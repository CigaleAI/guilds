import assert from "node:assert/strict";
import { test } from "node:test";
import type { GithubLogin } from "../../api/types/guilds";
import type { Secret } from "../../api/types/secrets";
import {
  ACCESS_TOKEN,
  accessTokenSecrets,
  credentialChoice,
  credentialRequest,
  isCredentialComplete,
  isGithubUrl,
  NO_CREDENTIAL,
  picksUsableRepository,
  repositoryChoices,
  repositoryCredential,
  togglePickedRepository,
} from "./repositories";

const logins: Pick<GithubLogin, "id" | "status">[] = [
  { id: "conn_old", status: "disconnected" },
  { id: "conn_org", status: "connected" },
  { id: "conn_guild", status: "connected" },
];

test("only github.com repository URLs can use a GitHub login", () => {
  assert.ok(isGithubUrl("https://github.com/acme/shop"));
  assert.ok(isGithubUrl("https://github.com/acme/shop.git"));
  assert.ok(!isGithubUrl("https://gitlab.com/acme/shop"));
  assert.ok(!isGithubUrl("https://github.com/acme"));
});

test("a GitHub URL is added with a connected login unless the operator picks another credential", () => {
  const url = "https://github.com/acme/shop";
  assert.deepEqual(repositoryCredential(url, "", logins), {
    kind: "github",
    connectionId: "conn_org",
  });
  assert.deepEqual(repositoryCredential(url, "conn_guild", logins), {
    kind: "github",
    connectionId: "conn_guild",
  });
  assert.deepEqual(repositoryCredential(url, "conn_old", logins), {
    kind: "github",
    connectionId: "conn_org",
  });
  assert.deepEqual(repositoryCredential(url, NO_CREDENTIAL, logins), { kind: "none" });
  assert.deepEqual(repositoryCredential(url, ACCESS_TOKEN, logins), { kind: "access_token" });
  assert.deepEqual(repositoryCredential(url, "", []), { kind: "none" });
});

test("a URL on another host takes an access token or nothing, never a GitHub login", () => {
  const url = "https://gitlab.com/acme/shop.git";
  assert.deepEqual(repositoryCredential(url, "", logins), { kind: "none" });
  assert.deepEqual(repositoryCredential(url, "conn_org", logins), { kind: "none" });
  assert.deepEqual(repositoryCredential(url, ACCESS_TOKEN, logins), { kind: "access_token" });
});

test("an access token is complete with a secret and a username; another credential always is", () => {
  const token = { kind: "access_token" } as const;
  assert.equal(isCredentialComplete(token, "sec_1", "oauth2"), true);
  assert.equal(isCredentialComplete(token, "", "oauth2"), false);
  assert.equal(isCredentialComplete(token, "sec_1", "  "), false);
  assert.equal(isCredentialComplete({ kind: "none" }, "", ""), true);
  assert.equal(isCredentialComplete({ kind: "github", connectionId: "conn_org" }, "", ""), true);
});

test("a credential shows as its login's id, the access-token choice, or the no-credential choice", () => {
  assert.equal(credentialChoice({ kind: "github", connectionId: "conn_org" }), "conn_org");
  assert.equal(credentialChoice({ kind: "access_token" }), ACCESS_TOKEN);
  assert.equal(credentialChoice({ kind: "none" }), NO_CREDENTIAL);
});

test("a credential adds its login, or its secret and trimmed username, to the request", () => {
  assert.deepEqual(
    credentialRequest({ kind: "github", connectionId: "conn_org" }, "sec_1", "git"),
    { connection_id: "conn_org" },
  );
  assert.deepEqual(credentialRequest({ kind: "access_token" }, "sec_1", " oauth2 "), {
    secret_id: "sec_1",
    username: "oauth2",
  });
  assert.deepEqual(credentialRequest({ kind: "none" }, "sec_1", "git"), {});
});

test("only the secrets an operator manages can hold a repository's access token", () => {
  const secret = (id: string, can_manage: boolean): Secret => ({
    id,
    name: id.toUpperCase(),
    description: "",
    org_wide: false,
    grants: [],
    created_by: null,
    created_at: "",
    updated_at: "",
    rotated_at: "",
    can_manage,
  });
  assert.deepEqual(
    accessTokenSecrets([secret("sec_mine", true), secret("sec_admin", false)]).map(
      (item) => item.id,
    ),
    ["sec_mine"],
  );
});

test("an agent's checklist offers each repository it can use, then each it picks and can no longer use", () => {
  assert.deepEqual(repositoryChoices(["docs", "shop"], ["shop", "billing"]), [
    { name: "docs", picked: false, usable: true },
    { name: "shop", picked: true, usable: true },
    { name: "billing", picked: true, usable: false },
  ]);
  assert.deepEqual(repositoryChoices([], []), []);
});

test("ticking a repository adds it after the agent's picks, and unticking takes it out", () => {
  assert.deepEqual(togglePickedRepository(["shop"], "docs"), ["shop", "docs"]);
  assert.deepEqual(togglePickedRepository(["shop", "docs"], "shop"), ["docs"]);
});

test("a turn in repositories needs a pick the agent can use", () => {
  assert.equal(picksUsableRepository(["shop"], ["shop"]), true);
  assert.equal(picksUsableRepository(["shop"], ["billing"]), false);
  assert.equal(picksUsableRepository(["shop"], []), false);
});
