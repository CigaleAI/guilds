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
    column("active", "boolean"),
    column("tags", "array", { values: ["red", "blue"] }),
    column("email", "text", { unique: true }),
  ],
  display_path: "org/o1/collections/leads",
  scope: "org",
  guild: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  count: 3,
};

function record(id: number): CollectionRecord {
  return {
    id,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    updated_by: null,
    version: 1,
    display_path: "",
    score: id,
    active: true,
    tags: ["red"],
  };
}

/** A PATCH the panel sent: its path and its JSON body. */
type SentPatch = { path: string; body: string };

test("selection mode selects the page's records apart from opening them, a new view clears the selection, and a bulk edit names its records, sends one typed PATCH per record, in turn, keeps the refused ones to retry alone, refreshes either way, refuses one value for several records of a unique column, and names a chosen column the table lost", async () => {
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
  const nodeEnv = process.env.NODE_ENV;
  let root: Root | null = null;
  let queries: QueryClient | null = null;
  try {
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
    // The server: three records on every page of a listing of a hundred, a search that finds the
    // one whose id it names, the ids whose PATCH
    // it refuses, every PATCH it got, and how many it answered at once at most.
    const stored = [record(1), record(2), record(3)];
    const refused = new Map<number, string>();
    const patches: SentPatch[] = [];
    let inFlight = 0;
    let mostInFlight = 0;
    let listFetches = 0;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (init?.method === "PATCH") {
        patches.push({ path: url.pathname, body: String(init.body) });
        inFlight += 1;
        mostInFlight = Math.max(mostInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 0));
        inFlight -= 1;
        const recordId = Number(url.pathname.split("/").at(-1));
        const reason = refused.get(recordId);
        if (reason) return Response.json({ detail: reason }, { status: 409 });
        return Response.json({ record: record(recordId), warnings: [] });
      }
      if (url.pathname === "/api/collections/c1/records") {
        listFetches += 1;
        const query = url.searchParams.get("query");
        const records = query ? stored.filter((item) => String(item.id) === query) : stored;
        // The listing claims more records than it sends, and sends the same ones for every page.
        const total = query ? records.length : 100;
        return Response.json({ total, records, columns: collection.columns });
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
    const { RecordsPanel } = await import("./RecordsPanel");
    // The table as the page holds it, swapped below for one that lost a column.
    let showCollection: (next: Collection) => void = () => undefined;
    const Panel = () => {
      const [shown, setShown] = React.useState(collection);
      React.useEffect(() => {
        showCollection = setShown;
      }, []);
      return createElement(RecordsPanel, { collection: shown });
    };

    // A finite gcTime leaves a timer after the panel unmounts that keeps the test running.
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { gcTime: Infinity },
      },
    });
    queries = client;
    const router = createRouter({
      routeTree: createRootRoute({ component: Panel }),
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
    const rows = () => container.querySelectorAll("tbody tr").length;
    const clickRow = () => settle(() => container.querySelector<HTMLElement>("tbody tr")?.click());
    const idFilter = () => {
      const label = [...container.querySelectorAll("label")].find(
        (candidate) => candidate.textContent?.trim() === "id",
      );
      const input = label ? document.getElementById(label.htmlFor) : null;
      assert.ok(input instanceof window.HTMLInputElement, "the id filter");
      return input as unknown as HTMLInputElement;
    };
    const toolbar = () =>
      [...container.querySelectorAll("span")].find((span) =>
        / selected$/.test(span.textContent ?? ""),
      )?.textContent ?? null;
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
    const toastTitles = () => getToasts().map((item) => item.title);
    const setInput = (input: HTMLInputElement, text: string) =>
      settle(() => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
          input,
          text,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const typeValue = (text: string) => {
      const input = dialog()?.querySelector<HTMLInputElement>("input");
      assert.ok(input, "the value's input");
      return setInput(input, text);
    };
    const typeText = (text: string) =>
      settle(() => {
        const area = dialog()?.querySelector("textarea");
        assert.ok(area, "the text's field");
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.call(
          area,
          text,
        );
        area.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const search = async (text: string) => {
      const input = container.querySelector<HTMLInputElement>('input[aria-label="Search records"]');
      assert.ok(input, "the search field");
      await setInput(input, text);
      await settle(() =>
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
      );
    };
    const choose = async (label: string, option: string) => {
      const trigger = [
        ...(dialog()?.querySelectorAll<HTMLElement>('[role="combobox"]') ?? []),
      ].find(
        (candidate) =>
          candidate.id &&
          document.querySelector(`label[for="${candidate.id}"]`)?.textContent?.startsWith(label),
      );
      assert.ok(trigger, `the ${label} select`);
      await settle(() => trigger.click());
      const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (candidate) => candidate.textContent?.trim() === option,
      );
      assert.ok(item, `the ${option} option`);
      await settle(() => item.click());
    };

    await settle(async () => {
      await router.load();
      mounted.render(
        createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
      );
    });
    await until(() => rows() === 3, "the records");
    assert.equal(toolbar(), null, "nothing is selected at first");

    // Outside selection mode a row has no box and opens its record, and its cells have pencils.
    assert.equal(button("Select record #1"), undefined);
    assert.ok(button("Edit score of record #1"), "a cell's pencil");
    await clickRow();
    assert.match(dialog()?.textContent ?? "", /Record #1/);
    await press("Cancel");
    assert.equal(dialog(), null);

    // In selection mode a box selects without opening the record, a row opens nothing and has no
    // pencils, and the header box selects the page, then none.
    await press("Select records");
    assert.equal(button("Edit score of record #1"), undefined, "no pencil in selection mode");
    await press("Select record #1");
    await press("Select record #3");
    assert.equal(toolbar(), "2 selected");
    assert.equal(dialog(), null, "selecting never opens the record");
    await clickRow();
    assert.equal(dialog(), null, "a row opens nothing in selection mode");
    await press("Select this page");
    assert.equal(toolbar(), "3 selected");
    await press("Select this page");
    assert.equal(toolbar(), null);

    // Leaving the mode takes the boxes away and clears the selection.
    await press("Select record #1");
    await press("Exit selection mode");
    assert.equal(button("Select record #1"), undefined);
    await press("Select records");
    assert.equal(toolbar(), null);

    // Fetching the same view again keeps the selection; each change of the page, the sort, the
    // filters or the search clears it, even when the view shows the same records.
    const fetchesBeforeRefresh = listFetches;
    await press("Select record #1");
    await press("Refresh the records");
    await until(() => listFetches > fetchesBeforeRefresh, "the records fetched again");
    assert.equal(toolbar(), "1 selected");
    await press("Next");
    assert.equal(toolbar(), null, "a new page");
    await press("Select record #1");
    await press("Previous");
    assert.equal(toolbar(), null, "the previous page");
    await press("Select record #1");
    await press("#");
    assert.equal(toolbar(), null, "a new sort");
    await press("Filters");
    await press("Select record #1");
    await setInput(idFilter(), "1");
    assert.equal(toolbar(), null, "a new filter");
    await press("Select record #1");
    await press("Clear filters");
    assert.equal(toolbar(), null, "the filters cleared");
    await press("Filters");
    await press("Select record #1");
    await search("1");
    await until(() => rows() === 1, "the search's hit");
    assert.equal(toolbar(), null, "a new search");
    await press("Select record #1");
    await search("");
    await until(() => rows() === 3, "the listing again");
    assert.equal(toolbar(), null, "the search cleared");

    // Cancel sends nothing; a value the column refuses is named and not sent.
    await press("Select record #1");
    await press("Select record #2");
    await press("Edit selected");
    assert.match(dialog()?.textContent ?? "", /Edit 2 records/);
    assert.match(dialog()?.textContent ?? "", /Records #1, #2/);
    await typeValue("5");
    await press("Cancel");
    assert.equal(dialog(), null);
    await press("Edit selected");
    await typeValue("");
    await press("Save changes");
    assert.match(dialog()?.textContent ?? "", /Required\./);
    await press("Cancel");
    assert.equal(patches.length, 0, "nothing is sent");

    // Save pressed twice sends the typed value once to each record, one at a time, then closes and
    // the selection stays.
    await press("Edit selected");
    await typeValue("7");
    await settle(() => {
      button("Save changes")?.click();
      button("Save changes")?.click();
    });
    await until(() => dialog() === null, "the dialog closes once every record is saved");
    assert.deepEqual(patches, [
      { path: "/api/collections/c1/records/1", body: JSON.stringify({ body: { score: 7 } }) },
      { path: "/api/collections/c1/records/2", body: JSON.stringify({ body: { score: 7 } }) },
    ]);
    assert.equal(mostInFlight, 1, "one request in flight at most");
    assert.equal(toastTitles().at(-1), "Saved score on 2 records");
    assert.equal(toolbar(), "2 selected");

    // Another column sends its own type: a boolean, and a list cleared to null.
    patches.length = 0;
    await press("Edit selected");
    await choose("Column", "active");
    await choose("active", "false");
    await press("Save changes");
    await until(() => dialog() === null, "the boolean is saved");
    await press("Edit selected");
    await choose("Column", "tags");
    await press("Save changes");
    await until(() => dialog() === null, "the list is cleared");
    assert.deepEqual(
      patches.map((patch) => patch.body),
      [
        JSON.stringify({ body: { active: false } }),
        JSON.stringify({ body: { active: false } }),
        JSON.stringify({ body: { tags: null } }),
        JSON.stringify({ body: { tags: null } }),
      ],
    );

    // A refused record is listed with the server's reason and the dialog stays open; the others are
    // saved, and the records are fetched again all the same.
    patches.length = 0;
    await press("Select this page");
    assert.equal(toolbar(), "3 selected");
    refused.set(2, "The record changed meanwhile.");
    const fetchesBefore = listFetches;
    await press("Edit selected");
    await typeValue("9");
    await press("Save changes");
    await until(
      () => /Couldn't save 1 record/.test(dialog()?.textContent ?? ""),
      "the refused record",
    );
    assert.match(dialog()?.textContent ?? "", /#2: The record changed meanwhile\./);
    assert.match(dialog()?.textContent ?? "", /Saved #1, #3/);
    assert.match(dialog()?.textContent ?? "", /Edit 1 record/);
    assert.match(dialog()?.textContent ?? "", /Records #2/);
    assert.deepEqual(
      patches.map((patch) => patch.path),
      [
        "/api/collections/c1/records/1",
        "/api/collections/c1/records/2",
        "/api/collections/c1/records/3",
      ],
    );
    assert.equal(toastTitles().at(-1), "Saved score on 2 records");
    await until(() => listFetches > fetchesBefore, "the records are fetched again after a refusal");

    // Retry sends to the refused record only, and closes once it is saved.
    refused.clear();
    await press("Retry failed");
    await until(() => dialog() === null, "the retry closes the dialog");
    assert.deepEqual(patches.slice(3), [
      { path: "/api/collections/c1/records/2", body: JSON.stringify({ body: { score: 9 } }) },
    ]);
    assert.equal(toastTitles().at(-1), "Saved score on 1 record");
    assert.equal(mostInFlight, 1);

    // One value for several records of a unique column is refused before anything is sent.
    patches.length = 0;
    await press("Edit selected");
    await choose("Column", "email");
    await typeText("a@b.c");
    await press("Save changes");
    assert.match(dialog()?.textContent ?? "", /Unique: one record at most can hold a value\./);
    await press("Cancel");
    assert.equal(patches.length, 0, "nothing is sent for a repeated unique value");

    // A chosen column the table loses is named, and saving stays off.
    await press("Edit selected");
    await choose("Column", "tags");
    await settle(() =>
      showCollection({
        ...collection,
        columns: collection.columns.filter((item) => item.name !== "tags"),
      }),
    );
    assert.match(dialog()?.textContent ?? "", /tags is no longer a column of this table/);
    assert.equal(button("Save changes")?.disabled, true);
    await press("Cancel");
    assert.equal(patches.length, 0);
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
