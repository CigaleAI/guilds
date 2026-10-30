import assert from "node:assert/strict";
import { test } from "node:test";
import type { FlowCall, FlowSegment, FlowStats } from "../runs/runFlowModel";
import {
  callHint,
  cardServer,
  generationStatus,
  revealedCall,
  taskPrompt,
  taskRepository,
  taskStatus,
} from "./FlowView";

function flowCall(id: string, patch: Partial<FlowCall> = {}): FlowCall {
  return {
    id,
    call: { function: { name: "code_task", arguments: '{"brief":"Fix it","repo":"guilds/api"}' } },
    result: null,
    position: 1,
    info: { name: "code_task", kind: "execute", level: null, server: null },
    error: null,
    ...patch,
  };
}

const stats: FlowStats = {
  steps: 1,
  calls: 1,
  toolErrors: 0,
  errors: 0,
  running: 0,
  modelMs: 0,
  toolMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: null,
  kinds: "",
  reasoning: 0,
};

test("a reveal opens the call it names, by id or by its result's sequence", () => {
  const first = flowCall("c1", { result: { seq: 4 } });
  const second = flowCall("c2", { result: { seq: 6 } });
  const flow: FlowSegment = {
    type: "flow",
    generation: 1,
    key: "f",
    steps: [
      { index: 1, turn: { seq: 3 }, calls: [first] },
      { index: 2, turn: { seq: 5 }, calls: [second] },
    ],
    errors: [],
  };
  assert.equal(revealedCall(flow, { call: "c2" }), second);
  assert.equal(revealedCall(flow, { seq: 4 }), first);
  assert.equal(revealedCall(flow, { seq: 5 }), second);
  assert.equal(revealedCall(flow, { call: "c9" }), null);
  assert.equal(revealedCall(flow, undefined), null);
});

test("a stopped generation counts its unanswered calls as errors; a generating one runs", () => {
  assert.deepEqual(generationStatus({ ...stats, running: 1 }, false), { kind: "errors", count: 1 });
  assert.deepEqual(generationStatus({ ...stats, running: 1 }, true), { kind: "running" });
  assert.deepEqual(generationStatus({ ...stats, errors: 2 }, true), { kind: "errors", count: 2 });
  assert.deepEqual(generationStatus(stats, false), { kind: "completed" });
});

test("a running code task's hint says its harness is generating", () => {
  const call = flowCall("c1");
  assert.equal(callHint(call, "codex", "running"), "Codex is generating… · Code task in guilds/api");
  assert.equal(callHint(call, "codex", "ok"), "Code task in guilds/api");
});

test("a card names its connected server unless the tool's name carries it", () => {
  const info = { name: "search", kind: "connected" as const, level: null, server: "github" };
  assert.equal(cardServer(flowCall("c1", { info })), "github");
  assert.equal(cardServer(flowCall("c1", { info: { ...info, name: "github_search" } })), null);
  assert.equal(cardServer(flowCall("c1")), null);
});

test("a code task's repository is the one its result names, else the one it was asked for", () => {
  const asked = flowCall("c1");
  assert.equal(taskRepository(asked), "guilds/api");
  const named = flowCall("c1", { result: { metadata: { repository: "guilds/web" } } });
  assert.equal(taskRepository(named), "guilds/web");
  const none = flowCall("c1", { call: { function: { name: "code_task", arguments: "{}" } } });
  assert.equal(taskRepository(none), "");
});

test("a code task's prompt is its brief, and empty without one", () => {
  assert.equal(taskPrompt(flowCall("c1")), "Fix it");
  assert.equal(taskPrompt(flowCall("c1", { call: { function: { arguments: '{"brief":3}' } } })), "");
});

test("a code task's block reads a finished call as done", () => {
  assert.equal(taskStatus("ok"), "done");
  assert.equal(taskStatus("failed"), "failed");
  assert.equal(taskStatus("running"), "running");
});
