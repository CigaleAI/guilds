import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chatIdleCloseMs,
  heldChatRun,
  holdChatRun,
  shouldCloseFinishedChat,
} from "./chatLinger";

test("a held run stays on the agent until it is cleared", () => {
  holdChatRun("a_1", "r_1");
  holdChatRun("a_2", "r_2");
  assert.equal(heldChatRun("a_1"), "r_1");
  assert.equal(heldChatRun("a_2"), "r_2");
  holdChatRun("a_1", null);
  assert.equal(heldChatRun("a_1"), undefined);
  assert.equal(heldChatRun("a_2"), "r_2");
  holdChatRun("a_2", null);
});

test("a finished chat closes on focus only after the idle window with no action", () => {
  const finishedAt = 1_000;
  assert.equal(
    shouldCloseFinishedChat({ generating: true, lastActionAt: finishedAt, now: finishedAt + chatIdleCloseMs }),
    false,
  );
  assert.equal(
    shouldCloseFinishedChat({ generating: false, lastActionAt: null, now: finishedAt + chatIdleCloseMs }),
    false,
  );
  assert.equal(
    shouldCloseFinishedChat({
      generating: false,
      lastActionAt: finishedAt,
      now: finishedAt + chatIdleCloseMs - 1,
    }),
    false,
  );
  assert.equal(
    shouldCloseFinishedChat({
      generating: false,
      lastActionAt: finishedAt,
      now: finishedAt + chatIdleCloseMs,
    }),
    true,
  );
});
