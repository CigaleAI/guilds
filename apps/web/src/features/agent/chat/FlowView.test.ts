import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessageMetadata, RunMessage, ToolCall } from "../../../api/types/runs";
import type { FlowCall, FlowSegment, FlowStats } from "../runs/runFlowModel";
import {
  callHint,
  cardHarness,
  cardServer,
  dimsCall,
  generationStatus,
  originCounts,
  revealedCall,
  writtenNotePath,
} from "./FlowView";

function codeTaskCall(args: string): ToolCall {
  return { id: "c1", type: "function", function: { name: "code_task", arguments: args } };
}

/** A recorded message at a sequence, with the metadata it carries and its text. */
function message(seq: number, metadata: MessageMetadata = {}, content = ""): RunMessage {
  return {
    id: seq,
    seq,
    payload: { role: "assistant", content },
    metadata,
    created_at: "2026-09-21T08:00:00Z",
    cost_usd: null,
  };
}

function flowCall(id: string, patch: Partial<FlowCall> = {}): FlowCall {
  return {
    id,
    call: codeTaskCall('{"brief":"Fix it","repo":"guilds/api"}'),
    result: null,
    position: 1,
    info: { name: "code_task", kind: "execute", level: null, server: null, harness: null },
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
  const first = flowCall("c1", { result: message(4) });
  const second = flowCall("c2", { result: message(6) });
  const flow: FlowSegment = {
    type: "flow",
    generation: 1,
    key: "f",
    steps: [
      { index: 1, turn: message(3), calls: [first] },
      { index: 2, turn: message(5), calls: [second] },
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

test("an old code_task call's hint has no summary of its own", () => {
  assert.equal(callHint(flowCall("c1")), "");
});

test("a card names its connected server unless the tool's name carries it", () => {
  const info = { name: "search", kind: "connected" as const, level: null, server: "github", harness: null };
  assert.equal(cardServer(flowCall("c1", { info })), "github");
  assert.equal(cardServer(flowCall("c1", { info: { ...info, name: "github_search" } })), null);
  assert.equal(cardServer(flowCall("c1")), null);
});

test("a card marks the harness that made its call, and nothing on a call of a guild tool", () => {
  const shell = { name: "shell", kind: "execute" as const, level: "local" as const, server: null, harness: "cursor" as const };
  assert.deepEqual(cardHarness(flowCall("c1", { info: shell })), { harness: "cursor", title: "Called by Cursor" });
  const mcp = { name: "mcp__notion__search", kind: "connected" as const, level: null, server: "notion", harness: "codex" as const };
  assert.deepEqual(cardHarness(flowCall("c1", { info: mcp })), {
    harness: "codex",
    title: "Called by Codex, on an MCP server it loaded",
  });
  assert.equal(cardHarness(flowCall("c1")), null);
});

test("a harness's call's hint reads by that harness's tools", () => {
  const info = { name: "shell", kind: "execute" as const, level: "local" as const, server: null, harness: "cursor" as const };
  const call: ToolCall = { id: "c1", type: "function", function: { name: "shell", arguments: '{"command":"ls -a"}' } };
  assert.equal(callHint(flowCall("c1", { call, info })), "Run ls -a");
  assert.equal(callHint(flowCall("c1", { call })), "command: ls -a", "a call of no harness");
});

const cursorShell = {
  name: "shell",
  kind: "execute" as const,
  level: "local" as const,
  server: null,
  harness: "cursor" as const,
};

test("the harness filter dims the guild's calls, and the guild filter the harness's", () => {
  const harnessCall = flowCall("c1", { info: cursorShell, result: message(2) });
  const guildCall = flowCall("c2", { result: message(3) });
  assert.equal(dimsCall("harness", harnessCall, false), false);
  assert.equal(dimsCall("harness", guildCall, false), true);
  assert.equal(dimsCall("guild", harnessCall, false), true);
  assert.equal(dimsCall("guild", guildCall, false), false);
  assert.equal(dimsCall(null, guildCall, false), false);
});

test("the writes and errors filters dim the calls that wrote nothing or did not fail", () => {
  const ok = flowCall("c1", { result: message(2) });
  assert.equal(dimsCall("mutations", ok, false), true);
  assert.equal(dimsCall("errors", ok, false), true);
  assert.equal(dimsCall("errors", flowCall("c2", { error: "boom" }), false), false);
  assert.equal(dimsCall("errors", flowCall("c3"), false), false, "a call left unanswered failed");
  assert.equal(dimsCall("errors", flowCall("c3"), true), true, "a call still running");
});

test("a generation a harness ran counts its calls by who made them; a model's none", () => {
  const flow = (calls: FlowCall[], metadata: MessageMetadata = {}): FlowSegment => ({
    type: "flow",
    generation: 1,
    key: "f",
    steps: [{ index: 1, turn: message(1, metadata), calls }],
    errors: [],
  });
  const mixed = flow([flowCall("c1", { info: cursorShell }), flowCall("c2"), flowCall("c3")]);
  assert.deepEqual(originCounts(mixed), { harness: "Cursor", harnessCalls: 1, guildCalls: 2 });
  assert.equal(originCounts(flow([flowCall("c1")])), null);
  assert.deepEqual(originCounts(flow([], { from_harness: "antigravity" })), {
    harness: "Antigravity",
    harnessCalls: 0,
    guildCalls: 0,
  });
});

test("a note_write's chip names the note its result's first line names, and none for another path", () => {
  const wrote = (content: string) => flowCall("c1", { result: message(4, {}, content) });
  assert.equal(writtenNotePath(wrote("org/o1/plan.md\nwritten")), "org/o1/plan.md");
  assert.equal(writtenNotePath(wrote("org/o1/agents/a1/memory.md")), null);
  assert.equal(writtenNotePath(wrote("write not allowed")), null);
  assert.equal(writtenNotePath(flowCall("c1")), null);
});
