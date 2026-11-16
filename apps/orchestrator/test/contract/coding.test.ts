import assert from "node:assert/strict";
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

test("the runtime image carries Node, the harness list, git's commit trailers and its credential helper", { skip: imageMissing }, async () => {
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
    const sandbox = view(machine, coder, { CONTRACT_TOKEN: "tok-contract-1234" });
    const sh = async (command: string) => stdoutOf(await sandbox.commands.run(command, { timeoutSeconds: 60 })).trim();

    const shellHome = await sh("echo $HOME; node --version; echo $CONTRACT_TOKEN");
    assert.match(shellHome, new RegExp(`^${home}\\nv24\\.\\d+\\.\\d+\\ntok-contract-1234$`));
    for (const removed of ["graft", "ast-grep"]) {
      assert.equal(await sh(`command -v ${removed} || echo none`), "none", `${removed} is not in the image`);
    }
    const carried = await sh("cat /usr/local/share/guilds/harnesses; command -v codex >/dev/null && echo codex-cli");
    assert.match(carried, /^codex\n/);
    assert.ok(carried.endsWith("codex-cli"));
    assert.deepEqual(sandboxes.harnessesOf(MACHINE.id), carried.split("\n").slice(0, -1));

    // A commit made in a run names the run and the agent.
    const identity = await sh(
      `mkdir -p ${home}/repos/shop && cd ${home}/repos/shop && git init -q && ` +
        "git config --global user.name coder && git config --global user.email coder@agents.guilds.invalid && " +
        "echo rule > refund.ts && git add refund.ts && " +
        "GUILD_RUN_ID=r_contract GUILD_AGENT_ID=a_contract_coder git commit -qm 'Refund rule' && git log -1 --format=%B",
    );
    assert.match(identity, /^Refund rule\n\nGuild-Run: r_contract\nGuild-Agent: a_contract_coder$/);

    // git asks the credential helper for the repository's own token.
    await sandbox.files!.writeFiles([
      {
        path: `/run/guilds/${agentId}/git-tokens.json`,
        data: JSON.stringify({
          repositories: { shop: { token: "ghs_contract", expires_at: "2099-01-01T00:00:00Z", host: "github.com", path: "acme/shop" } },
        }),
      },
    ]);
    const fill = await sh("printf 'protocol=https\\nhost=github.com\\npath=acme/shop.git\\n\\n' | git credential fill");
    assert.match(fill, /username=x-access-token\npassword=ghs_contract/);
    const other = await sh("printf 'protocol=https\\nhost=github.com\\npath=acme/else.git\\n\\n' | git credential fill 2>&1; true");
    assert.doesNotMatch(other, /ghs_contract/);
    // What `gh auth setup-git` writes into the agent's home drops every helper before it; the
    // platform's still answers.
    const overridden = await sh(
      "git config --global credential.https://github.com.helper '' && " +
        "git config --global --add credential.https://github.com.helper '!gh auth git-credential' && " +
        "printf 'protocol=https\\nhost=github.com\\npath=acme/shop.git\\n\\n' | env -u GH_TOKEN git credential fill 2>&1; true",
    );
    assert.match(overridden, /username=x-access-token\npassword=ghs_contract/);
  } finally {
    await sandboxes.destroy(MACHINE.id).catch(() => undefined);
    await sandboxes.close();
    await server.stop();
  }
});
