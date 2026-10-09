import assert from "node:assert/strict";
import { test } from "node:test";
import { parseToolArgs, projectConversationHistory, recoverPartialToolArgs } from "../../src/conversation/runner.js";

function row(
  seq: number,
  generation: number,
  payload: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): Record<string, unknown> {
  return { seq, generation, payload, metadata };
}

test("projection keeps current-generation tool results including standing tasks", () => {
  const stubbed: number[] = [];
  const messages = projectConversationHistory({
    history: [
      row(0, 0, { role: "system", content: "studio" }),
      row(1, 1, { role: "user", content: "Review this guild" }),
      row(2, 1, { role: "assistant", content: "", tool_calls: [{ id: "c1" }] }),
      row(3, 1, { role: "tool", tool_call_id: "c1", content: '{"task":{"content":"Write the digest."}}' }, { tool_name: "studio_get_agent_context" }),
      row(4, 1, { role: "assistant", content: "", tool_calls: [{ id: "c2" }] }),
      row(5, 1, { role: "tool", tool_call_id: "c2", content: '{"task":{"content":"Scout listings."}}' }, { tool_name: "studio_get_agent_context" }),
      row(6, 1, { role: "assistant", content: "", tool_calls: [{ id: "c3" }] }),
      row(7, 1, { role: "tool", tool_call_id: "c3", content: '{"task":{"content":"Post the brief."}}' }, { tool_name: "studio_get_agent_context" }),
      row(8, 1, { role: "assistant", content: "", tool_calls: [{ id: "c4" }] }),
      row(9, 1, { role: "tool", tool_call_id: "c4", content: '{"task":{"content":"Manage the wallet."}}' }, { tool_name: "studio_get_agent_context" }),
      row(10, 1, { role: "assistant", content: "", tool_calls: [{ id: "c5" }] }),
      row(11, 1, { role: "tool", tool_call_id: "c5", content: '{"task":{"content":"Track the fund."}}' }, { tool_name: "studio_get_agent_context" }),
    ],
    generationContext: "roster",
    currentGeneration: 1,
    stubbed,
  });
  const tools = messages.filter((item) => item.role === "tool");
  assert.equal(tools.length, 5);
  assert.ok(tools.every((item) => !String(item.content).includes('"stub":true')));
  assert.ok(tools.some((item) => String(item.content).includes("Write the digest.")));
  assert.ok(tools.some((item) => String(item.content).includes("Track the fund.")));
  assert.deepEqual(stubbed, []);
});

test("projection stubs older generations and tells the coach to refetch the task", () => {
  const stubbed: number[] = [];
  const messages = projectConversationHistory({
    history: [
      row(0, 0, { role: "system", content: "studio" }),
      row(1, 1, { role: "tool", tool_call_id: "old", content: '{"task":{"content":"Write the digest."}}' }, { tool_name: "studio_get_agent_context" }),
      row(2, 2, { role: "user", content: "Look again" }),
      row(3, 2, { role: "tool", tool_call_id: "new", content: '{"task":{"content":"Scout listings."}}' }, { tool_name: "studio_get_agent_context" }),
    ],
    generationContext: "roster",
    currentGeneration: 2,
    stubbed,
  });
  const tools = messages.filter((item) => item.role === "tool");
  assert.equal(tools.length, 2);
  assert.match(String(tools[0]?.content), /"stub":true/);
  assert.match(String(tools[0]?.content), /studio_get_agent_context/);
  assert.match(String(tools[0]?.content), /sections=\['task'\]/);
  assert.doesNotMatch(String(tools[0]?.content), /narrower range/);
  assert.match(String(tools[1]?.content), /Scout listings/);
  assert.deepEqual(stubbed, [1]);
});

test("projection stubs oldest current-generation tools only after the token budget is exceeded", () => {
  const stubbed: number[] = [];
  const messages = projectConversationHistory({
    history: [
      row(0, 0, { role: "system", content: "studio" }),
      row(1, 1, { role: "tool", tool_call_id: "a", content: "one" }),
      row(2, 1, { role: "tool", tool_call_id: "b", content: "two" }),
      row(3, 1, { role: "tool", tool_call_id: "c", content: "three" }),
    ],
    generationContext: "roster",
    currentGeneration: 1,
    stubbed,
    minUnstubbed: 2,
    budget: {
      model: "test",
      schemas: [],
      maxInput: 1,
      countInputTokens(_model, next) {
        const tools = (next as Array<Record<string, unknown>>).filter((item) => item.role === "tool");
        const live = tools.filter((item) => !String(item.content).includes('"stub":true'));
        return live.length > 2 ? 9 : 1;
      },
    },
  });
  const tools = messages.filter((item) => item.role === "tool");
  assert.match(String(tools[0]?.content), /"stub":true/);
  assert.equal(String(tools[1]?.content), "two");
  assert.equal(String(tools[2]?.content), "three");
  assert.deepEqual(stubbed, [1]);
});

test("projection replaces a stale stored system prompt with the live system content", () => {
  const stubbed: number[] = [];
  const messages = projectConversationHistory({
    history: [row(0, 0, { role: "system", content: "studio_create_task_draft requires an active target" })],
    generationContext: "roster",
    currentGeneration: 1,
    stubbed,
    systemContent: "Call studio_create_task_draft with agent_id of a source-guild member.",
  });
  assert.equal(messages[0]?.content, "Call studio_create_task_draft with agent_id of a source-guild member.");
  assert.match(String(messages[1]?.content), /roster/);
});

test("parseToolArgs recovers agent_id from truncated JSON", () => {
  const recovered = parseToolArgs(
    '{"agent_id":"a_01M2P2GG3G1DRWV3ZCCXY9H9AZ","rationale":"rewrite manager","proposed_content":"Start',
  );
  assert.equal(recovered.agent_id, "a_01M2P2GG3G1DRWV3ZCCXY9H9AZ");
  assert.equal(recovered.rationale, "rewrite manager");
  const aliased = recoverPartialToolArgs('{"target_agent_id":"mr-manager","proposed_content":"broken');
  assert.equal(aliased.agent_id, "mr-manager");
});
