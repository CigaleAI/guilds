import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { messagesFromHistory, messagesRequestBody } from "../../src/llm/anthropic.js";
import { listProviderModels, streamCompletion } from "../../src/llm/client.js";
import { LLMError, MODEL_USER_AGENT, type ModelEvent } from "../../src/llm/completion.js";
import { providerById } from "../../src/llm/providers.js";

function anthropic() {
  const definition = providerById("anthropic");
  assert.ok(definition, "anthropic is a provider");
  return definition;
}

async function withServer(
  handler: (request: http.IncomingMessage, body: string, response: http.ServerResponse) => void,
  run: (baseURL: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => handler(request, raw, response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function sse(response: http.ServerResponse, events: Array<Record<string, unknown>>): void {
  response.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_1" });
  for (const event of events) {
    response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

test("messagesFromHistory lifts the system prompt, pairs tool calls with their results, and merges turns", () => {
  const { system, messages } = messagesFromHistory([
    { role: "system", content: "rules" },
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        { type: "image_url", image_url: { url: "https://blobs.example/a.png" } },
      ],
    },
    {
      role: "assistant",
      content: "checking",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "read", arguments: "{\"path\":\"a\"}" } },
        { id: "call_2", type: "function", function: { name: "list", arguments: "not json" } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "contents" },
    { role: "tool", tool_call_id: "call_2", content: "" },
    { role: "user", content: "and then?" },
    { role: "assistant", content: "" },
    { role: "system", content: "late note" },
  ]);
  assert.deepEqual(system, [{ type: "text", text: "rules" }]);
  assert.deepEqual(messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        { type: "image", source: { type: "url", url: "https://blobs.example/a.png" } },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "checking" },
        { type: "tool_use", id: "call_1", name: "read", input: { path: "a" } },
        { type: "tool_use", id: "call_2", name: "list", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "contents" }] },
        { type: "tool_result", tool_use_id: "call_2" },
        { type: "text", text: "and then?" },
        { type: "text", text: "late note" },
      ],
    },
  ]);
});

test("messagesFromHistory skips parts and tool calls that are not objects of the OpenAI shape", () => {
  const { messages } = messagesFromHistory([
    { role: "user", content: [null, "text", { type: "text", text: 5 }, { type: "image_url", image_url: "x" }, { type: "text", text: "kept" }] },
    {
      role: "assistant",
      content: "",
      tool_calls: [null, { id: 1, function: { name: "read" } }, { id: "call_1", function: "read" }, { id: "call_2", function: { name: "read", arguments: "[1]" } }],
    },
  ]);
  assert.deepEqual(messages, [
    { role: "user", content: [{ type: "text", text: "kept" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "call_2", name: "read", input: {} }] },
  ]);
});

