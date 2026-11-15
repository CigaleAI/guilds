import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { TokenEntry } from "../../src/coding/git.js";
import { repoRoot } from "../../src/lib/paths.js";
import { createToolHooks } from "../../src/toolbox/index.js";
import { runCodeHelper } from "../../src/toolbox/code.js";
import { gitCredentialEnv, HostCodeSandbox } from "../helpers/code-sandbox.js";
import { tempDir } from "../helpers/env.js";
import { toolFixture } from "../helpers/toolbox.js";

const GITHUB: TokenEntry = {
  token: "ghs_shop",
  expires_at: "2099-01-01T00:00:00Z",
  host: "github.com",
  path: "acme/shop",
  username: "x-access-token",
  provider: "github",
};

const GITLAB: TokenEntry = {
  token: "glpat-infra",
  expires_at: null,
  host: "gitlab.example.com:8443",
  path: "team/infra.git",
  username: "oauth2",
  provider: "access_token",
};

/** An agent home and run dir whose tokens file holds `entries`, by repository name. */
function agentWithTokens(entries: Record<string, TokenEntry>): { home: string; runDir: string } {
  const home = path.join(tempDir("git-credential-home-"), "a_1");
  const runDir = tempDir("git-credential-run-");
  mkdirSync(home, { recursive: true });
  mkdirSync(path.join(runDir, "a_1"), { recursive: true });
  writeFileSync(path.join(runDir, "a_1", "git-tokens.json"), JSON.stringify({ repositories: entries }));
  // A helper `gh auth setup-git` would write, which the image's empty helper drops.
  writeFileSync(path.join(home, ".gitconfig"), '[credential "https://github.com"]\n\thelper = "!echo username=gh; echo password=gh-cli-token; true"\n');
  return { home, runDir };
}

/** What git's credential helpers answer for `url` in that agent's environment, as `git credential fill` prints it. */
function fill(agent: { home: string; runDir: string }, url: string): string {
  const parsed = new URL(url);
  try {
    return execFileSync("git", ["credential", "fill"], {
      input: `protocol=https\nhost=${parsed.host}\npath=${parsed.pathname.slice(1)}\n\n`,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: agent.home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GUILDS_AGENT_HOME: agent.home,
        ...gitCredentialEnv(agent.runDir),
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

test("the host sandbox registers the credential helper exactly as the runtime image does", () => {
  const dockerfile = readFileSync(path.join(repoRoot(import.meta.url), "runtime/Dockerfile"), "utf8");
  const image = Object.fromEntries(
    [...dockerfile.matchAll(/(GIT_CONFIG_[A-Z_0-9]+)=("[^"]*"|[^\s\\]+)/g)].map((match) => [match[1], match[2]!.replace(/^"|"$/g, "")]),
  );
  // The helper is the image's own there, and the repository's copy reading the sandbox's run dir here.
  assert.deepEqual(image, { ...gitCredentialEnv("/run/guilds"), GIT_CONFIG_VALUE_1: "/usr/local/bin/guilds-git-credential" });
  assert.match(dockerfile, /git config --system credential\.https:\/\/\.helper \/usr\/local\/bin\/guilds-git-credential/);
  assert.match(dockerfile, /git config --system credential\.https:\/\/\.useHttpPath true/);
});

test("git gets each repository's token with its own username, on any HTTPS host, and a GitHub helper of the agent's is dropped", () => {
  const agent = agentWithTokens({ shop: GITHUB, infra: GITLAB });
  assert.match(fill(agent, "https://github.com/acme/shop.git"), /^username=x-access-token\npassword=ghs_shop$/m);
  assert.match(fill(agent, "https://github.com/ACME/Shop"), /password=ghs_shop/);
  assert.match(fill(agent, "https://gitlab.example.com:8443/team/infra.git"), /^username=oauth2\npassword=glpat-infra$/m);
  assert.match(fill(agent, "https://gitlab.example.com:8443/team/infra"), /password=glpat-infra/);
});

test("a token is answered only to its own host and path", () => {
  const agent = agentWithTokens({ shop: GITHUB, infra: GITLAB });
  assert.equal(fill(agent, "https://github.com/acme/other.git"), "", "another repository on the host gets nothing, not the agent's own helper");
  assert.equal(fill(agent, "https://gitlab.example.com/team/infra.git"), "", "the same path on another port");
  assert.equal(fill(agent, "https://evil.example.com/team/infra.git"), "", "the same path on another host");
});

test("an entry whose username or token spans lines is not answered", () => {
  const agent = agentWithTokens({
    infra: { ...GITLAB, username: "oauth2\nurl=https://evil.example.com" },
    shop: { ...GITHUB, token: "ghs_shop\nquit=1" },
  });
  assert.equal(fill(agent, "https://gitlab.example.com:8443/team/infra.git"), "");
  assert.equal(fill(agent, "https://github.com/acme/shop.git"), "");
});

test("shell exports GH_TOKEN only inside a GitHub repository", async () => {
  const sandbox = new HostCodeSandbox();
  for (const name of ["shop", "infra"]) {
    mkdirSync(path.join(sandbox.home, "repos", name), { recursive: true });
  }
  await sandbox.files.writeFiles([
    { path: "/run/guilds/a_1/git-tokens.json", data: JSON.stringify({ repositories: { shop: GITHUB, infra: GITLAB } }) },
  ]);
  const shellIn = async (repository: string) => {
    const ctx = toolFixture({ run_id: `r_${repository}`, agent_id: "a_1", guild_id: "g_1", sandbox, secrets: {} });
    ctx.run.code_default_cwd = `repos/${repository}`;
    const result = await runCodeHelper(ctx.run, createToolHooks(), { op: "shell", command: 'printf "gh=%s" "${GH_TOKEN:-none}"' });
    return result.text;
  };
  assert.match(await shellIn("shop"), /gh=ghs_shop/);
  assert.match(await shellIn("infra"), /gh=none/);
});
