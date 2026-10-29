import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { AsyncEvent } from "../../src/lib/event.js";
import type { Completion, ModelEvent } from "../../src/llm/index.js";
import type { AgentSeat, MachineSpec } from "../../src/sandbox/index.js";

/** A sandbox provider for HTTP tests: machines that run, agents' browsers and terminals, nothing real. */
export class ExportSandboxes {
  novncBase = "http://127.0.0.1:9";
  novncHeaders: Record<string, string> = { "OPEN-SANDBOX-API-KEY": "compat-test" };
  cliBase = "http://127.0.0.1:9";
  cliHeaders: Record<string, string> = { "OPEN-SANDBOX-API-KEY": "compat-test" };
  cliToken = "f".repeat(48);
  cliStarts = 0;
  /** Running machines, by id, with the size each was ensured with. */
  running = new Map<string, MachineSpec>();
  /** Agents whose Chrome started, in order. */
  browserStarts: string[] = [];
  /** Agents whose processes stopped, with what stopped. */
  stopped: Array<{ agentId: string; what: "browser" | "purge" }> = [];
  /** Machines whose containers went. */
  destroyed: string[] = [];
  workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  private sandbox(machineId: string) {
    return {
      id: `sbx_${machineId}`,
      commands: {
        async run(command: string) {
          return {
            exit_code: 0,
            logs: { stdout: [{ text: `ok:${command}` }], stderr: [] },
          };
        },
        async interrupt(_executionId: string) {
          return undefined;
        },
      },
    };
  }

  async ensure(machine: MachineSpec) {
    this.running.set(machine.id, machine);
    mkdirSync(path.join(this.workspaceRoot, machine.id), { recursive: true });
    return this.sandbox(machine.id);
  }

  async connectRunning(machineId: string) {
    return this.running.has(machineId) ? this.sandbox(machineId) : null;
  }

  async startBrowser(_sandbox: unknown, seat: AgentSeat): Promise<void> {
    this.browserStarts.push(seat.agentId);
  }

  async stopBrowser(_sandbox: unknown, seat: AgentSeat): Promise<void> {
    this.stopped.push({ agentId: seat.agentId, what: "browser" });
  }

  async purgeAgent(_sandbox: unknown, seat: AgentSeat): Promise<void> {
    this.stopped.push({ agentId: seat.agentId, what: "purge" });
  }

  async novncTarget(_sandbox: unknown, _seat: AgentSeat): Promise<[string, Record<string, string>]> {
    return [this.novncBase, { ...this.novncHeaders }];
  }

  async startCli(_sandbox: unknown, _seat: AgentSeat): Promise<string> {
    this.cliStarts += 1;
    return this.cliToken;
  }

  async cliTarget(_sandbox: unknown, _seat: AgentSeat, token: string): Promise<[string, Record<string, string>]> {
    return [`${this.cliBase}/t/${token}`, { ...this.cliHeaders }];
  }

  async destroy(machineId: string): Promise<void> {
    this.destroyed.push(machineId);
    this.running.delete(machineId);
  }

  async listRunningMachineIds(): Promise<Set<string>> {
    return new Set(this.running.keys());
  }
}

export class StreamScript {
  mode: "hello" | "hold" | "tools" = "hello";
  hold = new AsyncEvent();

  resetHold(): void {
    this.hold = new AsyncEvent();
  }

  async *run(options: { model?: string; signal?: AbortSignal }): AsyncGenerator<ModelEvent> {
    const usage = {
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
      },
      cost_usd: 0.0,
      cost_source: "catalog" as const,
      finish_reason: "stop",
      model: options.model || "openrouter/openai/gpt-5.6-luna",
      response_id: "compat-response",
      provider_request_id: "compat-provider",
      latency_ms: 1,
    };
    if (this.mode === "hold") {
      yield ["delta", "partial-"];
      await this.hold.wait(options.signal);
      return;
    }
    yield ["delta", "Hello"];
    yield [
      "done",
      {
        payload: { role: "assistant", content: "Hello" },
        metadata: usage,
      } satisfies Completion,
    ];
  }
}

export type UpstreamHandle = {
  base: string;
  close(): Promise<void>;
};

export type UpstreamOptions = {
  /** The WebSocket subprotocol the daemon accepts. */
  subprotocol?: string;
};

/** A stand-in for a sandbox daemon: echoes HTTP and WebSocket traffic back with what it saw. */
export function startSandboxUpstream(options: UpstreamOptions = {}): Promise<UpstreamHandle> {
  const subprotocol = options.subprotocol ?? "binary";
  return new Promise((resolve, reject) => {
    const handle = (request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      request.on("end", () => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const pathname = url.pathname.replace(/\/$/, "") || "/";
        if (pathname.endsWith("gzip")) {
          const compressed = gzipSync(Buffer.from("hello-novnc"));
          response.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Encoding": "gzip",
            Connection: "keep-alive",
            "Keep-Alive": "timeout=5",
            "x-upstream": "1",
          });
          if (request.method === "HEAD") {
            response.end();
            return;
          }
          response.end(compressed);
          return;
        }
        const body = Buffer.concat(chunks);
        const payload = body.length ? body : Buffer.from(`${request.method} ${pathname === "/" ? "/" : pathname}`);
        response.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "x-upstream": "1",
          Connection: "close",
        });
        if (request.method === "HEAD") {
          response.end();
          return;
        }
        response.end(payload);
      });
    };
    const server: Server = createServer(handle);
    const wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols: Set<string> | Iterable<string>) => {
        const requested = protocols instanceof Set ? protocols : new Set(protocols);
        return requested.has(subprotocol) ? subprotocol : false;
      },
    });
    wss.on("connection", (socket) => {
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          const raw = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          socket.send(Buffer.concat([Buffer.from("echo-bin:"), raw]), { binary: true });
          return;
        }
        socket.send(`echo-text:${data.toString()}`);
      });
    });
    server.on("upgrade", (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("upstream bind failed"));
        return;
      }
      resolve({
        base: `http://127.0.0.1:${address.port}`,
        async close() {
          wss.close();
          await new Promise<void>((done, fail) => {
            server.close((error) => {
              if (error) {
                fail(error);
                return;
              }
              done();
            });
          });
        },
      });
    });
  });
}

export async function readSse(
  url: string,
  headers: Record<string, string>,
  predicate: (text: string) => boolean,
  timeoutMs: number,
  connected?: { set(): void },
): Promise<{ status: number; headers: Headers; text: string }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const response = await fetch(url, { headers, signal: abort.signal, redirect: "manual" });
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    if (!reader) {
      return { status: response.status, headers: response.headers, text };
    }
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      text += decoder.decode(next.value, { stream: true });
      if (connected && text.includes(": connected")) {
        connected.set();
      }
      if (predicate(text)) {
        break;
      }
    }
  } catch (error) {
    if (!abort.signal.aborted) {
      throw error;
    }
  } finally {
    clearTimeout(timer);
    abort.abort();
    try {
      await reader?.cancel();
    } catch {
      /* already closed */
    }
  }
  return { status: response.status, headers: response.headers, text };
}

export function openWs(
  url: string,
  headers: Record<string, string>,
  subprotocol = "binary",
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, [subprotocol], { headers });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

export function wsRecv(socket: WebSocket, timeoutMs = 5000): Promise<{ text?: string; binary?: Buffer }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws recv timeout")), timeoutMs);
    socket.once("message", (data, isBinary) => {
      clearTimeout(timer);
      if (isBinary) {
        const raw = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        resolve({ binary: raw });
        return;
      }
      resolve({ text: data.toString() });
    });
  });
}
