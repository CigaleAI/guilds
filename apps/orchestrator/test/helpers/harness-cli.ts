import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildHarnessMcpApp } from "../../src/app.js";
import type { GenerationLoop } from "../../src/generation/index.js";
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

/** A stand-in line that makes the CLI run `argv` in its working directory and print its exit code and output. */
export function runLine(...argv: string[]): string {
  return JSON.stringify({ stub: "run", argv });
}

/** A stand-in line that makes the CLI send the JSON-RPC request `method` to the orchestrator's MCP server, numbered `id`. */
export function mcpLine(method: string, params: Record<string, unknown> = {}, id = 1): string {
  return JSON.stringify({ stub: "mcp", method, params, id });
}

/** What the stand-in CLI's request of the orchestrator's MCP server got: the method, the HTTP status, and the JSON-RPC answer. */
export type StubMcpAnswer = { method: string; status: number; answer: { result?: Record<string, unknown>; error?: { code: number; message: string } } | null };

/**
 * A sandbox on this machine of agent `agentId`, with the stand-in CLI on PATH as `binary`,
 * replaying `lines`; each start of it is returned by `calls`, and `replay` gives the next start
 * other lines.
 */
export function stubCliSandbox(binary: string, lines: string[], env: Record<string, string> = {}, agentId = "a_1") {
  const bin = tempDir("harness-bin-");
  copyFileSync(STUB, path.join(bin, binary));
  chmodSync(path.join(bin, binary), 0o755);
  const scratch = tempDir("harness-stub-");
  const record = path.join(scratch, "record.jsonl");
  const mcpRecord = path.join(scratch, "mcp.jsonl");
  const eventsFile = path.join(scratch, "events.jsonl");
  const replay = (next: string[]) => writeFileSync(eventsFile, next.join("\n") + "\n");
  replay(lines);
  const sandbox = new HostCodeSandbox(agentId, {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HARNESS_STUB_EVENTS: eventsFile,
    HARNESS_STUB_RECORD: record,
    HARNESS_STUB_MCP_RECORD: mcpRecord,
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
  const mcpAnswers = (): StubMcpAnswer[] =>
    existsSync(mcpRecord)
      ? readFileSync(mcpRecord, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as StubMcpAnswer)
      : [];
  return { sandbox, calls, replay, bin, mcpAnswers };
}

/** Whether a process of the stand-in CLI in `bin` still runs. */
export function stubsRunning(bin: string): boolean {
  const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return out.split("\n").some((line) => line.includes(`${bin}/`));
}

/** A port of this host nothing listens on now. */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return typeof address === "object" && address !== null ? address.port : 0;
}

/**
 * The orchestrator's MCP server of `loop`, built with `http://127.0.0.1:<port>` as its URL,
 * listening there, where the stand-in CLI connects at its start; the caller closes it.
 */
export async function serveHarnessMcp(loop: GenerationLoop, port: number): Promise<FastifyInstance> {
  const listener = await buildHarnessMcpApp(loop.harnessMcp);
  await listener.listen({ host: "127.0.0.1", port });
  return listener;
}
