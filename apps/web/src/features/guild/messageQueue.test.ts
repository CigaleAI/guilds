import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blockingAgents,
  dropQueuedMessage,
  markQueuedMessage,
  queueGroupMessage,
  queuedMessages,
  sendableHead,
  taggedAgentNames,
  type QueuedMessage,
} from "./messageQueue";

const agents = new Set(["researcher", "writer"]);

test("tagged_agent_names_reads_member_tags_once", () => {
  assert.deepEqual(taggedAgentNames("@writer and @writer, ask @user or @nobody", agents), [
    "writer",
  ]);
  assert.deepEqual(taggedAgentNames("mail me at a@writer.com", agents), []);
});

test("untagged_message_waits_for_every_agent_in_a_run", () => {
  assert.deepEqual(blockingAgents("Plan the release.", agents, ["researcher"]), ["researcher"]);
  assert.deepEqual(blockingAgents("Plan the release.", agents, []), []);
});

test("tagged_message_waits_only_for_tagged_agents_in_a_run", () => {
  assert.deepEqual(blockingAgents("@writer draft it", agents, ["researcher"]), []);
  assert.deepEqual(blockingAgents("@researcher @writer go", agents, ["researcher"]), [
    "researcher",
  ]);
});

test("sendable_head_stops_at_the_first_message_that_waits", () => {
  const queue: QueuedMessage[] = [
    { id: "q_1", content: "first" },
    { id: "q_2", content: "@researcher next" },
    { id: "q_3", content: "last" },
  ];
  const waitsFor = (content: string) => (content.includes("@researcher") ? ["researcher"] : []);
  assert.deepEqual(
    sendableHead(queue, waitsFor).map((message) => message.id),
    ["q_1"],
  );
  assert.deepEqual(
    sendableHead(queue, () => []).map((message) => message.id),
    ["q_1", "q_2", "q_3"],
  );
});

test("sendable_head_holds_behind_a_message_being_sent_or_failed", () => {
  const second: QueuedMessage = { id: "q_2", content: "second" };
  assert.deepEqual(
    sendableHead([{ id: "q_1", content: "first", status: "failed" }, second], () => []),
    [],
  );
  assert.deepEqual(
    sendableHead([{ id: "q_1", content: "first", status: "sending" }, second], () => []),
    [],
  );
});

test("queue_keeps_order_per_guild_and_drops_by_id", () => {
  const first = queueGroupMessage("g_queue", "one");
  const second = queueGroupMessage("g_queue", "two");
  queueGroupMessage("g_other", "elsewhere");
  assert.deepEqual(
    queuedMessages("g_queue").map((message) => message.content),
    ["one", "two"],
  );
  markQueuedMessage("g_queue", second.id, "failed");
  assert.equal(queuedMessages("g_queue")[1]?.status, "failed");
  dropQueuedMessage("g_queue", first.id);
  dropQueuedMessage("g_queue", second.id);
  assert.deepEqual(queuedMessages("g_queue"), []);
  assert.equal(queuedMessages("g_other").length, 1);
});
