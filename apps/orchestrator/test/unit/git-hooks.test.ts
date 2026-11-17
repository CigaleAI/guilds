import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { repoRoot } from "../../src/lib/paths.js";
import { tempDir } from "../helpers/env.js";

const HOOKS = path.join(repoRoot(import.meta.url), "runtime/git-hooks");
const RUN = { GUILD_RUN_ID: "r_hooks", GUILD_AGENT_ID: "a_hooks" };

/** git's environment in a harness turn: core.hooksPath on the platform's hooks, after the configuration entries before it. */
function turnEnv(home: string, run: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "coder",
    GIT_AUTHOR_EMAIL: "coder@agents.guilds.invalid",
    GIT_COMMITTER_NAME: "coder",
    GIT_COMMITTER_EMAIL: "coder@agents.guilds.invalid",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "init.defaultBranch",
    GIT_CONFIG_VALUE_0: "main",
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_VALUE_1: HOOKS,
    ...run,
  };
}

type Repository = {
  home: string;
  root: string;
  git: (args: string[], cwd?: string) => { status: number | null; stdout: string; stderr: string };
};

/** A repository with one commit in a home of its own, whose git runs as a turn's does, with `run` added to its environment. */
function repository(run: Record<string, string> = RUN): Repository {
  const home = realpathSync(tempDir("git-hooks-home-"));
  const root = path.join(home, "repo");
  const git = (args: string[], cwd = root) => {
    // A hook that ran itself over and over would never return.
    const done = spawnSync("git", args, {
      cwd,
      env: turnEnv(home, run),
      encoding: "utf8",
      timeout: 20_000,
      killSignal: "SIGKILL",
    });
    return { status: done.status, stdout: done.stdout, stderr: done.stderr };
  };
  mkdirSync(root);
  git(["init", "--quiet"]);
  writeFileSync(path.join(root, "a.txt"), "a\n");
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "start"]);
  return { home, root, git };
}

