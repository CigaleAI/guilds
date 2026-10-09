import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { RunSandboxes } from "../../src/sandbox/index.js";
import { createToolContext, invokeTool } from "../../src/toolbox/index.js";
import { HEX_MASTER_KEY } from "../helpers/env.js";
import { gated, run, startOpenSandboxServer, stdoutOf } from "../helpers/opensandbox-server.js";

const IMAGE = process.env.CONTRACT_RUNTIME_IMAGE ?? "agent-runtime:0.3";
const IMAGE_LITE = process.env.CONTRACT_RUNTIME_IMAGE_LITE ?? "agent-runtime-lite:0.1";
const imageMissing =
  gated || (run("docker", ["image", "inspect", IMAGE], false).status !== 0 ? `build ${IMAGE} first (make runtime-image)` : false);
const liteImageMissing =
  gated ||
  (run("docker", ["image", "inspect", IMAGE_LITE], false).status !== 0
    ? `build ${IMAGE_LITE} first (make runtime-lite-image)`
    : false);

test("a lite agent runs its scripts and its terminal in the lite image, which has no toolchain", { skip: liteImageMissing }, async () => {
  process.env.SECRETS_MASTER_KEY ??= HEX_MASTER_KEY;
  const server = await startOpenSandboxServer();
  const sandboxes = new RunSandboxes({
    url: server.url,
    apiKey: server.apiKey,
    image: IMAGE,
    imageLite: IMAGE_LITE,
    workspaceRoot: server.workspaceRoot,
  });
  await sandboxes.start();
  const agentId = "a_contract_lite";
  const script = {
    id: "scr_contract",
    name: "greet",
    description: "Greets whoever is named",
    parameters: null,
    source: "import json, sys\nargs = json.load(sys.stdin)\nprint('hello ' + args.get('who', 'nobody'))\n",
    source_hash: "contract",
  };
  try {
    const sandbox = await sandboxes.ensure(agentId, { CONTRACT_TOKEN: "tok-contract-1234" }, [], { scripts: [script] });
    const secrets = { CONTRACT_TOKEN: "tok-contract-1234" };
    const ctx = createToolContext({
      run_id: "r_contract_lite",
      agent_id: agentId,
      guild_id: "g_1",
      sandbox,
      secrets,
      run_scripts: [script],
    });
    const [payload] = await invokeTool(
      ctx,
      { id: "call_1", function: { name: "script_run", arguments: JSON.stringify({ name: "greet", arguments: { who: "lite" } }) } },
      secrets,
      32768,
    );
    assert.match(String(payload.content), /hello lite/);

    const token = await sandboxes.startCli(sandbox);
    assert.match(token, /^[0-9a-f]{48}$/);

    const absent = await sandbox.commands.run(
      "for tool in node chromium google-chrome gh mise graft guilds-code guilds-browser gcc; do command -v $tool >/dev/null 2>&1 && echo \"has $tool\"; done; echo done",
      { timeoutSeconds: 20 },
    );
    assert.equal(stdoutOf(absent).trim(), "done");
  } finally {
    await sandboxes.destroy(agentId).catch(() => undefined);
    await sandboxes.close();
    await server.stop();
  }
});

