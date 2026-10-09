import { createServer, type IncomingMessage, type Server } from "node:http";

export type McpPingFixture = {
  url: string;
  listed: number;
  called: number;
  close(): Promise<void>;
};

export async function startMcpPingFixture(): Promise<McpPingFixture> {
  const state: McpPingFixture = {
    url: "",
    listed: 0,
    called: 0,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
  let sessionId: string | null = null;
  const server: Server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      let body: { id?: unknown; method?: string } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as typeof body;
      } catch {
        response.statusCode = 400;
        response.end("not json");
        return;
      }
      const sid = String(request.headers["mcp-session-id"] ?? "");
      response.setHeader("content-type", "application/json");
      if (body.method === "initialize") {
        sessionId = "sess_fixture";
        response.setHeader("mcp-session-id", sessionId);
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              serverInfo: { name: "fixture", version: "1" },
            },
          }),
        );
        return;
      }
      if (body.method === "notifications/initialized") {
        response.end("{}");
        return;
      }
      if (!sessionId || sid !== sessionId) {
        response.statusCode = 400;
        response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { message: "missing session" } }));
        return;
      }
      if (body.method === "tools/list") {
        state.listed += 1;
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }] },
          }),
        );
        return;
      }
      if (body.method === "tools/call") {
        state.called += 1;
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: "pong" }] },
          }),
        );
        return;
      }
      response.statusCode = 400;
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  state.url = `http://127.0.0.1:${port}/mcp`;
  return state;
}
