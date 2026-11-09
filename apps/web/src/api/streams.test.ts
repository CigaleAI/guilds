import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueryClient } from "@tanstack/react-query";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import type { RunStreamState } from "./streams";
import type { Run } from "./types/runs";

const run: Run = {
  id: "r_1",
  agent_id: "a_1",
  status: "active",
  kind: "schedule",
  config_snapshot: {
    model: "openrouter/openai/gpt-4o-mini",
    temperature: 1,
    max_tokens: 8192,
    max_steps: 30,
    max_tool_calls: 50,
    max_input_tokens: 100000,
    max_wake_ups: 10,
    keep_tool_result_generations: 1,
    max_scripts: 10,
    max_workspace_mib: 10240,
    browser: false,
    browser_language: "en-US",
    browser_optimized: false,
    browser_model: null,
    coding: false,
    harness: null,
    harness_model: null,
    harness_effort: null,
    secret_aliases: {},
    scripting: true,
    memory: true,
    thinking_level: "none",
    tools: [],
    mcp: [],
    secrets: [],
  },
  errors: [],
  generating: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  group_chat_through_seq: null,
};

/** An EventSource the test drives: it opens, and hands each listener the events the test sends. */
class FakeEventSource {
  static opened: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.opened.push(this);
  }

  addEventListener(name: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  send(name: string, data: string): void {
    for (const listener of this.listeners.get(name) ?? [])
      listener(new MessageEvent(name, { data }));
  }

  close(): void {}
}

/** What a test of the run stream holds: the query client, the stream, and what the hook returned last. */
type MountedRunStream = {
  client: QueryClient;
  source: FakeEventSource;
  state: () => RunStreamState;
  settle: (change: () => unknown) => Promise<void>;
};

/** Mounts `useRunStream` for run `r_1` of agent `a_1` with `run` cached, runs `check`, and unmounts it. */
async function withRunStream(check: (mounted: MountedRunStream) => Promise<void>): Promise<void> {
  const window = new Window({ url: "http://localhost/" });
  const globals = {
    window,
    self: window,
    document: window.document,
    EventSource: FakeEventSource,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const nodeEnv = process.env.NODE_ENV;
  let root: Root | null = null;
  let queries: QueryClient | null = null;
  try {
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
    process.env.NODE_ENV = "test";
    // React DOM and the query client tell browser from server when they load.
    const { act, createElement, useEffect } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { runKeys } = await import("./queries/runs");
    const { useRunStream } = await import("./streams");

    const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
    queries = client;
    client.setQueryData(runKeys.run(run.id), run);
    client.setQueryData(runKeys.agentRuns(run.agent_id), [run]);
    let latest: RunStreamState = { live: null, progress: new Map() };
    function RunStream() {
      const state = useRunStream(run.agent_id, run.id);
      useEffect(() => {
        latest = state;
      });
      return null;
    }
    const mounted = createRoot(document.createElement("div"));
    root = mounted;
    const settle = (change: () => unknown) =>
      act(async () => {
        await change();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    FakeEventSource.opened = [];
    await settle(() =>
      mounted.render(createElement(QueryClientProvider, { client }, createElement(RunStream))),
    );
    const source = FakeEventSource.opened.at(-1);
    assert.ok(source, "the run's stream is opened");
    assert.equal(source.url, "/api/runs/r_1/stream");
    await check({ client, source, state: () => latest, settle });
    // Unmounted inside act, React has no work left that would outlive the window.
    await settle(() => mounted.unmount());
    root = null;
  } finally {
    root?.unmount();
    queries?.clear();
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    for (const name of Object.keys(globals)) Reflect.deleteProperty(globalThis, name);
    await window.happyDOM.close();
  }
}

test("finished_clears_generating_on_the_cached_run", async () => {
  await withRunStream(async ({ client, source, settle }) => {
    await settle(() =>
      source.send("generation.finished", '{"generation": 1, "standing": "completed"}'),
    );
    assert.equal(client.getQueryData<Run>(["run", "r_1"])?.generating, false);
    assert.deepEqual(
      client.getQueryData<Run[]>(["agent", "a_1", "runs"])?.map((item) => item.generating),
      [false],
    );
  });
});

test("started_marks_the_cached_run_generating", async () => {
  await withRunStream(async ({ client, source, settle }) => {
    const idle = { ...run, generating: false };
    await settle(() => {
      client.setQueryData(["run", "r_1"], idle);
      client.setQueryData(["agent", "a_1", "runs"], [idle]);
    });
    await settle(() => source.send("generation.started", '{"generation": 2}'));
    assert.equal(client.getQueryData<Run>(["run", "r_1"])?.generating, true);
    assert.deepEqual(
      client.getQueryData<Run[]>(["agent", "a_1", "runs"])?.map((item) => item.generating),
      [true],
    );
  });
});

test("a_reconnect_drops_the_streamed_turn_and_progress", async () => {
  await withRunStream(async ({ source, state, settle }) => {
    await settle(() => source.send("assistant.delta", '{"text": "half a sen"}'));
    await settle(() =>
      source.send(
        "tool.progress",
        '{"run_id": "r_1", "tool_call_id": "call_1", "lines": ["building"]}',
      ),
    );
    assert.equal(state().live?.text, "half a sen");
    assert.equal(state().progress.size, 1);
    await settle(() => source.onopen?.());
    assert.equal(state().live, null);
    assert.equal(state().progress.size, 0);
  });
});
