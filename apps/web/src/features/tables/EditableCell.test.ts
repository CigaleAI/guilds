import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueryClient } from "@tanstack/react-query";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import type { Collection, CollectionRecord, Column } from "../../api/types/tables";

function column(name: string, type: Column["type"], extra: Partial<Column> = {}): Column {
  return { name, type, description: "", required: false, unique: false, ...extra };
}

const collection: Collection = {
  id: "c1",
  name: "Leads",
  purpose: "",
  columns: [
    column("score", "number", { required: true }),
    column("tags", "array", { values: ["red", "blue"] }),
  ],
  display_path: "org/o1/collections/leads",
  scope: "org",
  guild: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  count: 1,
};

function record(score: number): CollectionRecord {
  return {
    id: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    updated_by: null,
    version: score,
    display_path: "",
    score,
    tags: ["red"],
  };
}

/** A PATCH the panel sent: its path and its JSON body. */
type SentPatch = { path: string; body: string };

test("a cell's pencil edits its value in place: Cancel and an unchanged Save send nothing, an invalid value is refused, a failed save stays open, a valid one saves, and the row never opens", async () => {
  const window = new Window({ url: "http://localhost/" });
  const globals = {
    window,
    self: window,
    document: window.document,
    scrollTo: window.scrollTo.bind(window),
    // The popover and the dialog measure, observe, focus and dispatch their own events through these.
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
    // The server: the record as last saved, and the reply the next PATCH gets.
    let stored = record(3);
    let patchReply = () => Response.json({ record: stored, warnings: [] });
    const patches: SentPatch[] = [];
    globalThis.fetch = async (input, init) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (init?.method === "PATCH") {
        patches.push({ path, body: String(init.body) });
        return patchReply();
      }
      if (path === "/api/collections/c1/records") {
        return Response.json({ total: 1, records: [stored], columns: collection.columns });
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
    const { RecordsPanel } = await import("./RecordsPanel");

    // A finite gcTime leaves a timer after the panel unmounts that keeps the test running.
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { gcTime: Infinity },
      },
    });
    queries = client;
    const router = createRouter({
      routeTree: createRootRoute({ component: () => createElement(RecordsPanel, { collection }) }),
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
      for (let tick = 0; tick < 20 && !shown(); tick++) await settle(() => undefined);
      assert.ok(shown(), what);
    };
    const button = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) =>
          candidate.getAttribute("aria-label") === label || candidate.textContent === label,
      );
    const pencil = (name: string) => button(`Edit ${name} of record #1`);
    const popover = () =>
      document.querySelector<HTMLElement>(
        '[data-slot="popover-content"], [data-radix-popper-content-wrapper]',
      );
    const dialogOpen = () => document.querySelector('[role="dialog"]') !== null;
    const scoreCell = () => container.querySelector("tbody tr")?.children[1]?.textContent ?? "";
    const openEditor = async (name: string) => {
      const trigger = pencil(name);
      assert.ok(trigger, `the pencil of ${name}`);
      await settle(() => trigger.click());
      const content = popover();
      assert.ok(content, `the editor of ${name}`);
      return content;
    };
    const type = (into: HTMLElement, text: string) =>
      settle(() => {
        const input = into.querySelector("input");
        assert.ok(input, "the field's input");
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
          input,
          text,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const press = (label: string) =>
      settle(() => {
        const target = button(label);
        assert.ok(target, `the ${label} button`);
        target.click();
      });

    await settle(async () => {
      await router.load();
      mounted.render(
        createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
      );
    });
    await until(() => /3/.test(scoreCell()), "the record's score");
    assert.equal(pencil("id"), undefined, "id has no pencil");
    assert.equal(pencil("updated_at"), undefined, "updated_at has no pencil");

    // Cancel closes the editor and sends nothing.
    await type(await openEditor("score"), "5");
    await press("Cancel");
    assert.equal(popover(), null);
    assert.deepEqual(patches, []);
    assert.match(scoreCell(), /3/);

    // Saving the value as loaded closes the editor and sends nothing.
    await openEditor("score");
    await press("Save changes");
    assert.equal(popover(), null);
    assert.deepEqual(patches, []);

    // A value the column refuses is named in the editor and not sent.
    let editor = await openEditor("score");
    await type(editor, "");
    await press("Save changes");
    assert.match(popover()?.textContent ?? "", /Required\./);
    await press("Cancel");
    editor = await openEditor("tags");
    await type(editor, "green");
    await press("Save changes");
    assert.match(popover()?.textContent ?? "", /Only red, blue\./);
    await press("Cancel");
    assert.deepEqual(patches, []);

    // A refused save keeps the editor open with the server's reason.
    patchReply = () => Response.json({ detail: "The record changed meanwhile." }, { status: 409 });
    await type(await openEditor("score"), "6");
    await press("Save changes");
    assert.match(popover()?.textContent ?? "", /Couldn't save the record/);
    assert.match(popover()?.textContent ?? "", /The record changed meanwhile\./);
    assert.equal(patches.length, 1);
    await press("Cancel");

    // A valid change sends only that column, closes the editor, and the grid shows the saved value.
    patchReply = () => {
      stored = record(7);
      return Response.json({ record: stored, warnings: [] });
    };
    await type(await openEditor("score"), "7");
    await press("Save changes");
    assert.equal(popover(), null);
    assert.deepEqual(patches[1], {
      path: "/api/collections/c1/records/1",
      body: JSON.stringify({ body: { score: 7 } }),
    });
    assert.match(scoreCell(), /7/);

    // None of it opened the record; a click on the row itself does.
    assert.equal(dialogOpen(), false, "editing in place never opens the record");
    const row = container.querySelector<HTMLElement>("tbody tr");
    assert.ok(row);
    await settle(() => row.click());
    assert.equal(dialogOpen(), true);
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
