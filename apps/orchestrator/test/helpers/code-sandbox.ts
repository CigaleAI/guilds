import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "../../src/lib/paths.js";
import { CODE_HELPER, HARNESS_HELPER } from "../../src/toolbox/code.js";
import { tempDir } from "./env.js";

export const CODE_HELPER_PATH = path.join(repoRoot(import.meta.url), "runtime/guilds-code");
export const HARNESS_HELPER_PATH = path.join(repoRoot(import.meta.url), "runtime/guilds-harness");

type Execution = {
  exit_code: number | null;
  logs: { stdout: Array<{ text: string }>; stderr: Array<{ text: string }> };
};

/**
 * A sandbox whose commands run on this machine: `guilds-code` and `guilds-harness` from
 * `runtime/`, a temporary folder named after the agent as its home, another as
 * `/run/guilds`, and `env` plus each command's own `envs` in the environment. Commands that
 * name neither helper are recorded and answered with empty output.
 */
export class HostCodeSandbox {
  id = "sbx_host";
  home: string;
  runDir = tempDir("guilds-code-run-");
  commandsRun: string[] = [];
  written: string[] = [];
  env: Record<string, string>;

  constructor(agentId = "a_1", env: Record<string, string> = {}) {
    this.home = path.join(tempDir("guilds-code-home-"), agentId);
    mkdirSync(this.home, { recursive: true });
    this.env = env;
  }

  commands = {
    run: (command: string, opts?: Record<string, unknown>) => this.run(command, opts),
  };

  files = {
    writeFiles: async (entries: Array<{ path: string; data: string }>) => {
      for (const entry of entries) {
        const local = this.local(entry.path);
        mkdirSync(path.dirname(local), { recursive: true });
        writeFileSync(local, entry.data);
        this.written.push(entry.path);
      }
    },
    moveFiles: async () => undefined,
    deleteFiles: async () => undefined,
  };

  local(sandboxPath: string): string {
    return sandboxPath.startsWith("/run/guilds")
      ? path.join(this.runDir, sandboxPath.slice("/run/guilds".length))
      : sandboxPath;
  }

  private async run(command: string, opts?: Record<string, unknown>): Promise<Execution> {
    this.commandsRun.push(command);
    if (!command.includes(CODE_HELPER) && !command.includes(HARNESS_HELPER)) {
      return { exit_code: 0, logs: { stdout: [], stderr: [] } };
    }
    const local = command
      .replaceAll(CODE_HELPER, CODE_HELPER_PATH)
      .replaceAll(HARNESS_HELPER, HARNESS_HELPER_PATH)
      .replaceAll("/run/guilds", this.runDir);
    const envs = (opts?.envs ?? {}) as Record<string, string>;
    const timeout = Number(opts?.timeoutSeconds ?? opts?.timeout ?? 120) * 1000;
    return new Promise((resolve, reject) => {
      const child = spawn("bash", ["-c", local], {
        // HOME is the agent's home, as on its machine: git's global config lands there. The host's
        // XDG directories are dropped so every per-user path resolves under that home too.
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("XDG_"))),
          ...this.env,
          ...envs,
          HOME: this.home,
          GIT_CONFIG_NOSYSTEM: "1",
          GUILDS_AGENT_HOME: this.home,
          GUILDS_RUN_DIR: this.runDir,
        },
        timeout,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({
          exit_code: code,
          logs: { stdout: stdout ? [{ text: stdout }] : [], stderr: stderr ? [{ text: stderr }] : [] },
        });
      });
    });
  }
}

/** The request a helper command carries inline, or null for one sent through a file or no helper at all. */
export function helperRequest(command: string): Record<string, unknown> | null {
  const match = /guilds-(?:code|harness) ([A-Za-z0-9+/=]+)$/.exec(command.trim());
  return match ? (JSON.parse(Buffer.from(match[1]!, "base64").toString("utf8")) as Record<string, unknown>) : null;
}

/** A helper's answer, as the sandbox returns it: an `ok` envelope holding `meta`. */
export function helperAnswer(meta: Record<string, unknown>, text = "") {
  const envelope = Buffer.from(JSON.stringify({ ok: true, text, meta }), "utf8").toString("base64");
  return { exit_code: 0, logs: { stdout: [{ text: envelope }], stderr: [] } };
}

/**
 * Answers the ops `answers` names with its envelope, and runs every other command on `sandbox`;
 * returns the requests answered, in order.
 */
export function answerOps(
  sandbox: HostCodeSandbox,
  answers: Record<string, Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const answered: Array<Record<string, unknown>> = [];
  const run = sandbox.commands.run;
  sandbox.commands.run = async (command, opts) => {
    const request = helperRequest(command);
    const meta = request ? answers[String(request.op)] : undefined;
    if (request === null || meta === undefined) {
      return run(command, opts);
    }
    answered.push(request);
    return helperAnswer(meta);
  };
  return answered;
}
