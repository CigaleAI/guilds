import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "../../src/lib/paths.js";
import { CODE_HELPER } from "../../src/toolbox/code.js";
import { tempDir } from "./env.js";

export const CODE_HELPER_PATH = path.join(repoRoot(import.meta.url), "runtime/guilds-code");

type Execution = {
  exit_code: number | null;
  logs: { stdout: Array<{ text: string }>; stderr: Array<{ text: string }> };
};

/**
 * A sandbox whose commands run on this machine: `guilds-code` from `runtime/`, a
 * temporary folder as `/home/agent`, another as `/run/guilds`. Commands that do not
 * name the helper are recorded and answered with empty output.
 */
export class HostCodeSandbox {
  id = "sbx_host";
  home = tempDir("guilds-code-home-");
  runDir = tempDir("guilds-code-run-");
  commandsRun: string[] = [];
  written: string[] = [];

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
    if (!command.includes(CODE_HELPER)) {
      return { exit_code: 0, logs: { stdout: [], stderr: [] } };
    }
    const local = command.replaceAll(CODE_HELPER, CODE_HELPER_PATH).replaceAll("/run/guilds", this.runDir);
    const timeout = Number(opts?.timeoutSeconds ?? opts?.timeout ?? 120) * 1000;
    return new Promise((resolve, reject) => {
      const child = spawn("bash", ["-c", local], {
        // HOME is the workspace, as in a coding sandbox: git's global config lands there.
        env: {
          ...process.env,
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
