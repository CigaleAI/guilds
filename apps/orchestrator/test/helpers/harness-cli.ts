import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HostCodeSandbox } from "./code-sandbox.js";
import { tempDir } from "./env.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(HERE, "harness/stub-cli");

/** The session id of the recorded Claude Code turn, `harness/claude-code.jsonl`. */
export const RECORDED_SESSION = "0f9c2a64-5b1e-4c3d-9a8e-2f1d7c6b5a40";

/**
 * One start of the stand-in CLI: its command line, working directory, stdin, system prompt file,
 * MCP configuration file and its mode, the variables it shows, and the variables whose value
 * holds `HARNESS_STUB_SEEK`.
 */
export type StubCall = {
  argv: string[];
  cwd: string;
  stdin: string;
  system_prompt: string | null;
  mcp_config: { mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }> } | null;
  mcp_config_mode: number | null;
  env: Record<string, string | null>;
  env_holding_seek: string[];
};

/** The recorded event stream of a harness under `harness/`, one event per line. */
export function recordedEvents(name: string): string[] {
  return readFileSync(path.join(HERE, "harness", `${name}.jsonl`), "utf8").split("\n").filter(Boolean);
}

/** A stand-in line that makes the CLI sleep until it is stopped. */
export const HANG = JSON.stringify({ stub: "hang" });

/**
 * A sandbox on this machine with the stand-in CLI on PATH as `binary`, replaying `lines`; each
 * start of it is returned by `calls`, and `replay` gives the next start other lines.
 */
export function stubCliSandbox(binary: string, lines: string[], env: Record<string, string> = {}) {
  const bin = tempDir("harness-bin-");
  copyFileSync(STUB, path.join(bin, binary));
  chmodSync(path.join(bin, binary), 0o755);
  const scratch = tempDir("harness-stub-");
  const record = path.join(scratch, "record.jsonl");
  const eventsFile = path.join(scratch, "events.jsonl");
  const replay = (next: string[]) => writeFileSync(eventsFile, next.join("\n") + "\n");
  replay(lines);
  const sandbox = new HostCodeSandbox("a_1", {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HARNESS_STUB_EVENTS: eventsFile,
    HARNESS_STUB_RECORD: record,
    HARNESS_STUB_DELAY: "0.02",
    ...env,
  });
  const calls = (): StubCall[] =>
    existsSync(record)
      ? readFileSync(record, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as StubCall)
      : [];
  return { sandbox, calls, replay, bin };
}

/** Whether a process of the stand-in CLI in `bin` still runs. */
export function stubsRunning(bin: string): boolean {
  const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return out.split("\n").some((line) => line.includes(`${bin}/`));
}
