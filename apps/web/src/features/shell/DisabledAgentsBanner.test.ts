import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueryClient } from "@tanstack/react-query";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import type { Notifications } from "../../api/types/chat";
import type { InboxIssue } from "../../api/types/issues";

const disabling: InboxIssue = {
  id: "issue_blocking",
  guild_id: "guild_1",
  guild_name: "Guild",
  agent_id: "agent_1",
  agent_name: "scout",
  run_id: null,
  kind: "api",
  severity: "blocking",
  status: "open",
  summary: "Login revoked",
  detail: "401",
  tool_name: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  resolved_at: null,
  resolved_by: null,
  agent: null,
};

test("the band names the agents of the inbox's disabling issues, whatever its page of issues holds", async () => {
  const window = new Window({ url: "http://localhost/" });
  const globals = {
    window,
    self: window,
    document: window.document,
    scrollTo: window.scrollTo.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const nodeEnv = process.env.NODE_ENV;
  let root: Root | null = null;
  let queries: QueryClient | null = null;
  try {
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
    // The router renders for a browser under Node only in a test environment.
    process.env.NODE_ENV = "test";
    // React DOM, the query client, and the router tell browser from server when they load.
    const React = await import("react");
    const { act, createElement } = React;
    // The design system's components are compiled here, outside Vite, with the classic JSX
    // transform, so they reach React as a global.
    Object.defineProperty(globalThis, "React", { value: React, configurable: true });
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { RouterProvider, createMemoryHistory, createRootRoute, createRouter } =
      await import("@tanstack/react-router");
    const { chatKeys } = await import("../../api/queries/chat");
    const { DisabledAgentsBanner } = await import("./DisabledAgentsBanner");

    const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
    queries = client;
    const router = createRouter({
      routeTree: createRootRoute({ component: DisabledAgentsBanner }),
      history: createMemoryHistory(),
    });
    const container = document.createElement("div");
    const mounted = createRoot(container);
    root = mounted;
    const settle = (change: () => unknown) =>
      act(async () => {
        await change();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    const setInbox = (inbox: Notifications) =>
      settle(() => client.setQueryData(chatKeys.notifications, inbox));
    const band = () => container.querySelector('[role="alert"]')?.textContent ?? null;

    await settle(async () => {
      await router.load();
      mounted.render(
        createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
      );
    });
    assert.equal(band(), null, "no band before the inbox loads");

    // The blocking issue is absent from the inbox's page of issues.
    await setInbox({ issues: [], disabling: [disabling], mentions: [], unread: [] });
    assert.match(band() ?? "", /scout is disabled until its blocking issue is resolved/);

    // A blocking issue on the page of issues alone disables no one the band names.
    await setInbox({ issues: [disabling], disabling: [], mentions: [], unread: [] });
    assert.equal(band(), null);
  } finally {
    if (root) {
      const mounted = root;
      const { act } = await import("react");
      await act(async () => mounted.unmount());
    }
    queries?.clear();
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    for (const name of [...Object.keys(globals), "React"]) Reflect.deleteProperty(globalThis, name);
    await window.happyDOM.close();
  }
});
