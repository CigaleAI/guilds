import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueryClient } from "@tanstack/react-query";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import type { Identity } from "../../api/identity";
import type { MentionNotice, Notifications } from "../../api/types/chat";
import type { InboxIssue, IssueSeverity } from "../../api/types/issues";

const mention: MentionNotice = {
  id: 1,
  guild_id: "guild_1",
  guild_name: "Guild",
  seq: 1,
  author_type: "user",
  author_name: "Ada",
  content: "@operator",
  created_at: "2026-01-01T00:00:00.000Z",
  agent: null,
};

/** The operator, alerted to issues of high severity and above. */
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

function openIssue(severity: IssueSeverity): InboxIssue {
  return {
    id: `issue_${severity}`,
    guild_id: "guild_1",
    guild_name: "Guild",
    agent_id: null,
    agent_name: "scout",
    run_id: null,
    kind: "api",
    severity,
    status: "open",
    summary: "The tool failed",
    detail: "It timed out",
    tool_name: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    resolved_at: null,
    resolved_by: null,
    agent: null,
  };
}

test("the tab icon follows the inbox while the shell is mounted, and turns plain on unmount", async () => {
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
    const { act, createElement } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { RouterProvider, createMemoryHistory, createRootRoute, createRouter } =
      await import("@tanstack/react-router");
    const { chatKeys } = await import("../../api/queries/chat");
    const { IdentityContext } = await import("../../app/identity");
    const { useInboxFavicon } = await import("./inbox");

    document.head.innerHTML = '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />';
    const icon = () => document.querySelector('link[rel="icon"]')?.getAttribute("href");
    const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
    queries = client;
    function InboxFaviconShell() {
      useInboxFavicon();
      return null;
    }
    const router = createRouter({
      routeTree: createRootRoute({ component: InboxFaviconShell }),
      history: createMemoryHistory(),
    });
    const mounted = createRoot(document.createElement("div"));
    root = mounted;
    const settle = (change: () => unknown) =>
      act(async () => {
        await change();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    const setInbox = (inbox: Notifications) =>
      settle(() => client.setQueryData(chatKeys.notifications, inbox));

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
    assert.equal(icon(), "/favicon.svg");

    await setInbox({ issues: [], mentions: [mention], disabling: [], unread: [] });
    assert.equal(icon(), "/favicon-unread.svg");

    await setInbox({ issues: [], mentions: [], disabling: [], unread: [] });
    assert.equal(icon(), "/favicon.svg");

    await setInbox({ issues: [openIssue("medium")], mentions: [], disabling: [], unread: [] });
    assert.equal(icon(), "/favicon.svg", "an issue below the operator's alert severity");

    await setInbox({
      issues: [openIssue("medium"), openIssue("high")],
      mentions: [],
      disabling: [],
      unread: [],
    });
    assert.equal(icon(), "/favicon-unread.svg", "an issue at the operator's alert severity");

    await settle(() => mounted.unmount());
    assert.equal(icon(), "/favicon.svg");
  } finally {
    root?.unmount();
    queries?.clear();
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    for (const name of Object.keys(globals)) Reflect.deleteProperty(globalThis, name);
    await window.happyDOM.close();
  }
});
