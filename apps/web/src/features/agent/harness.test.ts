import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentHarness, HarnessCatalog, HarnessCredential } from "../../api/types/agents";
import {
  catalogFor,
  defaultEffortLabel,
  freeTokenName,
  harnessCarried,
  harnessChoices,
  harnessEffortsFor,
  harnessLabel,
  harnessOffered,
  harnessProblems,
  harnessProblemsSentence,
  missingRepositoryText,
  needsRepository,
  harnessOptions,
  isHarnessEffort,
  listedHarnessModel,
  NO_TOKEN_ALIAS,
  showsHarnessImageNote,
  tokenOptions,
  withTokenAlias,
} from "./harness";

test("a reasoning effort a harness runs at is an effort; any other value is not", () => {
  assert.equal(isHarnessEffort("xhigh"), true);
  assert.equal(isHarnessEffort("extreme"), false);
  assert.equal(isHarnessEffort("toString"), false);
  assert.equal(isHarnessEffort(3), false);
});

test("every harness is offered as an option under its label", () => {
  assert.deepEqual(
    harnessOptions.map((option) => option.value),
    ["claude-code", "codex", "cursor", "antigravity"],
  );
  assert.equal(harnessOptions[0]?.label, "Claude Code");
});

test("a harness the machine's image lacks is unavailable; before the machine starts, none is", () => {
  assert.equal(harnessCarried(["codex"], "codex"), true);
  assert.equal(harnessCarried(["codex"], "cursor"), false);
  assert.equal(harnessCarried(null, "cursor"), null);
  const published = harnessChoices(["codex"]);
  assert.deepEqual(
    published.filter((option) => "disabled" in option).map((option) => option.value),
    ["claude-code", "cursor", "antigravity"],
  );
  assert.ok(harnessChoices(null).every((option) => !("disabled" in option)));
  assert.ok(harnessChoices(undefined).every((option) => !("disabled" in option)));
});

test("the image note shows while the CLIs are unknown or some are missing", () => {
  assert.equal(showsHarnessImageNote(null), true);
  assert.equal(showsHarnessImageNote(["codex"]), true);
  assert.equal(showsHarnessImageNote(["claude-code", "codex", "cursor"]), true);
  assert.equal(showsHarnessImageNote(["claude-code", "codex", "cursor", "antigravity"]), false);
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
    harness_effort: null,
    machine_harnesses: ["codex", "claude-code"],
    repositories: ["shop"],
    usable_repositories: ["shop"],
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

test("a subscription agent with a credential and its harness in the image is ready", () => {
  assert.deepEqual(harnessProblems(status()), []);
  const login = status({
    harnesses: [credential("claude-code", { login_seen_at: "2026-10-01T00:00:00Z" })],
  });
  assert.deepEqual(harnessProblems(login), [], "a login a check found counts");
  assert.deepEqual(
    harnessProblems(status({ machine_harnesses: null })),
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
  assert.deepEqual(harnessProblems(unpicked), [{ kind: "harness" }]);
  assert.equal(harnessProblemsSentence(harnessProblems(unpicked)), "No harness is picked.");
});

test("a missing credential and a harness the image lacks are each named", () => {
  const problems = harnessProblems(
    status({ harnesses: [credential("claude-code")], machine_harnesses: ["codex"] }),
  );
  assert.deepEqual(
    problems.map((problem) => problem.kind),
    ["image", "credential"],
  );
  assert.equal(
    harnessProblemsSentence(problems),
    "This machine's image doesn't carry Claude Code; Claude Code has no credential.",
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

const CATALOG: HarnessCatalog[] = [
  {
    harness: "codex",
    label: "Codex",
    enabled: true,
    needs_repository: false,
    models: [
      { id: "gpt-6-luna", label: "GPT-6-Luna", efforts: ["low", "high"], default_effort: "low" },
    ],
    unlisted_efforts: ["minimal", "low", "high"],
  },
  {
    harness: "cursor",
    label: "Cursor",
    enabled: false,
    needs_repository: true,
    models: [{ id: "composer-2.5", label: "Composer 2.5", efforts: [], default_effort: null }],
    unlisted_efforts: [],
  },
];

test("a harness runs a listed model at its efforts, and any other at the efforts the harness takes", () => {
  const codex = catalogFor(CATALOG, "codex");
  assert.equal(listedHarnessModel(codex, "gpt-6-luna")?.label, "GPT-6-Luna");
  assert.equal(listedHarnessModel(codex, "gpt-custom"), undefined);
  assert.deepEqual(harnessEffortsFor(codex, "gpt-6-luna"), ["low", "high"]);
  assert.deepEqual(harnessEffortsFor(codex, ""), ["minimal", "low", "high"]);
  assert.deepEqual(harnessEffortsFor(catalogFor(CATALOG, "cursor"), "composer-2.5"), []);
  assert.deepEqual(harnessEffortsFor(undefined, "gpt-6-luna"), [], "before the catalogue loads");
  assert.equal(catalogFor(undefined, "codex"), undefined);
});

test("a harness the box turns off is offered only to an agent already on it", () => {
  assert.equal(harnessOffered(CATALOG, "codex", ""), true);
  assert.equal(harnessOffered(CATALOG, "cursor", ""), false);
  assert.equal(harnessOffered(CATALOG, "cursor", "codex"), false);
  assert.equal(harnessOffered(CATALOG, "cursor", "cursor"), true);
  assert.equal(harnessOffered(undefined, "cursor", ""), true, "before the catalogue loads");
  assert.equal(
    harnessOffered(CATALOG, "antigravity", ""),
    true,
    "a harness the catalogue does not name",
  );
});

test("leaving the effort unset names the model's default effort, else the harness's", () => {
  const codex = catalogFor(CATALOG, "codex");
  assert.equal(defaultEffortLabel(listedHarnessModel(codex, "gpt-6-luna")), "Default (Low)");
  assert.equal(defaultEffortLabel(undefined), "Harness default");
});

test("a subscription agent needs a repository on the harnesses the catalogue says, on none before it loads", () => {
  assert.equal(needsRepository(CATALOG, "codex"), false);
  assert.equal(needsRepository(CATALOG, "cursor"), true);
  assert.equal(needsRepository(undefined, "cursor"), false);
});

test("why a subscription agent without a repository cannot run on a harness names each that needs one", () => {
  assert.equal(
    missingRepositoryText(["cursor"]),
    "Cursor keeps its own system prompt, so it runs a subscription agent only with a repository.",
  );
  assert.equal(
    missingRepositoryText(["cursor", "antigravity"]),
    "Cursor and Antigravity keep their own system prompt, so they run a subscription agent only with a repository.",
  );
});

test("a harness's problems leave out the repositories only code tasks need", () => {
  assert.deepEqual(harnessProblems(status({ harness: null, repositories: [] })), [
    { kind: "harness" },
  ]);
});
