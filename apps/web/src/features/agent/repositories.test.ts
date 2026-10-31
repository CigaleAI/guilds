import assert from "node:assert/strict";
import { test } from "node:test";
import type { GithubLogin } from "../../api/types/guilds";
import { isGithubUrl, NO_LOGIN, repositoryLogin } from "./repositories";

test("only github.com repository URLs can use a GitHub login", () => {
  assert.ok(isGithubUrl("https://github.com/acme/shop"));
  assert.ok(isGithubUrl("https://github.com/acme/shop.git"));
  assert.ok(!isGithubUrl("https://gitlab.com/acme/shop"));
  assert.ok(!isGithubUrl("https://github.com/acme"));
});

test("a GitHub URL is added with a connected login unless the operator picks none", () => {
  const logins: Pick<GithubLogin, "id" | "status">[] = [
    { id: "conn_old", status: "disconnected" },
    { id: "conn_org", status: "connected" },
    { id: "conn_guild", status: "connected" },
  ];
  const url = "https://github.com/acme/shop";
  assert.equal(repositoryLogin(url, "", logins), "conn_org");
  assert.equal(repositoryLogin(url, "conn_guild", logins), "conn_guild");
  assert.equal(repositoryLogin(url, "conn_old", logins), "conn_org");
  assert.equal(repositoryLogin(url, NO_LOGIN, logins), null);
  assert.equal(repositoryLogin(url, "", []), null);
  assert.equal(repositoryLogin("https://git.example.com/shop.git", "conn_org", logins), null);
});
