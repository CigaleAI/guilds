import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { QueryClient } from "@tanstack/react-query";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import type { Identity } from "../../api/identity";
import type { MessageNotice } from "../../api/types/chat";
import type { IssueNotice } from "../../api/types/issues";

const identity: Identity = {
  mode: "compat-cookie",
  user: {
    id: "u1",
    name: "Ada",
    email: null,
    image: null,
    timezone: null,
    color: null,
    issue_alert_severity: "high",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    platform_admin: false,
  },
  org: {
    id: "o1",
    name: "Org",
    slug: "org",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    role: "owner",
  },
  orgs: [],
};

function messageIn(guildId: string): MessageNotice {
  return {
    guild_id: guildId,
    seq: 1,
    author_type: "agent",
    author_name: "scout",
    preview: "the feed is back",
    agent: null,
  };
}

const issue: IssueNotice = {
  id: "issue_1",
  guild_id: "g1",
  guild_name: "Guild",
  agent_name: "scout",
  severity: "high",
  summary: "The tool failed",
  agent: null,
};

class FakeParam {
  value = 0;
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  exponentialRampToValueAtTime() {}
}

class FakeNode {
  connect<T>(node: T): T {
    return node;
  }
}

class FakeAudioContext {
  static latest: FakeAudioContext | null = null;
  state = "suspended";
  currentTime = 0;
  destination = {};
  notes = 0;
  constructor() {
    FakeAudioContext.latest = this;
  }
  createOscillator() {
    this.notes += 1;
    return Object.assign(new FakeNode(), {
      frequency: new FakeParam(),
      start() {},
      stop() {},
    });
  }
  createGain() {
    return Object.assign(new FakeNode(), { gain: new FakeParam() });
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
}

test("turning the message chime off silences new messages in every guild, and issues still ring", async () => {
  const window = new Window({ url: "http://localhost/inbox" });
  const globals = {
    window,
    self: window,
    document: window.document,
    localStorage: window.localStorage,
    scrollTo: window.scrollTo.bind(window),
    AudioContext: FakeAudioContext,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const nodeEnv = process.env.NODE_ENV;
  let root: Root | null = null;
  let queries: QueryClient | null = null;
  mock.timers.enable({ apis: ["Date"], now: 0 });
  try {
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
    // The router renders for a browser under Node only in a test environment.
    process.env.NODE_ENV = "test";
    // React DOM, the query client, and the router tell browser from server when they load.
    const { act, createElement, useEffect } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { RouterProvider, createMemoryHistory, createRootRoute, createRouter } =
      await import("@tanstack/react-router");
    const { IdentityContext } = await import("../../app/identity");
    const { writeStored } = await import("../../app/storage");
    const { chimeGapMs, messageChimeMutedKey, useChime, useNewMessageAlerts } =
      await import("./newMessages");
    const { useNewIssueAlerts } = await import("./newIssues");

    let onMessage: (notice: MessageNotice) => void = () => {};
    let onIssue: (notice: IssueNotice) => void = () => {};
    function AlertsShell() {
      const chime = useChime();
      const messageAlerts = useNewMessageAlerts(chime);
      const issueAlerts = useNewIssueAlerts(chime);
      useEffect(() => {
        onMessage = messageAlerts;
        onIssue = issueAlerts;
      });
      return null;
    }
    const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
    queries = client;
    const router = createRouter({
      routeTree: createRootRoute({ component: AlertsShell }),
      history: createMemoryHistory({ initialEntries: ["/inbox"] }),
    });
    const mounted = createRoot(document.createElement("div"));
    root = mounted;
    const settle = (change: () => unknown) =>
      act(async () => {
        await change();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    await settle(async () => {
      await router.load();
      mounted.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            IdentityContext.Provider,
            { value: identity },
            createElement(RouterProvider, { router }),
          ),
        ),
      );
    });
    const notes = () => FakeAudioContext.latest?.notes ?? 0;
    const afterGap = () => mock.timers.tick(chimeGapMs);

    onMessage(messageIn("g1"));
    assert.equal(notes(), 0, "silent until the operator presses a key or a pointer");

    await settle(() => window.dispatchEvent(new window.KeyboardEvent("keydown")));
    onMessage(messageIn("g1"));
    assert.equal(notes(), 2, "on until the operator chooses: two notes");
    onMessage(messageIn("g2"));
    assert.equal(notes(), 2, "a burst rings once");

    afterGap();
    writeStored(messageChimeMutedKey, "true");
    onMessage(messageIn("g2"));
    onMessage(messageIn("g1"));
    assert.equal(notes(), 2, "off, in every guild");
    onIssue(issue);
    assert.equal(notes(), 4, "an issue still rings");

    afterGap();
    writeStored(messageChimeMutedKey, "false");
    onMessage(messageIn("g2"));
    assert.equal(notes(), 6, "on again");
    await settle(() => mounted.unmount());
    root = null;
  } finally {
    mock.timers.reset();
    if (root) {
      const leftover: Root = root;
      const { act } = await import("react");
      await act(async () => leftover.unmount());
    }
    queries?.clear();
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    for (const name of Object.keys(globals)) Reflect.deleteProperty(globalThis, name);
    await window.happyDOM.close();
  }
});
