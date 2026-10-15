import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentHarness, HarnessCredential } from "../../api/types";
import {
  codingProblems,
  codingProblemsSentence,
  codingProblemsText,
  codingStrip,
  freeTokenName,
  harnessCarried,
  harnessChoices,
  harnessLabel,
  NO_TOKEN_ALIAS,
  showsHarnessImageNote,
  tokenOptions,
  withTokenAlias,
} from "./harness";

test("a harness the machine's image lacks is unavailable; before the machine starts, none is", () => {
  assert.equal(harnessCarried(["codex"], "codex"), true);
  assert.equal(harnessCarried(["codex"], "cursor"), false);
  assert.equal(harnessCarried(null, "cursor"), null);
  const published = harnessChoices(["codex"]);
  assert.deepEqual(
    published.filter((option) => "disabled" in option).map((option) => option.value),
    ["claude-code", "cursor"],
  );
  assert.ok(harnessChoices(null).every((option) => !("disabled" in option)));
  assert.ok(harnessChoices(undefined).every((option) => !("disabled" in option)));
});

test("the image note shows while the CLIs are unknown or some are missing", () => {
  assert.equal(showsHarnessImageNote(null), true);
  assert.equal(showsHarnessImageNote(["codex"]), true);
  assert.equal(showsHarnessImageNote(["claude-code", "codex", "cursor"]), false);
  assert.equal(harnessLabel("claude-code"), "Claude Code");
});

function credential(
  harness: HarnessCredential["harness"],
  patch: Partial<HarnessCredential> = {},
): HarnessCredential {
  return {
    harness,
    label: harnessLabel(harness),
    secret: null,
    secret_source: null,
    secret_granted: false,
    secret_shadowed: false,
    login: "login",
    login_seen_at: null,
    login_account: null,
    ...patch,
  };
}

function status(patch: Partial<AgentHarness> = {}): AgentHarness {
  return {
    harness: "claude-code",
    harness_model: null,
    machine_harnesses: ["codex", "claude-code"],
    repositories: ["shop"],
    harnesses: [
      credential("claude-code", {
        secret: "CLAUDE_CODE_OAUTH_TOKEN",
        secret_source: "CLAUDE_CODE_OAUTH_TOKEN",
        secret_granted: true,
      }),
      credential("codex"),
    ],
    ...patch,
  };
}

test("a coding agent with a credential, its harness in the image, and a repository is ready", () => {
  assert.deepEqual(codingProblems(status()), []);
  const login = status({
    harnesses: [credential("claude-code", { login_seen_at: "2026-10-01T00:00:00Z" })],
  });
  assert.deepEqual(codingProblems(login), [], "a login a check found counts");
  assert.deepEqual(
    codingProblems(status({ machine_harnesses: null })),
    [],
    "an image not yet reported is no problem",
  );
});

test("no harness picked is a problem; the image and credential then go unchecked", () => {
  const unpicked = status({
    harness: null,
    harnesses: [credential("claude-code")],
    machine_harnesses: [],
  });
  assert.deepEqual(codingProblems(unpicked), [{ kind: "harness" }]);
  const problems = codingProblems({ ...unpicked, repositories: [] });
  assert.deepEqual(problems, [{ kind: "harness" }, { kind: "repositories" }]);
  assert.equal(
    codingProblemsText(problems),
    "Coding isn't ready: no harness is picked; the guild has no repositories. Fix it in Settings.",
  );
  assert.equal(
    codingProblemsSentence(problems),
    "No harness is picked; the guild has no repositories.",
  );
});

test("a missing credential, a harness the image lacks, and a guild without repositories are each named", () => {
  const problems = codingProblems(
    status({
      harnesses: [credential("claude-code")],
      machine_harnesses: ["codex"],
      repositories: [],
    }),
  );
  assert.deepEqual(
    problems.map((problem) => problem.kind),
    ["image", "credential", "repositories"],
  );
  assert.equal(
    codingProblemsText(problems),
    "Coding isn't ready: this machine's image doesn't carry Claude Code; Claude Code has no credential; the guild has no repositories. Fix it in Settings.",
  );
});

