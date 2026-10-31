import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chatIdleCloseMs,
  heldChatRun,
  holdChatRun,
  releaseChatRun,
  shouldCloseFinishedChat,
} from "./chatLinger";

test("a held run stays on the agent until it is released", () => {
  holdChatRun("a_1", "r_1");
  holdChatRun("a_2", "r_2");
  assert.equal(heldChatRun("a_1"), "r_1");
  assert.equal(heldChatRun("a_2"), "r_2");
  releaseChatRun("a_1");
  assert.equal(heldChatRun("a_1"), undefined);
  assert.equal(heldChatRun("a_2"), "r_2");
  releaseChatRun("a_2");
});

test("a new session is held apart from having nothing held", () => {
  holdChatRun("a_1", "r_1");
  holdChatRun("a_1", null);
  assert.equal(heldChatRun("a_1"), null);
  releaseChatRun("a_1");
  assert.equal(heldChatRun("a_1"), undefined);
});

test("a finished chat closes on focus only after the idle window with no action", () => {
  const finishedAt = 1_000;
  assert.equal(shouldCloseFinishedChat(true, finishedAt, finishedAt + chatIdleCloseMs), false);
  assert.equal(shouldCloseFinishedChat(false, null, finishedAt + chatIdleCloseMs), false);
  assert.equal(shouldCloseFinishedChat(false, finishedAt, finishedAt + chatIdleCloseMs - 1), false);
  assert.equal(shouldCloseFinishedChat(false, finishedAt, finishedAt + chatIdleCloseMs), true);
});
