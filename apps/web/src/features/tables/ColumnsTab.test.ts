import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueryClient } from "@tanstack/react-query";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import type { Collection, Column } from "../../api/types/tables";

function column(name: string, type: Column["type"], extra: Partial<Column> = {}): Column {
  return {
    name,
    type,
    description: `${name} of the lead`,
    required: false,
    unique: false,
    ...extra,
  };
}

const saved: Collection = {
  id: "c1",
  name: "leads",
  purpose: "",
  columns: [column("status", "text"), column("score", "number")],
  display_path: "org/o1/collections/leads",
  scope: "org",
  guild: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  count: 3,
};

test("Save columns says below it why it is off: no change, each column's error by position and name, or a save running; the reasons follow edits, fixes, discard, success and failure, a held save sends once, and a reshape still asks first", async () => {
  const window = new Window({ url: "http://localhost/" });
  const globals = {
    window,
    self: window,
    document: window.document,
    scrollTo: window.scrollTo.bind(window),
    // The checkboxes, the select and the dialog measure, observe, focus and dispatch their own events through these.
    getComputedStyle: window.getComputedStyle.bind(window),
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLFormElement: window.HTMLFormElement,
    DocumentFragment: window.DocumentFragment,
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
  let root: Root | null = null;
  let queries: QueryClient | null = null;
  try {
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
    // The server: the table as last saved, every PATCH it got, a gate that holds each PATCH while
    // set, and whether it refuses the next one.
    let stored = saved;
    const patches: string[] = [];
    let gets = 0;
    let gate: Promise<void> | null = null;
    let refuse = false;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname !== "/api/collections/c1") {
        return Response.json({ detail: "Not found" }, { status: 404 });
      }
      if (init?.method === "PATCH") {
        patches.push(String(init.body));
        if (gate) await gate;
        if (refuse) return Response.json({ detail: "Values repeat" }, { status: 409 });
        const body = JSON.parse(String(init.body)) as { columns: Column[] };
        stored = { ...stored, columns: body.columns };
        return Response.json(stored);
      }
      gets += 1;
      return Response.json(stored);
    };

    const React = await import("react");
    const { act, createElement } = React;
    // The design system's components are compiled here, outside Vite, with the classic JSX
    // transform, so they reach React as a global.
    Object.defineProperty(globalThis, "React", { value: React, configurable: true });
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { getToasts } = await import("@guildsrun/ui");
    const { useDatabase } = await import("../../api/queries/tables");
    const { ColumnsTab } = await import("./TablesPage");
    const Tab = () => {
      const table = useDatabase("c1");
      return table.data ? createElement(ColumnsTab, { collection: table.data }) : null;
    };

    // A finite gcTime leaves a timer after the tab unmounts that keeps the test running.
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { gcTime: Infinity },
      },
    });
    queries = client;
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
    const button = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === label,
      );
    const press = (label: string) =>
      settle(() => {
        const target = button(label);
        assert.ok(target, `the ${label} button`);
        target.click();
      });
    const save = () => {
      const target = button("Save columns");
      assert.ok(target, "the Save columns button");
      return target;
    };
    // The reasons Save is off, as the element Save is described by shows them; none when it is on.
    const reasons = () => {
      const id = save().getAttribute("aria-describedby");
      if (!id) return [];
      const list = document.getElementById(id);
      assert.ok(list, "the reasons Save is described by");
      return [...list.querySelectorAll("li")].map((item) => item.textContent);
    };
    const fields = (label: string, tag: "input" | "textarea") =>
      [...container.querySelectorAll("label")]
        .filter((candidate) => candidate.textContent?.trim() === label)
        .map((candidate) => document.getElementById(candidate.htmlFor))
        .filter((field) => field?.tagName.toLowerCase() === tag);
    const type = (label: string, tag: "input" | "textarea", index: number, text: string) =>
      settle(() => {
        const field = fields(label, tag)[index];
        assert.ok(field, `${label} ${index + 1}`);
        const prototype =
          tag === "input"
            ? window.HTMLInputElement.prototype
            : window.HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, text);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const name = (index: number, text: string) => type("Name", "input", index, text);
    const describe = (index: number, text: string) => type("Description", "textarea", index, text);
    const toastTitles = () => getToasts().map((item) => item.title);
    const noChanges = ["No column changes to save."];

    await settle(() =>
      mounted.render(createElement(QueryClientProvider, { client }, createElement(Tab))),
    );
    await until(() => button("Save columns") !== undefined, "the columns");

    // As loaded, nothing is to save, and Save says so below it.
    assert.equal(save().disabled, true);
    assert.deepEqual(reasons(), noChanges);
    const reasonsList = document.getElementById(save().getAttribute("aria-describedby") ?? "");
    assert.equal(reasonsList?.getAttribute("aria-live"), "polite");
    assert.equal(
      save()
        .closest(".sticky")
        ?.contains(reasonsList ?? null),
      true,
    );

    // A description edit turns Save on with no reason; editing it back turns it off again.
    await describe(0, "Where the lead stands");
    assert.equal(save().disabled, false);
    assert.equal(save().hasAttribute("aria-describedby"), false);
    assert.deepEqual(reasons(), []);
    await describe(0, "status of the lead");
    assert.equal(save().disabled, true);
    assert.deepEqual(reasons(), noChanges);

    // A cleared description is the column's reason, by position and name.
    await describe(0, "");
    assert.equal(save().disabled, true);
    assert.deepEqual(reasons(), ["Column 1 (status): Describe the column for the agents."]);
    await describe(0, "status of the lead");

    // Two unnamed columns are both reasons; fixing one leaves the other's.
    await press("Add column");
    await press("Add column");
    assert.deepEqual(reasons(), [
      "Column 3 (unnamed): Lowercase letters, digits and _, starting with a letter.",
      "Column 4 (unnamed): Lowercase letters, digits and _, starting with a letter.",
    ]);
    await name(2, "notes");
    assert.deepEqual(reasons(), [
      "Column 3 (notes): Describe the column for the agents.",
      "Column 4 (unnamed): Lowercase letters, digits and _, starting with a letter.",
    ]);
    await describe(2, "What was said");
    assert.deepEqual(reasons(), [
      "Column 4 (unnamed): Lowercase letters, digits and _, starting with a letter.",
    ]);
    await name(3, "id");
    assert.deepEqual(reasons(), ['Column 4 (id): "id" is reserved.']);
    await name(3, "notes");
    assert.deepEqual(reasons(), ["Column 4 (notes): Another column has this name."]);
    await name(3, "owner");
    await describe(3, "Who follows the lead");
    assert.equal(save().disabled, false);
    assert.deepEqual(reasons(), []);

    // Discard returns to nothing to save; no reason sent a request.
    await press("Discard");
    assert.equal(save().disabled, true);
    assert.deepEqual(reasons(), noChanges);
    assert.equal(patches.length, 0);
    assert.equal(gets, 1);

    // A held save says it is saving, alone, and is sent once however often Save is pressed.
    await press("Add column");
    await name(2, "notes");
    await describe(2, "What was said");
    let release: () => void = () => undefined;
    gate = new Promise((resolve) => (release = resolve));
    await press("Save columns");
    assert.equal(save().disabled, true);
    assert.equal(button("Discard")?.disabled, true);
    assert.deepEqual(reasons(), ["Saving columns…"]);
    await press("Save columns");
    assert.equal(patches.length, 1);
    assert.deepEqual(
      (JSON.parse(patches[0] ?? "") as { columns: Column[] }).columns.map((item) => item.name),
      ["status", "score", "notes"],
    );
    await settle(() => release());
    gate = null;
    await until(() => toastTitles().includes("Columns saved"), "the saved toast");
    await until(() => fields("Name", "input").length === 3, "the saved table read again");
    assert.equal(gets, 2);
    assert.equal(save().disabled, true);
    assert.deepEqual(reasons(), noChanges);

    // A refused save keeps the draft and turns Save back on with no reason.
    refuse = true;
    await describe(2, "What the lead said");
    await press("Save columns");
    await until(() => toastTitles().includes("Couldn't save the columns"), "the error toast");
    assert.equal(patches.length, 2);
    assert.equal(save().disabled, false);
    assert.deepEqual(reasons(), []);
    assert.match(container.textContent ?? "", /1 unsaved changes/);
    refuse = false;
    await press("Discard");

    // A rename on a table with records still asks first, and sends nothing until applied.
    await name(0, "state");
    assert.deepEqual(reasons(), []);
    await press("Save columns");
    await until(
      () => document.querySelector('[role="alertdialog"], [role="dialog"]') !== null,
      "the reshape confirmation",
    );
    assert.match(document.body.textContent ?? "", /Rename status to state/);
    assert.equal(patches.length, 2);
    await press("Cancel");
    assert.equal(patches.length, 2);
    await press("Discard");
    assert.deepEqual(reasons(), noChanges);
  } finally {
    if (root) {
      const leftover: Root = root;
      const { act } = await import("react");
      await act(async () => leftover.unmount());
    }
    queries?.clear();
    Reflect.deleteProperty(globalThis, "React");
    for (const [name, descriptor] of nodeGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await window.happyDOM.close();
  }
});
