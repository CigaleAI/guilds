import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blockingAgents,
  dropQueuedMessage,
  markQueuedMessage,
  queueGroupMessage,
  queuedMessages,
  sendableHead,
  sendQueuedMessage,
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

test("untagged_reply_to_an_agent_waits_only_for_that_agent_while_explicit_tags_override", () => {
  assert.deepEqual(blockingAgents("yes, do that", agents, ["researcher"], "writer"), []);
  assert.deepEqual(blockingAgents("yes, do that", agents, ["writer"], "writer"), ["writer"]);
  assert.deepEqual(blockingAgents("@researcher check this", agents, ["writer"], "writer"), []);
});

test("sendable_head_stops_at_the_first_message_that_waits", () => {
  const queue: QueuedMessage[] = [
    { id: "q_1", content: "first" },
    { id: "q_2", content: "@researcher next" },
    { id: "q_3", content: "last" },
  ];
  const waitsFor = (message: QueuedMessage) =>
    message.content.includes("@researcher") ? ["researcher"] : [];
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

test("queue_keeps_order_per_guild_and_preserves_reply_target", () => {
  const first = queueGroupMessage("g_queue", "one", { seq: 4, agentName: "writer" });
  const second = queueGroupMessage("g_queue", "two");
  queueGroupMessage("g_other", "elsewhere");
  assert.deepEqual(
    queuedMessages("g_queue").map((message) => [
      message.content,
      message.replyToSeq,
      message.replyToAgentName,
    ]),
    [
      ["one", 4, "writer"],
      ["two", undefined, undefined],
    ],
  );
  markQueuedMessage("g_queue", second.id, "failed");
  assert.equal(queuedMessages("g_queue")[1]?.status, "failed");
  dropQueuedMessage("g_queue", first.id);
  dropQueuedMessage("g_queue", second.id);
  assert.deepEqual(queuedMessages("g_queue"), []);
  assert.equal(queuedMessages("g_other").length, 1);
});

test("sent_queued_message_leaves_the_queue_with_its_reply_target", async () => {
  const message = queueGroupMessage("g_send", "hello", { seq: 7 });
  const posted: Array<[string, number | undefined]> = [];
  const error = await sendQueuedMessage("g_send", message, async (item) => {
    posted.push([item.content, item.replyToSeq]);
  });
  assert.equal(error, null);
  assert.deepEqual(posted, [["hello", 7]]);
  assert.deepEqual(queuedMessages("g_send"), []);
});

test("queued_message_that_fails_to_post_stays_failed_with_its_error", async () => {
  const message = queueGroupMessage("g_fail", "hello");
  const error = await sendQueuedMessage("g_fail", message, () =>
    Promise.reject(new Error("offline")),
  );
  assert.equal(error?.message, "offline");
  assert.equal(queuedMessages("g_fail")[0]?.status, "failed");
});
