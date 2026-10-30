import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { agentHome } from "../../src/lib/agent-file.js";
import { slotPorts } from "../../src/machines/index.js";
import {
  RunSandboxes,
  agentSandbox,
  applyRunScripts,
  prepareBrowserWorkspace,
  prepareWorkspace,
  seatEnvironment,
  type AgentSeat,
  type MachineSpec,
} from "../../src/sandbox/index.js";
import type { SandboxHandle } from "../../src/sandbox/sdk.js";
import { invokeTool } from "../../src/toolbox/index.js";
import { HEX_MASTER_KEY } from "../helpers/env.js";
import { gated, run, startOpenSandboxServer, stdoutOf } from "../helpers/opensandbox-server.js";
import { toolFixture } from "../helpers/toolbox.js";

const IMAGE = process.env.CONTRACT_RUNTIME_IMAGE ?? "agent-runtime:0.4";
const imageMissing =
  gated || (run("docker", ["image", "inspect", IMAGE], false).status !== 0 ? `build ${IMAGE} first (make runtime-image)` : false);

const MACHINE: MachineSpec = { id: "mach_contract", orgId: "org_contract", box: "code", cpu: 2, memoryMib: 4096 };

function seat(agentId: string, slot: number): AgentSeat {
  return { agentId, machineId: MACHINE.id, slot, browserLanguage: "en-US" };
}

/** The machine's sandbox as one agent's commands see it, with these secrets. */
function view(sandbox: SandboxHandle, agent: AgentSeat, secrets: Record<string, string>): SandboxHandle {
  return agentSandbox(sandbox, agentHome(agent.agentId), { ...secrets, ...seatEnvironment(agent) });
}

test("two agents share one machine: each runs in its own home, with its own secrets and terminal", { skip: imageMissing }, async () => {
  process.env.SECRETS_MASTER_KEY ??= HEX_MASTER_KEY;
  const server = await startOpenSandboxServer();
  const sandboxes = new RunSandboxes({
    url: server.url,
    apiKey: server.apiKey,
    image: IMAGE,
    workspaceRoot: server.workspaceRoot,
  });
  await sandboxes.start();
  const left = seat("a_contract_left", 0);
  const right = seat("a_contract_right", 1);
  const script = {
    id: "scr_contract",
    name: "greet",
    description: "Greets whoever is named",
    parameters: null,
    source: "import json, os, sys\nargs = json.load(sys.stdin)\nprint('hello ' + args.get('who', 'nobody') + ' ' + os.getcwd())\n",
    source_hash: "contract",
  };
  try {
    for (const agent of [left, right]) {
      prepareWorkspace(server.workspaceRoot, MACHINE.id, agent.agentId);
    }
    const machine = await sandboxes.ensure(MACHINE);
    const again = await sandboxes.ensure(MACHINE);
    assert.equal(again.id, machine.id, "one container per machine");
    const leftSecrets = { CONTRACT_TOKEN: "tok-left-1234" };
    const leftView = view(machine, left, leftSecrets);
    await applyRunScripts(leftView, agentHome(left.agentId), [script]);
    const ctx = toolFixture({
      run_id: "r_contract_left",
      agent_id: left.agentId,
      guild_id: "g_1",
      sandbox: leftView,
      secrets: leftSecrets,
      run_scripts: [script],
    });
    const [payload] = await invokeTool(
      ctx.services, ctx.run, ctx.hooks,
      { id: "call_1", type: "function", function: { name: "script_run", arguments: JSON.stringify({ name: "greet", arguments: { who: "left" } }) } },
    );
    assert.equal(String(payload.content).split("\n")[0], `hello left ${agentHome(left.agentId)}`);
    const rightEnv = await view(machine, right, {}).commands.run("echo \"$HOME|$PORT|${CONTRACT_TOKEN:-none}\"", {
      timeoutSeconds: 20,
    });
    assert.equal(stdoutOf(rightEnv).trim(), `${agentHome(right.agentId)}|${slotPorts(1).portsFrom}|none`);

    const leftToken = await sandboxes.startCli(machine, left);
    const rightToken = await sandboxes.startCli(machine, right);
    assert.match(leftToken, /^[0-9a-f]{48}$/);
    assert.notEqual(leftToken, rightToken, "each agent has its own terminal");
    await sandboxes.purgeAgent(machine, left);
    const gone = await machine.commands.run(`test -e /run/guilds/${left.agentId} && echo there || echo gone`, {
      timeoutSeconds: 10,
    });
    assert.equal(stdoutOf(gone).trim(), "gone");
  } finally {
    await sandboxes.destroy(MACHINE.id).catch(() => undefined);
    await sandboxes.close();
    await server.stop();
  }
});

