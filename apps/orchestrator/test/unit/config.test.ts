import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, decodeMasterKey, loadConfig, loadToolConfig, parseHarnessesOff } from "../../src/config/index.js";
import { HEX_MASTER_KEY, tempDir, testEnv } from "../helpers/env.js";

test("loadConfig requires env, existing dirs, and a 32-byte master key", () => {
  const notesRoot = tempDir("guilds-notes-");
  const workspaceRoot = tempDir("guilds-workspaces-");
  const env = testEnv("postgresql://agent_platform:agent_platform@127.0.0.1:5432/agent_platform_r1", {
    NOTES_ROOT: notesRoot,
    WORKSPACE_ROOT: workspaceRoot,
  });
  const config = loadConfig(env);
  assert.equal(config.databaseUrl, env.DATABASE_URL);
  assert.equal(config.authMode, "compat-cookie");
  assert.ok(config.templatesRoot.endsWith("src/prompts"));
  assert.equal(config.toolResultMaxBytes, 65536);
});

test("loadConfig rejects missing required values and missing directories", () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL is required/);
  const notesRoot = tempDir("guilds-notes-");
  assert.throws(
    () =>
      loadConfig(
        testEnv("postgresql://example", {
          NOTES_ROOT: notesRoot,
          WORKSPACE_ROOT: "/no/such/workspace-root",
        }),
      ),
    /WORKSPACE_ROOT must be an existing directory/,
  );
});

test("a refused setting throws a ConfigError that names the setting", () => {
  const base = { NOTES_ROOT: tempDir("guilds-notes-"), WORKSPACE_ROOT: tempDir("guilds-workspaces-") };
  const refusals: [NodeJS.ProcessEnv, string][] = [
    [{}, "DATABASE_URL"],
    [testEnv("postgresql://example", { ...base, TEMPLATES_ROOT: "/no/such/templates" }), "TEMPLATES_ROOT"],
    [testEnv("postgresql://example", { ...base, MAX_CONCURRENT_GENERATIONS: "-1" }), "MAX_CONCURRENT_GENERATIONS"],
    [testEnv("postgresql://example", { ...base, SECRETS_MASTER_KEY: "short" }), "SECRETS_MASTER_KEY"],
    [testEnv("postgresql://example", { ...base, AUTH_MODE: "trusted-header" }), "TRUSTED_PROXY_SECRET"],
  ];
  for (const [env, setting] of refusals) {
    assert.throws(
      () => loadConfig(env),
      (error: unknown) => error instanceof ConfigError && error.setting === setting,
      setting,
    );
  }
});

test("loadConfig rejects unknown AUTH_MODE", () => {
  assert.throws(
    () =>
      loadConfig(
        testEnv("postgresql://example", {
          AUTH_MODE: "cookies",
        }),
      ),
    /AUTH_MODE must be/,
  );
});

test("a mode core does not implement is accepted only when an extension names it", () => {
  const env = testEnv("postgresql://example", {
    NOTES_ROOT: tempDir("guilds-notes-"),
    WORKSPACE_ROOT: tempDir("guilds-workspaces-"),
    AUTH_MODE: "session",
  });
  assert.throws(() => loadConfig(env), /AUTH_MODE must be compat-cookie, trusted-header$/);
  assert.equal(loadConfig(env, { authModes: ["session"] }).authMode, "session");
});

test("a command-line tool loads the configuration in whatever mode the box runs in", () => {
  const env = testEnv("postgresql://example", {
    NOTES_ROOT: tempDir("guilds-notes-"),
    WORKSPACE_ROOT: tempDir("guilds-workspaces-"),
    AUTH_MODE: "session",
  });
  assert.throws(() => loadConfig(env), /AUTH_MODE must be/);
  const config = loadToolConfig(env);
  assert.equal(config.authMode, "session");
  assert.equal(config.databaseUrl, "postgresql://example");
  assert.equal(loadToolConfig({ ...env, AUTH_MODE: "compat-cookie" }).authMode, "compat-cookie");
});

test("the all-zero master key is refused outside a development stack", () => {
  const base = {
    NOTES_ROOT: tempDir("guilds-notes-"),
    WORKSPACE_ROOT: tempDir("guilds-workspaces-"),
  };
  const zeros = [
    "0".repeat(64),
    Buffer.alloc(32).toString("base64"),
    Buffer.alloc(32).toString("base64url"),
    "\0".repeat(32),
  ];
  for (const key of zeros) {
    const env = { ...testEnv("postgresql://example", { ...base, SECRETS_MASTER_KEY: key }) };
    delete env.ALLOW_ZERO_MASTER_KEY;
    assert.throws(() => loadConfig(env), /all-zero development key/, JSON.stringify(key));
    assert.throws(() => loadConfig({ ...env, ALLOW_ZERO_MASTER_KEY: "true" }), /all-zero development key/);
    assert.equal(loadConfig({ ...env, ALLOW_ZERO_MASTER_KEY: "1" }).secretsMasterKey, key);
  }
  const real = { ...testEnv("postgresql://example", { ...base, SECRETS_MASTER_KEY: "0".repeat(63) + "1" }) };
  delete real.ALLOW_ZERO_MASTER_KEY;
  assert.equal(loadConfig(real).secretsMasterKey, "0".repeat(63) + "1");
});

