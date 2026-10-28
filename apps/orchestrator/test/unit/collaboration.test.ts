import assert from "node:assert/strict";
import { groupMessageRow } from "../helpers/group-chat.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { groupChatUserMessage } from "../../src/groupchat/index.js";
import { repoRoot } from "../../src/lib/paths.js";
import { CASES } from "../helpers/collaboration-cases.js";

test("default_task_prompt_is_assist_and_collaborate", () => {
  const task = readFileSync(
    path.join(repoRoot(import.meta.url), "apps", "orchestrator", "src", "prompts", "task.md"),
    "utf8",
  );
  assert.equal(task.trim(), "Assist the user and collaborate with the guild members.");
});

test("collaboration_cases_include_silence_and_reply", () => {
  const ids = CASES.map((item) => item.id);
  assert.deepEqual(ids, [...new Set(ids)]);
  assert.ok(CASES.some((item) => item.expect_post));
  assert.ok(CASES.some((item) => !item.expect_post));
});

test("collaboration_cases_latest_message_matches_history", () => {
  for (const item of CASES) {
    const rows = item.history.map((entry, index) => {
      const seq = index + 1;
      const sentBy = entry.sentBy;
      return groupMessageRow(seq, { author_type: sentBy === "user" ? "user" : "agent", author_name: sentBy === "user" ? "user" : sentBy, author_agent_id: sentBy === "user" ? null : sentBy, content: entry.content, });
    });
    const [payload] = groupChatUserMessage({
      members: item.members.map((name) => ({ id: name, name })),
      rows,
    });
    const content = String((payload as { content: string }).content);
    const latest = item.history[item.history.length - 1];
    assert.ok(latest);
    assert.ok(content.includes(latest.content));
  }
});
