import assert from "node:assert/strict";
import { test } from "node:test";
import { streamCompletion } from "../../src/llm/index.js";

const gated =
  process.env.RUN_MODEL_CONTRACT !== "1" || !process.env.OPENROUTER_API_KEY
    ? "set RUN_MODEL_CONTRACT=1 and OPENROUTER_API_KEY to run the live model contract"
    : false;

function contractModel(): string {
  const model = process.env.MODEL_CONTRACT_MODEL ?? "openrouter/openai/gpt-4o-mini";
  if (!model.startsWith("openrouter/") && !model.startsWith("deepinfra/")) {
    throw new Error("MODEL_CONTRACT_MODEL must start with openrouter/ or deepinfra/");
  }
  return model;
}

async function stream(messages: Array<Record<string, unknown>>, extra: {
  tools?: unknown[];
  tool_choice?: unknown;
  max_tokens: number;
}): Promise<{ payload: Record<string, unknown>; metadata: Record<string, unknown> }> {
  const model = contractModel();
  const apiKey = model.startsWith("deepinfra/")
    ? process.env.DEEPINFRA_API_KEY ?? process.env.OPENROUTER_API_KEY
    : process.env.OPENROUTER_API_KEY;
  const request: {
    model: string;
    messages: Array<Record<string, unknown>>;
    temperature: number;
    max_tokens: number;
    tools?: unknown[] | null;
    tool_choice?: unknown;
    apiKey?: string;
  } = {
    model,
    messages,
    temperature: 0,
    max_tokens: extra.max_tokens,
  };
  if (extra.tools) {
    request.tools = extra.tools;
  }
  if (extra.tool_choice !== undefined) {
    request.tool_choice = extra.tool_choice;
  }
  if (apiKey) {
    request.apiKey = apiKey;
  }
  let done: { payload: Record<string, unknown>; metadata: Record<string, unknown> } | undefined;
  for await (const event of streamCompletion(request)) {
    if (event[0] === "done") {
      done = event[1];
    }
  }
  assert.ok(done, "provider returned no completion");
  return done;
}

test("openrouter streaming contract", { skip: gated }, async () => {
  const text = await stream(
    [{ role: "user", content: "Reply with exactly COMPAT_OK." }],
    { max_tokens: 32 },
  );
  assert.equal(text.payload.role, "assistant");
  assert.equal(String(text.payload.content ?? "").trim().replace(/\.+$/, ""), "COMPAT_OK");
  assert.equal(text.metadata.finish_reason, "stop");

  const tool = await stream(
    [{ role: "user", content: "Call record_contract once with value set to COMPAT_OK." }],
    {
      max_tokens: 128,
      tools: [
        {
          type: "function",
          function: {
            name: "record_contract",
            description: "Record the compatibility result.",
            parameters: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "record_contract" } },
    },
  );
  assert.equal(tool.payload.role, "assistant");
  const toolCalls = tool.payload.tool_calls as Array<{
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
  assert.equal(toolCalls.length, 1);
  assert.ok(toolCalls[0]?.id);
  assert.equal(toolCalls[0]?.function?.name, "record_contract");
  assert.deepEqual(JSON.parse(toolCalls[0]?.function?.arguments ?? "{}"), { value: "COMPAT_OK" });
  assert.equal(tool.metadata.finish_reason, "tool_calls");

  for (const response of [text, tool]) {
    const metadata = response.metadata;
    const usage = metadata.usage as {
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
    };
    assert.ok(metadata.response_id);
    assert.ok(metadata.served_model ?? metadata.model);
    assert.ok(usage.input_tokens > 0);
    assert.ok(usage.output_tokens > 0);
    assert.ok(usage.cache_read_tokens >= 0);
    assert.ok(Number.isFinite(Number(metadata.cost_usd)));
    assert.ok(Number(metadata.cost_usd) >= 0);
    assert.ok(metadata.provider_request_id === null || typeof metadata.provider_request_id === "string");
  }
});
