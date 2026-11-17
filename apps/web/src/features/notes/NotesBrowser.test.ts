import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueryClient } from "@tanstack/react-query";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import type { Identity } from "../../api/identity";
import type { AccessEntry, AccessList, AccessRow, ItemSections, ReachSubject } from "../../api/types/access";
import type { NoteItem } from "../../api/types/notes";
import { listedItems } from "../access/listedItems";

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

test("the browser groups the page's notes by the grants their access lists show, opens and searches across repeated notes, keeps drafts and version checks, and regroups after an access edit", async () => {
  const window = new Window({ url: "http://localhost/" });
  const globals = {
    window,
    self: window,
    document: window.document,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    HTMLFormElement: window.HTMLFormElement,
    DocumentFragment: window.DocumentFragment,
    NodeFilter: window.NodeFilter,
    CustomEvent: window.CustomEvent,
    FocusEvent: window.FocusEvent,
    scrollTo: window.scrollTo.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window),
    fetch: globalThis.fetch,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const nodeGlobals = Object.keys(globals).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const nodeEnv = process.env.NODE_ENV;
  let root: Root | null = null;
  let queries: QueryClient | null = null;
  try {
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
    process.env.NODE_ENV = "test";

    const entry = (
      type: AccessEntry["type"],
      id: string,
      name: string,
      mode: AccessEntry["mode"],
    ): AccessEntry => ({ type, id, name, mode, guild_id: type === "org" ? null : id, guild_name: null });
    const org = entry("org", "o1", "acme", "read");
    const ops = entry("guild", "g_ops", "ops", "write");
    const scout = entry("agent", "a1", "scout", "none");
    const research = { id: "g1", name: "Research" };
    const listed = (path: string, home: NoteItem["home"], viewer_mode: NoteItem["viewer_mode"] = "read") => ({
      ...note(path, home),
      viewer_mode,
    });
    // The server: the page's notes by home, each note's access list, the slow note's read held
    // until released, the note whose list a privacy filter refuses until it is fixed, and the
    // open note's text and version.
    const sections: ItemSections<NoteItem> = {
      own: [
        listed("draft.md", research),
        listed("locked.md", research, "none"),
        listed("plan.md", research),
        listed("slow.md", research),
      ],
      shared: [
        listed("brand.md", null),
        listed("twin-a.md", { id: "g_a", name: "twin" }),
        listed("twin-b.md", { id: "g_b", name: "twin" }),
        listed("vault.md", { id: "g_ops", name: "ops" }),
      ],
    };
    const lists: Record<string, AccessEntry[]> = {
      "n_plan.md": [org, ops],
      "n_draft.md": [],
      "n_locked.md": [scout],
      "n_slow.md": [org],
      "n_brand.md": [{ ...scout, mode: "write" }],
      "n_twin-a.md": [entry("guild", "g_a", "twin", "read")],
      "n_twin-b.md": [entry("guild", "g_b", "twin", "read")],
      "n_vault.md": [org],
    };
    let refused: string | null = "n_vault.md";
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const texts: Record<string, { content: string; version: number }> = {
      "plan.md": { content: "The plan.", version: 1 },
      "brand.md": { content: "The brand.", version: 1 },
    };
    const saves: { key: string; expected: number | undefined }[] = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/guilds/g1/notes") return Response.json(sections);
      const accessId = /^\/api\/notes\/([^/]+)\/access$/.exec(url.pathname)?.[1];
      if (accessId) {
        const id = decodeURIComponent(accessId);
        if (method === "PUT") {
          const { subjects } = JSON.parse(String(init?.body)) as { subjects: AccessRow[] };
          lists[id] = subjects.map((row) => [org, ops, scout].find((known) => known.id === row.id) ?? org);
        } else {
          if (id === refused) return Response.json({ detail: "Forbidden" }, { status: 403 });
          if (id === "n_slow.md") await slow;
        }
        const list: AccessList = { subjects: lists[id] ?? [] };
        return Response.json(list);
      }
      const noteKey = /^\/api\/org\/notes\/([^/]+)$/.exec(url.pathname)?.[1];
      const text = noteKey ? texts[decodeURIComponent(noteKey)] : undefined;
      if (noteKey && text) {
        const key = decodeURIComponent(noteKey);
        if (method === "PUT") {
          const body = JSON.parse(String(init?.body)) as { content: string; expected_version?: number };
          saves.push({ key, expected: body.expected_version });
          if (body.expected_version !== text.version)
            return Response.json({ detail: "Version conflict" }, { status: 409 });
          text.content = body.content;
          text.version += 1;
        }
        return Response.json({
          path: key,
          content: text.content,
          display_path: `org/o1/${key}`,
          version: text.version,
        });
      }
      return Response.json({ detail: "Not found" }, { status: 404 });
    };

    const React = await import("react");
    const { act, createElement } = React;
    Object.defineProperty(globalThis, "React", { value: React, configurable: true });
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { RouterProvider, createMemoryHistory, createRootRoute, createRouter } =
      await import("@tanstack/react-router");
    const { useSetItemAccess } = await import("../../api/queries/access");
    const { IdentityContext } = await import("../../app/identity");
    const { NotesBrowser } = await import("./NotesBrowser");

    // Beside the browser, an access save for draft.md, as its access dialog calls it.
    const View = () => {
      const share = useSetItemAccess({ kind: "note", id: "n_draft.md" });
      return createElement(
        "div",
        null,
        createElement(
          "button",
          { type: "button", onClick: () => share.mutate([{ type: "guild", id: "g_ops", mode: "read" }]) },
          "Share draft",
        ),
        createElement(NotesBrowser, { page, guildId: "g1" }),
      );
    };
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { gcTime: Infinity },
      },
    });
    queries = client;
    const router = createRouter({
      routeTree: createRootRoute({ component: View }),
      history: createMemoryHistory(),
    });
    const container = document.body.appendChild(document.createElement("div"));
    const mounted = createRoot(container);
    root = mounted;
    const settle = (change: () => unknown) =>
      act(async () => {
        await change();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    const until = async (shown: () => boolean, what: string) => {
      for (let tick = 0; tick < 40 && !shown(); tick++) await settle(() => undefined);
      assert.ok(shown(), what);
    };
    const aside = () => container.querySelector("aside");
    const pathOf = (row: Element) => /[\w-]+\.md/.exec(row.textContent ?? "")?.[0];
    const rows = (within: Element | null = aside()) => [
      ...(within?.querySelectorAll<HTMLButtonElement>("section[aria-label] button[type=button]") ?? []),
    ].filter((button) => pathOf(button));
    // Each group's label and the note paths under it, as the list shows them.
    const groups = () =>
      [...(aside()?.querySelectorAll("section[aria-label]") ?? [])].map((section) => [
        section.getAttribute("aria-label"),
        rows(section).map(pathOf),
      ]);
    const selected = () =>
      rows()
        .filter((row) => row.getAttribute("aria-current") === "true")
        .map(pathOf);
    const pick = (path: string, occurrence = 0) =>
      settle(() => rows().filter((row) => pathOf(row) === path)[occurrence]?.click());
    const button = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === label,
      );
    const press = (label: string) =>
      settle(() => {
        const target = button(label);
        assert.ok(target, `the ${label} button`);
        target.click();
      });
    const type = (field: HTMLInputElement | HTMLTextAreaElement | null, text: string) =>
      settle(() => {
        assert.ok(field);
        const prototype = Object.getPrototypeOf(field) as object;
        Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, text);
        field.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
      });
    const editor = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note"]');
    const edit = async () => {
      const toggle = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
        (radio) => radio.textContent === "Edit",
      );
      await settle(() => toggle?.click());
      await until(() => Boolean(editor()), "the note in Edit");
    };

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
    await until(
      () => groups().some(([label]) => label === "Couldn't read access"),
      "the refused read",
    );

    // Every listed note is in sight, under each grant it shows; same-name guilds stay apart, the
    // empty and None-only lists are not fully known, and a held or refused read is listed apart.
    assert.deepEqual(groups(), [
      ["Organisation", ["plan.md"]],
      ["Guild · ops", ["plan.md"]],
      ["Guild · twin", ["twin-a.md"]],
      ["Guild · twin", ["twin-b.md"]],
      ["Individual agents", ["brand.md"]],
      ["Access not fully known", ["draft.md", "locked.md"]],
      ["Reading access", ["slow.md"]],
      ["Couldn't read access", ["vault.md"]],
    ]);
    assert.equal(
      new Set(rows().map(pathOf)).size,
      listedItems(sections).length,
      "every listed note stays listed",
    );
    assert.match(rows().find((row) => pathOf(row) === "brand.md")?.textContent ?? "", /Organisation/);
    assert.ok(!(container.textContent ?? "").includes("Forbidden"), "the refusal names no subject");

    // The first reached note opens; a note picked is marked in each of its groups.
    assert.deepEqual(selected(), ["draft.md"]);
    await pick("plan.md");
    assert.deepEqual(selected(), ["plan.md", "plan.md"]);

    // A greyed note opens its access list, not its text, and the open note stays.
    await pick("locked.md");
    await until(() => (document.body.textContent ?? "").includes("Access to locked.md"), "locked.md's access");
    await settle(() =>
      document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event),
    );
    assert.deepEqual(selected(), ["plan.md", "plan.md"]);

    // The held read lands; a retry reads the refused list again.
    await settle(() => release());
    await until(() => !groups().some(([label]) => label === "Reading access"), "the held read");
    refused = null;
    await press("Retry");
    await until(() => !groups().some(([label]) => label === "Couldn't read access"), "the retried read");
    assert.deepEqual(groups()[0], ["Organisation", ["plan.md", "slow.md", "vault.md"]]);

    // A search keeps the groups of the matching notes only.
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search notes"]');
    await type(search, "twin");
    assert.deepEqual(groups(), [
      ["Guild · twin", ["twin-a.md"]],
      ["Guild · twin", ["twin-b.md"]],
    ]);
    await type(search, "nothing like it");
    assert.deepEqual(groups(), []);
    assert.match(aside()?.textContent ?? "", /No notes match\./);
    await type(search, "");

    // A draft survives opening another note and coming back through another occurrence.
    await until(() => Boolean(button("Save")), "plan.md's text");
    await edit();
    await type(editor(), "My plan.");
    await pick("brand.md");
    assert.deepEqual(selected(), ["brand.md"]);
    await pick("plan.md", 1);
    assert.deepEqual(selected(), ["plan.md", "plan.md"]);
    await until(() => (container.textContent ?? "").includes("Unsaved changes"), "the kept draft");
    await edit();
    assert.equal(editor()?.value, "My plan.");

    // A save over a version someone saved since is refused and the text kept; the next one lands.
    texts["plan.md"] = { content: "Their plan.", version: 2 };
    await press("Save");
    await until(() => saves.length === 1, "the refused save");
    await until(() => (container.textContent ?? "").includes("v2"), "their version read");
    assert.equal(editor()?.value, "My plan.");
    await press("Save");
    await until(() => !(container.textContent ?? "").includes("Unsaved changes"), "the save");
    assert.deepEqual(saves, [
      { key: "plan.md", expected: 1 },
      { key: "plan.md", expected: 2 },
    ]);
    assert.equal(texts["plan.md"]?.content, "My plan.");

    // Sharing draft.md with ops moves it under ops without reloading the page.
    await press("Share draft");
    await until(
      () => groups().some(([label, paths]) => label === "Guild · ops" && paths?.includes("draft.md")),
      "draft.md under ops",
    );
    assert.deepEqual(
      groups().find(([label]) => label === "Access not fully known"),
      ["Access not fully known", ["locked.md"]],
    );
  } finally {
    if (root) {
      const leftover: Root = root;
      const { act } = await import("react");
      await act(async () => leftover.unmount());
    }
    queries?.clear();
    process.env.NODE_ENV = nodeEnv;
    Reflect.deleteProperty(globalThis, "React");
    for (const [name, descriptor] of nodeGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await window.happyDOM.close();
  }
});