test("trusted-header needs the proxy's secret, the host it is reached by, and the operator's email", () => {
  const notesRoot = tempDir("guilds-config-notes-");
  const workspaceRoot = tempDir("guilds-config-ws-");
  const base = { NOTES_ROOT: notesRoot, WORKSPACE_ROOT: workspaceRoot, AUTH_MODE: "trusted-header" };
  assert.throws(() => loadConfig(testEnv("postgresql://example", base)), /TRUSTED_PROXY_SECRET is required/);
  assert.throws(
    () => loadConfig(testEnv("postgresql://example", { ...base, TRUSTED_PROXY_SECRET: "shared" })),
    /PUBLIC_BASE_URL is required when AUTH_MODE=trusted-header/,
  );
  const proxied = { ...base, TRUSTED_PROXY_SECRET: "shared", PUBLIC_BASE_URL: "https://box.tailnet.test" };
  assert.throws(
    () => loadConfig(testEnv("postgresql://example", proxied)),
    /OPERATOR_EMAIL is required when AUTH_MODE=trusted-header/,
  );
  const config = loadConfig(testEnv("postgresql://example", { ...proxied, OPERATOR_EMAIL: " Operator@Example.com " }));
  assert.equal(config.authMode, "trusted-header");
  assert.equal(config.publicBaseUrl, "https://box.tailnet.test");
  assert.equal(config.operatorEmail, "operator@example.com");
});

test("the operator's email is optional without a proxy, and must be an address when set", () => {
  const base = { NOTES_ROOT: tempDir("guilds-config-notes-"), WORKSPACE_ROOT: tempDir("guilds-config-ws-") };
  assert.equal(loadConfig(testEnv("postgresql://example", base)).operatorEmail, "");
  assert.equal(
    loadConfig(testEnv("postgresql://example", { ...base, OPERATOR_EMAIL: "operator@example.com" })).operatorEmail,
    "operator@example.com",
  );
  for (const bad of ["operator", "operator@", "two words@example.com", "a@b@c"]) {
    assert.throws(
      () => loadConfig(testEnv("postgresql://example", { ...base, OPERATOR_EMAIL: bad })),
      /OPERATOR_EMAIL must be an email address/,
      bad,
    );
  }
});

test("decodeMasterKey accepts hex, base64, url-safe base64, and 32-byte ASCII", () => {
  const hex = decodeMasterKey(HEX_MASTER_KEY);
  assert.equal(hex.length, 32);
  assert.deepEqual(hex, Buffer.alloc(32));
  const spaced = decodeMasterKey(`${"00 ".repeat(32).trim()}`);
  assert.deepEqual(spaced, Buffer.alloc(32));
  const ascii = "a".repeat(32);
  assert.deepEqual(decodeMasterKey(ascii), Buffer.from(ascii, "ascii"));
  const standard = Buffer.alloc(32, 7).toString("base64");
  assert.deepEqual(decodeMasterKey(standard), Buffer.alloc(32, 7));
  const url = Buffer.alloc(32, 9).toString("base64").replaceAll("+", "-").replaceAll("/", "_");
  assert.deepEqual(decodeMasterKey(url), Buffer.alloc(32, 9));
  assert.throws(() => decodeMasterKey("short"), /32 bytes/);
  assert.throws(() => decodeMasterKey(""), /required/);
});

test("HARNESSES_OFF names harnesses separated by commas or spaces, each once, in order", () => {
  assert.deepEqual(parseHarnessesOff("codex, cursor  codex,antigravity"), ["codex", "cursor", "antigravity"]);
  assert.deepEqual(
    loadConfig(testEnv("postgresql://example", { HARNESSES_OFF: "cursor" })).harnessesOff,
    ["cursor"],
  );
});

test("an unset or blank HARNESSES_OFF turns no harness off", () => {
  assert.deepEqual(parseHarnessesOff(undefined), []);
  assert.deepEqual(parseHarnessesOff(" , "), []);
});

test("a name in HARNESSES_OFF that is not a harness fails the configuration", () => {
  assert.throws(() => parseHarnessesOff("codex claude"), {
    message: "HARNESSES_OFF names an unknown harness claude: use claude-code, codex, cursor, antigravity",
  });
  assert.throws(
    () => loadConfig(testEnv("postgresql://example", { HARNESSES_OFF: "claude" })),
    /HARNESSES_OFF names an unknown harness claude/,
  );
});
