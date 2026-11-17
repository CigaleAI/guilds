import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { createToolHooks } from "../../src/toolbox/index.js";
import { runCodeHelper } from "../../src/toolbox/code.js";
import { HostCodeSandbox } from "../helpers/code-sandbox.js";
import { tempDir } from "../helpers/env.js";
import { toolFixture } from "../helpers/toolbox.js";

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

  const ctx = toolFixture({ run_id: "r_setup", agent_id: "a_1", guild_id: "g_1", sandbox, secrets: {} });
  const result = await runCodeHelper(ctx.run, createToolHooks(), {
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
  assert.deepEqual(result.meta.fetched, ["shop"], "a clone whose origin is not the repository's is left alone");
  assert.deepEqual(result.meta.unfetched, []);
  assert.deepEqual(result.meta.failed, []);
  assert.equal(origin(path.join(repos, "shop")), `file://${renamed}`);
  assert.equal(origin(path.join(repos, "fork")), "https://git.example.com/fork.git");
  assert.match(result.text, /moved origin of shop/);
});

function pushUrl(repository: string): string | null {
  try {
    return execFileSync("git", ["-C", repository, "config", "--get", "remote.origin.pushurl"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

test("the clone step fetches what is there and turns pushing off in a clone the agent only reads", { timeout: 60_000 }, async () => {
  const sandbox = new HostCodeSandbox();
  const remotes = tempDir("guilds-git-remotes-");
  const shop = bare(remotes, "shop");
  const docs = bare(remotes, "docs");
  const repos = path.join(sandbox.home, "repos");
  const ctx = toolFixture({ run_id: "r_setup", agent_id: "a_1", guild_id: "g_1", sandbox, secrets: {} });
  const setup = (readOnly: string[]) =>
    runCodeHelper(ctx.run, createToolHooks(), {
      op: "git_setup",
      identity: { name: "reviewer", email: "reviewer@agents.guilds.invalid" },
      repositories: [
        { name: "shop", url: `file://${shop}`, read_only: readOnly.includes("shop") },
        { name: "docs", url: `file://${docs}`, read_only: readOnly.includes("docs") },
      ],
    });

  const first = await setup(["docs"]);
  assert.deepEqual(first.meta.cloned, ["shop", "docs"]);
  assert.equal(pushUrl(path.join(repos, "docs")), "https://push-disabled.invalid/this-repository-is-read-only");
  assert.equal(pushUrl(path.join(repos, "shop")), null);

  // A commit lands on the remote between two generations: the next one fetches it.
  const work = path.join(remotes, "work");
  execFileSync("git", ["clone", "--quiet", `file://${shop}`, work]);
  execFileSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "--quiet", "--allow-empty", "-m", "change"]);
  execFileSync("git", ["-C", work, "push", "--quiet", "origin", "HEAD"]);
  const second = await setup(["shop"]);
  assert.deepEqual(second.meta.cloned, []);
  assert.deepEqual(second.meta.fetched, ["shop", "docs"]);
  const remoteHead = execFileSync("git", ["-C", path.join(repos, "shop"), "branch", "--remotes"], { encoding: "utf8" });
  assert.match(remoteHead, /origin\//, "the fetch brought the remote's branch");
  assert.equal(pushUrl(path.join(repos, "shop")), "https://push-disabled.invalid/this-repository-is-read-only");
  assert.equal(pushUrl(path.join(repos, "docs")), null, "a repository picked writable again pushes to origin");
});
