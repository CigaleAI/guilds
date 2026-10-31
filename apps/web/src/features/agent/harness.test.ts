import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentHarness, HarnessCatalog, HarnessCredential } from "../../api/types/agents";
import {
  catalogFor,
  codingProblems,
  codingProblemsSentence,
  codingProblemsText,
  codingStrip,
  defaultEffortLabel,
  freeTokenName,
  harnessCarried,
  harnessChoices,
  harnessEffortsFor,
  harnessLabel,
  harnessOffered,
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

test("the chat strip shows the harness, whether it can sign in, and how many repositories it reaches", () => {
  const now = new Date("2026-05-01T12:00:00Z");
  const parts = (state: ReturnType<typeof codingStrip>) =>
    [state.harnessPart, state.credential, state.repositories].map((part) =>
      part ? [part.text, part.detail, part.problem] : null,
    );
  const ready = status({ harness_model: "opus", repositories: ["shop", "site"] });
  const onSecret = codingStrip({ status: ready, secrets: [added("CLAUDE_CODE_OAUTH_TOKEN")], now });
  assert.equal(onSecret.harness, "claude-code");
  assert.deepEqual(onSecret.repositories.names, ["shop", "site"]);
  assert.deepEqual(parts(onSecret), [
    ["Claude Code", "Claude Code codes with opus.", false],
    [
      "Token CLAUDE_CODE_OAUTH_TOKEN",
      "Runs on the secret CLAUDE_CODE_OAUTH_TOKEN, added by ada.",
      false,
    ],
    ["2 repos", "shop, site", false],
  ]);
  const effort = codingStrip({ status: { ...ready, harness_effort: "xhigh" }, secrets: [], now });
  assert.equal(effort.harnessPart?.detail, "Claude Code codes with opus at extra high effort.");
  const plain = codingStrip({ status: status(), secrets: [], now });
  assert.equal(plain.harnessPart?.detail, "Claude Code codes with its default model.");
  const login = status({
    harnesses: [
      credential("claude-code", {
        login_seen_at: "2026-05-01T10:00:00Z",
        login_account: "ada@example.com",
      }),
    ],
  });
  assert.deepEqual(codingStrip({ status: login, secrets: [], now }).credential, {
    text: "Logged in",
    detail: "Logged in as ada@example.com, seen 2h ago.",
    problem: false,
  });
  const bare = status({
    harnesses: [credential("claude-code")],
    machine_harnesses: ["codex"],
    repositories: [],
  });
  assert.deepEqual(
    parts(codingStrip({ status: bare, secrets: [], now })).map((part) => [part?.[0], part?.[2]]),
    [
      ["Claude Code is not in this machine's image", true],
      ["Not logged in", true],
      ["No repos", true],
    ],
  );
  const unpicked = codingStrip({ status: status({ harness: null }), secrets: [], now });
  assert.equal(unpicked.harness, null);
  assert.equal(unpicked.credential, null);
  assert.deepEqual(
    [unpicked.harnessPart.text, unpicked.harnessPart.problem, unpicked.repositories.text],
    ["No harness picked", true, "1 repo"],
  );
});

const CATALOG: HarnessCatalog[] = [
  {
    harness: "codex",
    label: "Codex",
    enabled: true,
    models: [
      { id: "gpt-6-luna", label: "GPT-6-Luna", efforts: ["low", "high"], default_effort: "low" },
    ],
    unlisted_efforts: ["minimal", "low", "high"],
  },
  {
    harness: "cursor",
    label: "Cursor",
    enabled: false,
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
