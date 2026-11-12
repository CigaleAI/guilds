import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueryClient } from "@tanstack/react-query";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import type { Identity } from "../../api/identity";
import type { ItemSections, ReachSubject } from "../../api/types/access";
import type { NoteItem } from "../../api/types/notes";

function note(path: string, home: NoteItem["home"]): NoteItem {
  return {
    id: `n_${path}`,
    path,
    display_path: `org/o1/${path}`,
    kind: "note",
    title: null,
    version: 1,
    home,
    viewer_mode: "read",
  };
}

const page: ReachSubject = { type: "guild", id: "g1" };

const notes: ItemSections<NoteItem> = {
  own: [note("plan.md", { id: "g1", name: "Research" })],
  shared: [note("brand.md", null)],
};

const identity: Identity = {
  mode: "compat-cookie",
  user: {
    id: "u1",
    name: "Ada",
    email: null,
    image: null,
    timezone: null,
    color: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    issue_alert_severity: "low",
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

test("the browser lists a page's own and shared notes, opens the first, and opens a shared one picked", async () => {
  const window = new Window({ url: "http://localhost/" });
  const globals = {
    window,
    self: window,
    document: window.document,
    scrollTo: window.scrollTo.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window),
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
    // tsx compiles the UI kit's components outside this app's tsconfig, with the classic JSX
    // transform, so they reach React as a global.
    Object.defineProperty(globalThis, "React", { value: React, configurable: true });
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { RouterProvider, createMemoryHistory, createRootRoute, createRouter } =
      await import("@tanstack/react-router");
    const { noteKeys } = await import("../../api/queries/notes");
    const { IdentityContext } = await import("../../app/identity");
    const { NotesBrowser } = await import("./NotesBrowser");

    // The open note's own queries are enabled by its path; their fetch fails at once without a server.
    const client = new QueryClient({
      defaultOptions: { queries: { enabled: false, retry: false } },
    });
    queries = client;
    client.setQueryData(noteKeys.noteList(page), notes);
    const router = createRouter({
      routeTree: createRootRoute({
        component: () => createElement(NotesBrowser, { page, guildId: "g1" }),
      }),
      history: createMemoryHistory(),
    });
    const container = document.createElement("div");
    document.body.append(container);
    const mounted = createRoot(container);
    root = mounted;
    const settle = (change: () => unknown) =>
      act(async () => {
        await change();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    const row = (path: string) =>
      [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes(path),
      );
    const selected = () =>
      [...container.querySelectorAll('button[aria-current="true"]')].map(
        (button) => button.textContent,
      );

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
    assert.ok(row("plan.md"));
    assert.ok(row("brand.md"));
    assert.equal(selected().length, 1);
    assert.match(selected()[0] ?? "", /plan\.md/);

    await settle(() => row("brand.md")?.click());
    assert.equal(selected().length, 1);
    assert.match(selected()[0] ?? "", /brand\.md/);
  } finally {
    if (root) {
      const mounted = root;
      const { act } = await import("react");
      await act(async () => mounted.unmount());
    }
    queries?.clear();
    process.env.NODE_ENV = nodeEnv;
    for (const name of [...Object.keys(globals), "React"]) Reflect.deleteProperty(globalThis, name);
    await window.happyDOM.close();
  }
});