test("messagesFromHistory fails on an inline image of a media type the Messages API does not take", () => {
  assert.throws(
    () =>
      messagesFromHistory([
        { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/svg+xml;base64,AAAA" } }] },
      ]),
    (error: unknown) => error instanceof LLMError && /does not take image\/svg\+xml images/.test(error.message),
  );
});

test("messagesRequestBody fails on a tool whose parameters are not an object schema, and on an effort the API does not take", () => {
  const base = { model: "anthropic/claude-opus-5-5", messages: [{ role: "user", content: "hi" }], temperature: 0, max_tokens: 64 };
  const tool = (parameters: unknown) => [{ type: "function", function: { name: "read", parameters } }];
  assert.deepEqual(messagesRequestBody({ ...base, tools: tool("none") }).tools, [
    { name: "read", input_schema: { type: "object", properties: {} } },
  ]);
  assert.deepEqual(messagesRequestBody({ ...base, tools: [null, { function: { name: 5 } }] }).tools, undefined);
  for (const parameters of [{ type: "string" }, { type: "object", required: ["path", 1] }]) {
    assert.throws(
      () => messagesRequestBody({ ...base, tools: tool(parameters) }),
      (error: unknown) => error instanceof LLMError && /tool read has parameters that are not an object schema/.test(error.message),
    );
  }
  assert.deepEqual(messagesRequestBody({ ...base, tools: tool({ type: "object", required: null }) }).tools, [
    { name: "read", input_schema: { type: "object", required: null } },
  ]);
  assert.throws(
    () => messagesRequestBody({ ...base, thinking_level: "minimal" }),
    (error: unknown) => error instanceof LLMError && /does not take the minimal effort/.test(error.message),
  );
  assert.equal(messagesRequestBody({ ...base, tool_choice: { function: "read" } }).tool_choice, undefined);
});

test("messagesRequestBody asks for adaptive thinking at the level's effort, and a temperature only without it", () => {
  const base = {
    messages: [{ role: "system", content: "rules" }, { role: "user", content: "hi" }],
    temperature: 0.4,
    max_tokens: 64,
    tools: [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
  };
  const thinking = messagesRequestBody({ ...base, model: "anthropic/claude-opus-5-5", thinking_level: "high" });
  assert.equal(thinking.model, "claude-opus-5-5");
  assert.equal(thinking.max_tokens, 64);
  assert.deepEqual(thinking.system, [{ type: "text", text: "rules" }]);
  assert.deepEqual(thinking.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(thinking.output_config, { effort: "high" });
  assert.equal("temperature" in thinking, false);
  assert.deepEqual(thinking.cache_control, { type: "ephemeral" });
  assert.deepEqual(thinking.tools, [
    { name: "read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
  ]);

  const plain = messagesRequestBody({ ...base, model: "anthropic/claude-sonnet-4-6", thinking_level: "none" });
  assert.equal("thinking" in plain, false);
  assert.equal("output_config" in plain, false);
  assert.equal(plain.temperature, 0.4);

  const fixed = messagesRequestBody({ ...base, model: "anthropic/claude-opus-5-5" });
  assert.equal("temperature" in fixed, false, "the catalog says this model sets its own temperature");

  assert.deepEqual(messagesRequestBody({ ...base, model: "anthropic/claude-opus-5-5", tool_choice: "required" }).tool_choice, { type: "any" });
  assert.deepEqual(
    messagesRequestBody({ ...base, model: "anthropic/claude-opus-5-5", tool_choice: { type: "function", function: { name: "read" } } }).tool_choice,
    { type: "tool", name: "read" },
  );
});

test("listProviderModels lists an Anthropic key's models with its key header", async () => {
  await withServer(
    (request, _body, response) => {
      assert.equal(request.url?.startsWith("/v1/models"), true);
      assert.equal(request.headers["x-api-key"], "sk-ant-test");
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers["user-agent"], MODEL_USER_AGENT);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        data: [{ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-01-01T00:00:00Z" }],
        has_more: false,
        first_id: "claude-opus-5-5",
        last_id: "claude-opus-5-5",
      }));
    },
    async (baseURL) => {
      assert.deepEqual(await listProviderModels(anthropic(), { apiKey: " sk-ant-test ", baseURL }), ["claude-opus-5-5"]);
    },
  );
  await withServer(
    (_request, _body, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
    },
    async (baseURL) => {
      await assert.rejects(() => listProviderModels(anthropic(), { apiKey: "bad", baseURL }), /Anthropic rejected the key/);
    },
  );
});

test("streamCompletion speaks the Messages API to Anthropic and assembles an OpenAI-style payload", async () => {
  let sent: Record<string, unknown> = {};
  await withServer(
    (request, body, response) => {
      assert.equal(request.url, "/v1/messages");
      assert.equal(request.headers["x-api-key"], "sk-ant-test");
      sent = JSON.parse(body) as Record<string, unknown>;
      sse(response, [
        {
          type: "message_start",
          message: {
            id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [],
            stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 90, cache_creation_input_tokens: 5 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "reading" } },
        { type: "content_block_stop", index: 1 },
        { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} } },
        { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"path\":" } },
        { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "\"a\"}" } },
        { type: "content_block_stop", index: 2 },
        { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } },
        { type: "message_stop" },
      ]);
    },
    async (baseURL) => {
      const events: ModelEvent[] = [];
      for await (const event of streamCompletion(
        {
          model: "anthropic/claude-opus-5-5",
          messages: [{ role: "user", content: "hi" }],
          temperature: 0,
          max_tokens: 64,
          tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
          thinking_level: "medium",
        },
        { apiKey: "sk-ant-test", baseURL },
      )) {
        events.push(event);
      }
      assert.deepEqual(events.slice(0, 2), [["reasoning", "plan"], ["delta", "reading"]]);
      const done = events.at(-1);
      assert.equal(done?.[0], "done");
      const { payload, metadata } = done[1] as { payload: Record<string, unknown>; metadata: Record<string, unknown> };
      assert.deepEqual(payload, {
        role: "assistant",
        content: "reading",
        tool_calls: [{ id: "toolu_1", type: "function", function: { name: "read", arguments: "{\"path\":\"a\"}" } }],
      });
      assert.deepEqual(metadata.usage, { input_tokens: 105, output_tokens: 20, cache_read_tokens: 90 });
      assert.equal(metadata.finish_reason, "tool_calls");
      assert.equal(metadata.model, "claude-opus-5-5");
      assert.equal(metadata.response_id, "msg_1");
      assert.equal(metadata.provider_request_id, "req_1");
      assert.equal(metadata.reasoning, "plan");
      assert.equal(metadata.cost_source, "catalog");
    },
  );
  assert.equal(sent.model, "claude-opus-5-5");
  assert.equal(sent.stream, true);
  assert.deepEqual(sent.output_config, { effort: "medium" });
  assert.deepEqual(sent.messages, [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
});

test("streamCompletion redacts the Anthropic key from a provider error", async () => {
  await withServer(
    (_request, _body, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad key sk-ant-secret" } }));
    },
    async (baseURL) => {
      await assert.rejects(
        async () => {
          for await (const _event of streamCompletion(
            {
              model: "anthropic/claude-opus-5-5",
              messages: [{ role: "user", content: "hi" }],
              temperature: 0,
              max_tokens: 8,
            },
            { apiKey: "sk-ant-secret", baseURL },
          )) {
            // drained
          }
        },
        (error: unknown) => error instanceof Error && error.name === "LLMError" && !error.message.includes("sk-ant-secret"),
      );
    },
  );
});