test("coding tools run through execd in the runtime image", { skip: imageMissing }, async () => {
  process.env.SECRETS_MASTER_KEY ??= HEX_MASTER_KEY;
  const server = await startOpenSandboxServer();
  const sandboxes = new RunSandboxes({
    url: server.url,
    apiKey: server.apiKey,
    image: IMAGE,
    workspaceRoot: server.workspaceRoot,
  });
  await sandboxes.start();
  const agentId = "a_contract_coder";
  try {
    const sandbox = await sandboxes.ensure(agentId, { CONTRACT_TOKEN: "tok-contract-1234" }, [], { coding: true });
    const secrets = { CONTRACT_TOKEN: "tok-contract-1234" };
    const ctx = createToolContext({ run_id: "r_contract", agent_id: agentId, guild_id: "g_1", sandbox, secrets });
    let count = 0;
    const call = async (name: string, args: Record<string, unknown>) => {
      count += 1;
      const [payload, metadata] = await invokeTool(
        ctx,
        { id: `call_${count}`, function: { name, arguments: JSON.stringify(args) } },
        secrets,
        32768,
      );
      return { text: String(payload.content), metadata };
    };

    const home = await call("shell", { command: "echo $HOME; node --version; echo $CONTRACT_TOKEN; mkdir -p repos/demo && cd repos/demo" });
    assert.match(home.text, /^\/home\/agent\nv24\.\d+\.\d+\n\[REDACTED:CONTRACT_TOKEN\]$/);
    assert.equal(home.metadata.cwd, "/home/agent/repos/demo");

    const long = await call("shell", { command: "seq 1 20000" });
    assert.ok(Buffer.byteLength(long.text) <= 8192);
    assert.match(long.text, /^1\n2\n/);
    assert.match(long.text, /\n20000$/);
    assert.equal(long.metadata.log_path, "/home/agent/.runs/r_contract/call_2.log");

    const content = `${"x".repeat(150 * 1024)}\n`;
    const wrote = await call("file_write", { path: "big.txt", content });
    assert.equal(wrote.text, "wrote big.txt (1 lines)");
    const onHost = path.join(server.workspaceRoot, agentId, "repos/demo/big.txt");
    assert.equal(readFileSync(onHost, "utf8"), content);

    await call("file_write", { path: "a.ts", content: "export const a = 1;\n" });
    const edited = await call("file_edit", { path: "a.ts", old_string: "= 1", new_string: "= 2" });
    assert.equal(edited.text, "edited a.ts (+1 −1)");
    const read = await call("file_read", { path: "a.ts" });
    assert.equal(read.text, "a.ts · lines 1–1 of 1\n1  export const a = 2;");

    await call("file_write", {
      path: "/home/agent/repos/shop/src/money.ts",
      content: "export function cents(amount: number): number {\n  return Math.round(amount * 100);\n}\n",
    });
    await call("file_write", {
      path: "/home/agent/repos/shop/src/refund.ts",
      content:
        "import { cents } from \"./money\";\n\n// validate the refund amount\nexport function validateRefund(amount: number): number {\n  if (amount <= 0) throw new Error(\"refund must be positive\");\n  return cents(amount);\n}\n",
    });
    await call("shell", { command: "cd /home/agent/repos/shop && git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init" });

    const map = await call("code_map", { repo: "shop" });
    assert.match(map.text, /^shop \(\.\): 2 files · 2 symbols · \d+ edges · typescript\n/);
    assert.match(map.text, /cents · function · src\/money\.ts:1-3 · 1 refs/);
    const files = await call("code_search", { pattern: "refund" });
    assert.equal(files.text, "src/refund.ts: 2\n2 matches in 1 files");
    const lines = await call("code_search", { pattern: "cents\\(", mode: "content" });
    assert.match(lines.text, /src\/refund\.ts:6: {3}return cents\(amount\);/);
    const symbols = await call("code_search", { pattern: "positive", mode: "symbols" });
    assert.match(symbols.text, /^validateRefund · function · src\/refund\.ts:4-7 · 0 refs\n {2}5: if \(amount <= 0\)/);
    const match = await call("code_match", { pattern: "cents($A)" });
    assert.match(match.text, /src\/refund\.ts:6: return cents\(amount\);/);
    const found = await call("code_find", { question: "where is the refund amount validated", limit: 2 });
    assert.match(found.text, /^1\. validateRefund · function · src\/refund\.ts:4-7/);
    const outline = await call("code_outline", { path: "src/refund.ts" });
    assert.match(outline.text, /^src\/refund\.ts · 1 symbols\n {6}4-7 {2}function validateRefund\(amount: number\): number$/);
    const callers = await call("code_callers", { symbol: "cents" });
    assert.match(callers.text, /^cents · function · src\/money\.ts:1-3\n/);
    assert.match(callers.text, /\n {2}← validateRefund · function · src\/refund\.ts:4-7/);
    const clean = await call("shell", { command: "git status --porcelain" });
    assert.equal(clean.text, "(no output)");

    // A commit made through shell names the run and the agent; the checkpoints leave the index alone.
    const identity = await call("shell", {
      command:
        "git config --global user.name coder && git config --global user.email coder@agents.guilds.invalid && " +
        "echo more >> src/refund.ts && git add src/refund.ts && git commit -qm 'Refund rule' && git log -1 --format=%B",
    });
    assert.match(identity.text, /^Refund rule\n\nGuild-Run: r_contract\nGuild-Agent: a_contract_coder$/);

    // git asks the credential helper for the repository's own token; gh gets it as GH_TOKEN.
    await sandbox.files!.writeFiles([
      {
        path: "/run/guilds/git-tokens.json",
        data: JSON.stringify({
          repositories: { shop: { token: "ghs_contract", expires_at: "2099-01-01T00:00:00Z", host: "github.com", path: "acme/shop" } },
        }),
      },
    ]);
    const fill = await call("shell", {
      command: "printf 'protocol=https\\nhost=github.com\\npath=acme/shop.git\\n\\n' | git credential fill",
    });
    assert.match(fill.text, /username=x-access-token\npassword=ghs_contract/);
    const other = await call("shell", {
      command: "printf 'protocol=https\\nhost=github.com\\npath=acme/else.git\\n\\n' | git credential fill 2>&1; true",
    });
    assert.doesNotMatch(other.text, /ghs_contract/);
    // What `gh auth setup-git` writes into the agent's home drops every helper before it; the
    // platform's still answers, and without GH_TOKEN the CLI's helper has nothing to give.
    const overridden = await call("shell", {
      command:
        "git config --global credential.https://github.com.helper '' && " +
        "git config --global --add credential.https://github.com.helper '!gh auth git-credential' && " +
        "printf 'protocol=https\\nhost=github.com\\npath=acme/shop.git\\n\\n' | env -u GH_TOKEN git credential fill 2>&1; true",
    });
    assert.match(overridden.text, /username=x-access-token\npassword=ghs_contract/);
    const gh = await call("shell", { command: "echo \"$GH_TOKEN\"" });
    assert.equal(gh.text, "ghs_contract");

    const started = await call("shell", { command: "echo up; sleep 60", background: true });
    assert.equal(started.metadata.background_id, "b1");
    const status = await call("shell_status", { id: "b1", stop: true });
    assert.match(status.text, /^b1 {2}stopped /);
  } finally {
    await sandboxes.destroy(agentId).catch(() => undefined);
    await sandboxes.close();
    await server.stop();
  }
});