test("two agents on one machine each run their own Chrome, on their own ports and profile", { skip: imageMissing }, async () => {
  process.env.SECRETS_MASTER_KEY ??= HEX_MASTER_KEY;
  const server = await startOpenSandboxServer();
  const sandboxes = new RunSandboxes({
    url: server.url,
    apiKey: server.apiKey,
    image: IMAGE,
    workspaceRoot: server.workspaceRoot,
  });
  await sandboxes.start();
  const left = seat("a_contract_left", 0);
  const right = { ...seat("a_contract_right", 1), browserLanguage: "fr-FR" };
  try {
    for (const agent of [left, right]) {
      prepareBrowserWorkspace(server.workspaceRoot, MACHINE.id, agent.agentId);
    }
    const machine = await sandboxes.ensure(MACHINE);
    await sandboxes.startBrowser(machine, left);
    await sandboxes.startBrowser(machine, right);
    for (const [agent, page] of [
      [left, "data:text/html,<title>left</title>"],
      [right, "data:text/html,<title>right</title>"],
    ] as const) {
      const ctx = toolFixture({
        run_id: "r_contract_browser",
        agent_id: agent.agentId,
        guild_id: "g_1",
        sandbox: view(machine, agent, {}),
        secrets: {},
        cdp_port: slotPorts(agent.slot).cdp,
      });
      const [payload] = await invokeTool(
        ctx.services, ctx.run, ctx.hooks,
        { id: "call_1", type: "function", function: { name: "browser_navigate", arguments: JSON.stringify({ url: page }) } },
      );
      assert.doesNotMatch(String(payload.content), /error/i, String(payload.content));
    }
    const titles = async (agent: AgentSeat) =>
      stdoutOf(await machine.commands.run(`curl -sf http://127.0.0.1:${slotPorts(agent.slot).cdp}/json/list`, { timeoutSeconds: 10 }));
    assert.match(await titles(left), /"title": "left"/);
    assert.doesNotMatch(await titles(left), /"title": "right"/);
    assert.match(await titles(right), /"title": "right"/);
    const profiles = await machine.commands.run(`ls -d /home/${left.agentId}/.browser/Default /home/${right.agentId}/.browser/Default`, {
      timeoutSeconds: 10,
    });
    assert.equal(stdoutOf(profiles).trim().split("\n").length, 2, "each agent keeps its own profile in its home");

    // One agent's Chrome stops; the other's keeps answering.
    await sandboxes.stopBrowser(machine, left);
    const ports = await machine.commands.run(
      `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${slotPorts(left.slot).cdp}/json/version; echo; ` +
        `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${slotPorts(right.slot).cdp}/json/version`,
      { timeoutSeconds: 10 },
    );
    assert.deepEqual(stdoutOf(ports).trim().split("\n"), ["000", "200"]);
    // A second start on a live browser is a no-op that answers at once.
    await sandboxes.startBrowser(machine, right);
  } finally {
    await sandboxes.destroy(MACHINE.id).catch(() => undefined);
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
  const coder = seat(agentId, 0);
  const home = agentHome(agentId);
  try {
    prepareWorkspace(server.workspaceRoot, MACHINE.id, agentId);
    const machine = await sandboxes.ensure(MACHINE);
    const secrets = { CONTRACT_TOKEN: "tok-contract-1234" };
    const sandbox = view(machine, coder, secrets);
    const ctx = toolFixture({ run_id: "r_contract", agent_id: agentId, guild_id: "g_1", sandbox, secrets });
    let count = 0;
    const call = async (name: string, args: Record<string, unknown>) => {
      count += 1;
      const [payload, metadata] = await invokeTool(
        ctx.services, ctx.run, ctx.hooks,
        { id: `call_${count}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
      );
      return { text: String(payload.content), metadata };
    };

    const shellHome = await call("shell", { command: "echo $HOME; node --version; echo $CONTRACT_TOKEN; mkdir -p repos/demo && cd repos/demo" });
    assert.equal(shellHome.text.split("\n")[0], home);
    assert.match(shellHome.text, /\nv24\.\d+\.\d+\n\[REDACTED:CONTRACT_TOKEN\]$/);
    assert.equal(shellHome.metadata.cwd, `${home}/repos/demo`);

    const long = await call("shell", { command: "seq 1 20000" });
    assert.ok(Buffer.byteLength(long.text) <= 8192);
    assert.match(long.text, /^1\n2\n/);
    assert.match(long.text, /\n20000$/);
    assert.equal(long.metadata.log_path, `${home}/.runs/r_contract/call_2.log`);

    // Past the inline limit, under Linux's 128 KiB for one argument: the request goes through the file API.
    const content = `${"x".repeat(100 * 1024)}\n`;
    const wrote = await call("shell", { command: `printf '%s\\n' ${"x".repeat(100 * 1024)} > big.txt && wc -c < big.txt` });
    assert.equal(wrote.text.trim(), String(content.length));
    const onHost = path.join(server.workspaceRoot, MACHINE.id, agentId, "repos/demo/big.txt");
    assert.equal(readFileSync(onHost, "utf8"), content);

    await call("shell", { command: "printf 'export const a = 2;\\n' > a.ts" });
    const read = await call("file_read", { path: "a.ts" });
    assert.equal(read.text, "a.ts · lines 1–1 of 1\n1  export const a = 2;");

    await call("shell", {
      command:
        `mkdir -p ${home}/repos/shop/src && cd ${home}/repos/shop && ` +
        "printf 'export function cents(amount: number): number {\\n  return Math.round(amount * 100);\\n}\\n' > src/money.ts && " +
        "printf 'import { cents } from \"./money\";\\n\\n// validate the refund amount\\nexport function validateRefund(amount: number): number {\\n  if (amount <= 0) throw new Error(\"refund must be positive\");\\n  return cents(amount);\\n}\\n' > src/refund.ts && " +
        "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init",
    });

    const files = await call("code_search", { pattern: "refund" });
    assert.equal(files.text, "src/refund.ts: 2\n2 matches in 1 files");
    const lines = await call("code_search", { pattern: "cents\\(", mode: "content" });
    assert.match(lines.text, /src\/refund\.ts:6: {3}return cents\(amount\);/);
    for (const removed of ["graft", "ast-grep"]) {
      const missing = await call("shell", { command: `command -v ${removed} || echo none` });
      assert.equal(missing.text, "none", `${removed} is not in the image`);
    }
    const carried = await call("shell", { command: "cat /usr/local/share/guilds/harnesses; command -v codex >/dev/null && echo codex-cli" });
    assert.match(carried.text, /^codex\n/);
    assert.ok(carried.text.endsWith("codex-cli"));
    assert.deepEqual(sandboxes.harnessesOf(MACHINE.id), carried.text.split("\n").slice(0, -1));
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
        path: `/run/guilds/${agentId}/git-tokens.json`,
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
    await sandboxes.destroy(MACHINE.id).catch(() => undefined);
    await sandboxes.close();
    await server.stop();
  }
});
