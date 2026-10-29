import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { createToolContext, createToolHooks } from "../../src/toolbox/index.js";
import { runCodeHelper } from "../../src/toolbox/code.js";
import { HostCodeSandbox } from "../helpers/code-sandbox.js";
import { tempDir } from "../helpers/env.js";

function bare(root: string, name: string): string {
  const dir = path.join(root, `${name}.git`);
  execFileSync("git", ["init", "--quiet", "--bare", dir]);
  return dir;
}

function origin(repository: string): string {
  return execFileSync("git", ["-C", repository, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
}

test("the clone step clones what is missing and points a clone at its repository's current URL", { timeout: 60_000 }, async () => {
  const sandbox = new HostCodeSandbox();
  const remotes = tempDir("guilds-git-remotes-");
  const renamed = bare(remotes, "shop-renamed");
  const docs = bare(remotes, "docs");
  const repos = path.join(sandbox.home, "repos");
  // A clone made before the repository was renamed, and one whose origin is on another host.
  execFileSync("git", ["clone", "--quiet", `file://${bare(remotes, "shop")}`, path.join(repos, "shop")]);
  execFileSync("git", ["init", "--quiet", path.join(repos, "fork")]);
  execFileSync("git", ["-C", path.join(repos, "fork"), "remote", "add", "origin", "https://git.example.com/fork.git"]);

  const ctx = createToolContext({ run_id: "r_setup", agent_id: "a_1", guild_id: "g_1", sandbox, secrets: {} });
  const result = await runCodeHelper(ctx, createToolHooks(), {
    op: "git_setup",
    identity: { name: "coder", email: "coder@agents.guilds.invalid" },
    repositories: [
      { name: "shop", url: `file://${renamed}` },
      { name: "docs", url: `file://${docs}` },
      { name: "fork", url: `file://${bare(remotes, "fork")}` },
    ],
  });
  assert.deepEqual(result.meta.cloned, ["docs"]);
  assert.deepEqual(result.meta.present, ["shop", "fork"]);
  assert.deepEqual(result.meta.moved, ["shop"]);
  assert.deepEqual(result.meta.failed, []);
  assert.equal(origin(path.join(repos, "shop")), `file://${renamed}`);
  assert.equal(origin(path.join(repos, "fork")), "https://git.example.com/fork.git");
  assert.match(result.text, /moved origin of shop/);
});