/** Writes an executable hook script at `file`. */
function hook(file: string, body: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

function commit(repo: Repository, message: string, cwd?: string) {
  return repo.git(["commit", "--quiet", "--allow-empty", "-m", message], cwd);
}

function lastMessage(repo: Repository): string {
  return repo.git(["log", "-1", "--format=%B"]).stdout.trim();
}

function trailers(repo: Repository): string {
  return repo.git(["log", "-1", "--format=%(trailers:only,unfold)"]).stdout.trim();
}

test("every hook name git looks up in a hooks directory is a link to the platform's hook", () => {
  // githooks(5) less fsmonitor-watchman, which core.fsmonitor names by its path.
  const names = [
    "applypatch-msg",
    "pre-applypatch",
    "post-applypatch",
    "pre-commit",
    "pre-merge-commit",
    "prepare-commit-msg",
    "commit-msg",
    "post-commit",
    "pre-rebase",
    "post-checkout",
    "post-merge",
    "pre-push",
    "pre-receive",
    "update",
    "proc-receive",
    "post-receive",
    "post-update",
    "reference-transaction",
    "push-to-checkout",
    "pre-auto-gc",
    "post-rewrite",
    "sendemail-validate",
    "p4-changelist",
    "p4-prepare-changelist",
    "p4-post-changelist",
    "p4-pre-submit",
    "post-index-change",
  ];
  assert.deepEqual(readdirSync(HOOKS).sort(), [...names, "guilds-hook"].sort());
  for (const name of names) {
    assert.equal(
      realpathSync(path.join(HOOKS, name)),
      realpathSync(path.join(HOOKS, "guilds-hook")),
      name,
    );
  }
});

test("a repository that sets its own hooks path still gets the run's trailers, after its own prepare-commit-msg", () => {
  const repo = repository();
  repo.git(["config", "core.hooksPath", ".githooks"]);
  hook(path.join(repo.root, ".githooks/prepare-commit-msg"), 'printf "\\nRefs: TASK-1\\n" >> "$1"');
  assert.equal(commit(repo, "Refund rule").status, 0);
  assert.equal(
    lastMessage(repo),
    "Refund rule\n\nRefs: TASK-1\nGuild-Run: r_hooks\nGuild-Agent: a_hooks",
  );
  assert.equal(trailers(repo), "Refs: TASK-1\nGuild-Run: r_hooks\nGuild-Agent: a_hooks");
});

test("the repository's own hook runs with git's arguments, working directory and environment, and its failure fails the command", () => {
  const repo = repository();
  repo.git(["config", "core.hooksPath", ".githooks"]);
  const record = path.join(repo.home, "record");
  hook(
    path.join(repo.root, ".githooks/commit-msg"),
    `echo "$# $1 $PWD $GUILD_RUN_ID" > ${record}; exit 3`,
  );
  mkdirSync(path.join(repo.root, "sub"));
  const before = repo.git(["rev-parse", "HEAD"]).stdout;
  const failed = commit(repo, "Refused", path.join(repo.root, "sub"));
  assert.notEqual(failed.status, 0);
  assert.equal(repo.git(["rev-parse", "HEAD"]).stdout, before, "the commit was not made");
  // The relative hooks path is the working tree's, where git runs hooks, though git ran in a subdirectory.
  assert.equal(readFileSync(record, "utf8"), `1 .git/COMMIT_EDITMSG ${repo.root} r_hooks\n`);
});

test("a hook that reads its standard input gets what git writes to it", () => {
  const repo = repository();
  repo.git(["config", "core.hooksPath", ".githooks"]);
  const record = path.join(repo.home, "pushed");
  hook(path.join(repo.root, ".githooks/pre-push"), `{ echo "$1 $2"; cat; } > ${record}`);
  const remote = path.join(repo.home, "remote.git");
  spawnSync("git", ["init", "--quiet", "--bare", remote]);
  assert.equal(repo.git(["push", "--quiet", remote, "main"]).status, 0);
  const head = repo.git(["rev-parse", "HEAD"]).stdout.trim();
  assert.equal(
    readFileSync(record, "utf8"),
    `${remote} ${remote}\nrefs/heads/main ${head} refs/heads/main ${"0".repeat(40)}\n`,
  );
});

test("a repository with no hooks path runs the hooks of its git directory, and a worktree those of the repository it shares", () => {
  const repo = repository();
  const record = path.join(repo.home, "ran");
  hook(path.join(repo.root, ".git/hooks/commit-msg"), `basename "$PWD" >> ${record}`);
  assert.equal(commit(repo, "In the checkout").status, 0);
  const worktree = path.join(repo.home, "tree");
  repo.git(["worktree", "add", "--quiet", "-b", "side", worktree]);
  assert.equal(commit(repo, "In the worktree", worktree).status, 0);
  assert.equal(readFileSync(record, "utf8"), "repo\ntree\n");
  assert.equal(trailers(repo), "Guild-Run: r_hooks\nGuild-Agent: a_hooks");
});

test("a hooks path in the home's configuration is the repository's when the repository sets none", () => {
  const repo = repository();
  repo.git(["config", "--global", "core.hooksPath", "~/hooks"]);
  hook(path.join(repo.home, "hooks/pre-commit"), "echo refused >&2; exit 1");
  assert.notEqual(commit(repo, "Refused").status, 0);
});

test("without a run a commit gets no trailers, and the repository's hooks run as they would", () => {
  const repo = repository({});
  repo.git(["config", "core.hooksPath", ".githooks"]);
  hook(path.join(repo.root, ".githooks/prepare-commit-msg"), 'printf "\\nRefs: TASK-2\\n" >> "$1"');
  // git ignores a hook that is not executable.
  writeFileSync(path.join(repo.root, ".githooks/pre-commit"), "#!/bin/sh\nexit 1\n");
  assert.equal(commit(repo, "Plain").status, 0);
  assert.equal(lastMessage(repo), "Plain\n\nRefs: TASK-2");
});

test("a repository whose hooks path is the platform's own runs each hook once", () => {
  const repo = repository();
  repo.git(["config", "core.hooksPath", HOOKS]);
  const done = commit(repo, "Once");
  assert.equal(done.status, 0, done.stderr);
  assert.equal(trailers(repo), "Guild-Run: r_hooks\nGuild-Agent: a_hooks");
});

test("git init and clone run a template's hooks under the platform's as they do without them, while the repository is being made", () => {
  const source = repository();
  const template = path.join(source.home, "template");
  hook(
    path.join(template, "hooks/reference-transaction"),
    'cat > /dev/null; echo "${0##*/} $1" >> "$RECORD"',
  );
  hook(path.join(template, "hooks/post-checkout"), 'echo "${0##*/} $3" >> "$RECORD"');
  const made = (env: Record<string, string>) => {
    const record = path.join(tempDir("git-hooks-made-"), "record");
    writeFileSync(record, "");
    const run = (args: string[]) =>
      spawnSync("git", args, {
        cwd: source.home,
        env: { ...env, RECORD: record },
        encoding: "utf8",
        timeout: 20_000,
      });
    const target = path.join(path.dirname(record), "made");
    const stderr = [
      run(["init", "--quiet", `--template=${template}`, target]),
      run(["clone", "--quiet", `--template=${template}`, source.root, `${target}-clone`]),
    ]
      .map((done) => done.stderr)
      .join("");
    return { stderr, ran: readFileSync(record, "utf8") };
  };
  const turn = turnEnv(source.home, RUN);
  const platform = made(turn);
  assert.deepEqual(platform, made({ ...turn, GIT_CONFIG_COUNT: "1" }));
  assert.equal(platform.stderr, "");
  assert.match(platform.ran, /^post-checkout 1$/m, "the clone ran its template's hook");
});

/** A non-bare repository that takes a push to its checked-out branch, and a clone of it, whose push runs receive-pack under the turn's git environment. */
function pushTarget(): {
  target: Repository;
  clone: Repository;
  push: () => ReturnType<Repository["git"]>;
} {
  const target = repository();
  target.git(["config", "receive.denyCurrentBranch", "updateInstead"]);
  const clone = repository();
  clone.git(["remote", "add", "target", target.root]);
  clone.git(["fetch", "--quiet", "target"]);
  clone.git(["reset", "--quiet", "--hard", "target/main"]);
  writeFileSync(path.join(clone.root, "b.txt"), "b\n");
  clone.git(["add", "."]);
  commit(clone, "Add b");
  // git keeps its configuration entries out of a local receive-pack's environment; the turn's
  // are set again, as for a receive-pack that runs in the turn.
  const receivePack = `env GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_1=core.hooksPath GIT_CONFIG_VALUE_1=${HOOKS} git receive-pack`;
  const push = () =>
    clone.git(["push", "--quiet", `--receive-pack=${receivePack}`, "target", "HEAD:main"]);
  return { target, clone, push };
}

test("a push to a checked-out branch updates its working tree when the repository has no push-to-checkout hook, as git does", () => {
  const { target, push } = pushTarget();
  const done = push();
  assert.equal(done.status, 0, done.stderr);
  assert.equal(readFileSync(path.join(target.root, "b.txt"), "utf8"), "b\n");
  assert.equal(target.git(["status", "--porcelain"]).stdout, "");
});

test("a push to a checked-out branch whose working tree has changes is refused when the repository has no push-to-checkout hook", () => {
  const { target, push } = pushTarget();
  writeFileSync(path.join(target.root, "a.txt"), "changed\n");
  const done = push();
  assert.notEqual(done.status, 0);
  assert.match(done.stderr, /Working directory has unstaged changes/);
});

test("a repository's own push-to-checkout and pre-receive run on a push, pre-receive with the pushed refs on its input", () => {
  const { target, push } = pushTarget();
  const record = path.join(target.home, "received");
  hook(path.join(target.root, ".git/hooks/pre-receive"), `cat > ${record}`);
  hook(path.join(target.root, ".git/hooks/push-to-checkout"), `echo "$1" >> ${record}; exit 1`);
  const done = push();
  assert.notEqual(done.status, 0, "the repository's push-to-checkout declined the push");
  assert.ok(!existsSync(path.join(target.root, "b.txt")));
  const [received, checkout] = readFileSync(record, "utf8").trim().split("\n");
  assert.match(received!, /^[0-9a-f]{40} [0-9a-f]{40} refs\/heads\/main$/);
  assert.equal(checkout, received!.split(" ")[1]);
});
