import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueryClient } from "@tanstack/react-query";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import type { ItemSections, ReachSubject } from "../../api/types/access";
import type { FileItem } from "../../api/types/files";

function file(name: string): FileItem {
  return {
    id: `f_${name}`,
    display_path: `org/o1/files/${name}`,
    name,
    description: `About ${name}`,
    mime: "text/plain",
    bytes: 10,
    version: 1,
    author: "operator",
    updated_at: "2026-01-01T00:00:00.000Z",
    home: null,
    viewer_mode: "write",
  };
}

const page: ReachSubject = { type: "guild", id: "g1" };

test("files are selected apart from the open one, and a confirmed delete sends each named file once, in turn, reporting what it deleted and what it could not", async () => {
  const window = new Window({ url: "http://localhost/" });
  const globals = {
    window,
    self: window,
    document: window.document,
    scrollTo: window.scrollTo.bind(window),
    // The checkbox and the dialog measure, observe, focus and dispatch their own events through these.
    getComputedStyle: window.getComputedStyle.bind(window),
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    FocusEvent: window.FocusEvent,
    KeyboardEvent: window.KeyboardEvent,
    PointerEvent: window.PointerEvent,
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
    // The server: the page's files, the ids whose delete it refuses, and every request it got.
    const longPrefix = "quarterly-operations-review-for-the-northern-region-consolidated-draft-";
    const longNames = [`${longPrefix}reviewed-by-finance.csv`, `${longPrefix}reviewed-by-legal.csv`];
    const stored: ItemSections<FileItem> = {
      own: [file("a.txt"), file("b.txt")],
      shared: [file("c.txt"), file("d.txt"), ...longNames.map(file)],
    };
    const refused = new Set<string>();
    const deletes: string[] = [];
    let listFetches = 0;
    globalThis.fetch = async (input, init) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (init?.method === "DELETE") {
        const id = decodeURIComponent(path.replace("/api/files/", ""));
        deletes.push(id);
        if (refused.has(id)) {
          return Response.json({ detail: "write not allowed" }, { status: 422 });
        }
        stored.own = stored.own.filter((item) => item.id !== id);
        stored.shared = stored.shared.filter((item) => item.id !== id);
        return new Response(null, { status: 204 });
      }
      if (path === "/api/guilds/g1/files") {
        listFetches += 1;
        return Response.json(stored);
      }
      return Response.json({ detail: "Not found" }, { status: 404 });
    };

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
    const { getToasts } = await import("@guildsrun/ui");
    const { FilesBrowser } = await import("./FilesBrowser");

    // A finite gcTime leaves a timer after the browser unmounts that keeps the test running.
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { gcTime: Infinity },
      },
    });
    queries = client;
    const router = createRouter({
      routeTree: createRootRoute({
        component: () => createElement(FilesBrowser, { page, guildId: "g1" }),
      }),
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
    // A fetch answers over several ticks; the view is read once it shows what it waits for.
    const until = async (shown: () => boolean, what: string) => {
      for (let tick = 0; tick < 40 && !shown(); tick++) await settle(() => undefined);
      assert.ok(shown(), what);
    };
    const button = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) =>
          candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
      );
    const press = (label: string) =>
      settle(() => {
        const target = button(label);
        assert.ok(target, `the ${label} button`);
        target.click();
      });
    const row = (name: string) =>
      [...container.querySelectorAll<HTMLButtonElement>("button:not([role])")].find((candidate) =>
        candidate.textContent?.includes(name),
      );
    const openRow = () =>
      container.querySelector('button[aria-current="true"]')?.textContent ?? "";
    const toolbar = () =>
      [...container.querySelectorAll("span")].find((span) => / selected$/.test(span.textContent ?? ""))
        ?.textContent ?? null;
    const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
    const toastTitles = () => getToasts().map((record) => record.title);
    const search = (text: string) =>
      settle(() => {
        const input = container.querySelector<HTMLInputElement>('input[aria-label="Search files"]');
        assert.ok(input, "the search field");
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
          input,
          text,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });

    await settle(async () => {
      await router.load();
      mounted.render(
        createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
      );
    });
    await until(() => row("d.txt") !== undefined, "the page's files");
    assert.match(openRow(), /a\.txt/);
    assert.equal(toolbar(), null, "nothing is selected at first");

    // A box selects without opening; a row opens without selecting.
    await press("Select b.txt");
    assert.equal(toolbar(), "1 selected");
    assert.match(openRow(), /a\.txt/);
    await settle(() => row("b.txt")?.click());
    assert.match(openRow(), /b\.txt/);
    assert.equal(toolbar(), "1 selected");
    await settle(() => row("a.txt")?.click());

    // A search that hides a selected file drops it, and clearing the search does not bring it back.
    await search("c.txt");
    assert.equal(toolbar(), null);
    await search("");
    assert.equal(toolbar(), null);

    // Clear selection empties it.
    await press("Select a.txt");
    await press("Select c.txt");
    assert.equal(toolbar(), "2 selected");
    await press("Clear selection");
    assert.equal(toolbar(), null);

    // Long names that share a prefix are shown whole in the confirmation, wrapping instead of cut off,
    // inside the dialog's scrolling body.
    for (const name of longNames) await press(`Select ${name}`);
    await press("Delete selected");
    const shownNames = [...(dialog()?.querySelectorAll<HTMLElement>("span.font-mono") ?? [])];
    assert.deepEqual(
      shownNames.map((span) => span.textContent),
      longNames,
    );
    for (const span of shownNames) {
      assert.ok(span.classList.contains("break-all"), "the name wraps");
      assert.ok(!span.classList.contains("truncate"), "the name is not cut off");
      assert.ok(span.closest(".overflow-y-auto"), "the names scroll within the dialog");
    }
    await press("Cancel");
    await press("Clear selection");
    assert.equal(toolbar(), null);

    // The confirmation names the files and their count; Cancel sends nothing and keeps them selected.
    await press("Select a.txt");
    await press("Select b.txt");
    await press("Select c.txt");
    assert.equal(toolbar(), "3 selected");
    await press("Delete selected");
    assert.match(dialog()?.textContent ?? "", /Delete 3 files\?/);
    assert.match(dialog()?.textContent ?? "", /a\.txt.*b\.txt.*c\.txt/);
    assert.match(dialog()?.textContent ?? "", /Agents that fetched one keep their copies/);
    assert.deepEqual(deletes, [], "nothing is sent before the confirm");
    await press("Cancel");
    assert.equal(dialog(), null);
    assert.deepEqual(deletes, []);
    assert.equal(toolbar(), "3 selected");

    // A confirm pressed twice deletes each named file once, in turn; the refused one stays
    // selected, the deleted ones leave the list and the selection, and the deleted open file closes.
    refused.add("f_b.txt");
    const fetchesBefore = listFetches;
    const toastsBefore = toastTitles().length;
    await press("Delete selected");
    await settle(() => {
      button("Delete files")?.click();
      button("Delete files")?.click();
    });
    await until(() => dialog() === null, "the dialog closes once every request is answered");
    assert.deepEqual(deletes, ["f_a.txt", "f_b.txt", "f_c.txt"]);
    assert.ok(listFetches > fetchesBefore, "the list is fetched again");
    await until(() => row("a.txt") === undefined && row("c.txt") === undefined, "the deleted files leave");
    assert.ok(row("b.txt"));
    assert.equal(toolbar(), "1 selected");
    assert.doesNotMatch(openRow(), /a\.txt/);
    assert.deepEqual(toastTitles().slice(toastsBefore), ["2 files deleted", "Couldn't delete 1 file"]);
    assert.equal(getToasts().at(-1)?.description, "b.txt: write not allowed");

    // A delete every file refuses reports no success, refreshes the list, and keeps the file selected.
    const fetchesBeforeRetry = listFetches;
    const toastsBeforeRetry = toastTitles().length;
    await press("Delete selected");
    assert.match(dialog()?.textContent ?? "", /Delete 1 file\?/);
    await press("Delete files");
    await until(() => dialog() === null, "the dialog closes");
    assert.deepEqual(deletes.slice(3), ["f_b.txt"]);
    assert.ok(listFetches > fetchesBeforeRetry, "a refused delete fetches the list again too");
    assert.deepEqual(toastTitles().slice(toastsBeforeRetry), ["Couldn't delete 1 file"]);
    assert.equal(toolbar(), "1 selected");

    // The retry that succeeds empties the selection.
    refused.clear();
    await press("Delete selected");
    await press("Delete files");
    await until(() => toolbar() === null, "the selection empties");
    assert.deepEqual(deletes.slice(4), ["f_b.txt"]);
    assert.equal(toastTitles().at(-1), "1 file deleted");
  } finally {
    if (root) {
      const leftover: Root = root;
      const { act } = await import("react");
      await act(async () => leftover.unmount());
    }
    queries?.clear();
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    Reflect.deleteProperty(globalThis, "React");
    for (const [name, descriptor] of nodeGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await window.happyDOM.close();
  }
});