const added = (name: string, by: string | null = "ada") => ({
  name,
  created_by: by ? { kind: "user" as const, id: "u_1", name: by } : null,
});

test("the token picker offers the variable's own secret as the default, else a login, then every other secret", () => {
  const own = tokenOptions("CLAUDE_CODE_OAUTH_TOKEN", [
    added("BOB_TOKEN"),
    added("CLAUDE_CODE_OAUTH_TOKEN", null),
  ]);
  assert.deepEqual(own, [
    { value: "-", label: "CLAUDE_CODE_OAUTH_TOKEN (default)" },
    { value: "BOB_TOKEN", label: "BOB_TOKEN", description: "Added by ada" },
  ]);
  assert.deepEqual(tokenOptions("CLAUDE_CODE_OAUTH_TOKEN", []), [
    { value: "-", label: "None: log in from the CLI tab" },
  ]);
});

test("picking a secret sets the alias; the default or the variable's own name removes it", () => {
  const aliases = { GH_PAT: "BOB_GH" };
  assert.deepEqual(withTokenAlias(aliases, "CLAUDE_CODE_OAUTH_TOKEN", "BOB_TOKEN"), {
    GH_PAT: "BOB_GH",
    CLAUDE_CODE_OAUTH_TOKEN: "BOB_TOKEN",
  });
  const set = { GH_PAT: "BOB_GH", CLAUDE_CODE_OAUTH_TOKEN: "BOB_TOKEN" };
  assert.deepEqual(withTokenAlias(set, "CLAUDE_CODE_OAUTH_TOKEN", NO_TOKEN_ALIAS), aliases);
  assert.deepEqual(
    withTokenAlias(set, "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"),
    aliases,
  );
});

test("a new token takes the variable's name, or the agent's name on it when that is taken", () => {
  assert.equal(
    freeTokenName("CLAUDE_CODE_OAUTH_TOKEN", "code-test", []),
    "CLAUDE_CODE_OAUTH_TOKEN",
  );
  assert.equal(
    freeTokenName("CLAUDE_CODE_OAUTH_TOKEN", "code-test", [added("CLAUDE_CODE_OAUTH_TOKEN")]),
    "CLAUDE_CODE_OAUTH_TOKEN_CODE_TEST",
  );
});

test("the chat strip names the lead model, the harness and its model, what it runs on, and the repositories", () => {
  const now = new Date("2026-05-01T12:00:00Z");
  const ready = status({ harness_model: "opus" });
  assert.deepEqual(
    codingStrip({
      status: ready,
      leadModel: "DeepSeek Flash",
      secrets: [added("CLAUDE_CODE_OAUTH_TOKEN")],
      now,
    }).map((segment) => [segment.text, segment.problem, segment.to]),
    [
      ["DeepSeek Flash leads", false, "model"],
      ["Claude Code · opus codes", false, "harness"],
      ["on CLAUDE_CODE_OAUTH_TOKEN, added by ada", false, "harness"],
      ["repos shop", false, "repositories"],
    ],
  );
  const login = status({
    harnesses: [
      credential("claude-code", {
        login_seen_at: "2026-05-01T10:00:00Z",
        login_account: "ada@example.com",
      }),
    ],
  });
  assert.equal(
    codingStrip({ status: login, leadModel: "x", secrets: [], now })[2]?.text,
    "on its login as ada@example.com, seen 2h ago",
  );
  const bare = status({
    harnesses: [credential("claude-code")],
    machine_harnesses: ["codex"],
    repositories: [],
  });
  assert.deepEqual(
    codingStrip({ status: bare, leadModel: "x", secrets: [], now }).map((segment) => [
      segment.text,
      segment.problem,
    ]),
    [
      ["x leads", false],
      ["Claude Code is not in this machine's image", true],
      ["no credential", true],
      ["no repositories", true],
    ],
  );
  assert.deepEqual(
    codingStrip({ status: status({ harness: null }), leadModel: "x", secrets: [], now }).map(
      (segment) => [segment.text, segment.problem, segment.to],
    ),
    [
      ["x leads", false, "model"],
      ["no harness picked", true, "harness"],
      ["repos shop", false, "repositories"],
    ],
  );
});
