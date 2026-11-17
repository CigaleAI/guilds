import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueryClient } from "@tanstack/react-query";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import type { AccessEntry, AccessList, AccessRow } from "../../api/types/access";
import type { Collection } from "../../api/types/tables";

function table(id: string, name: string): Collection {
  return {
    id,
    name,
    purpose: `${name} kept`,
    columns: [],
    display_path: `org/o1/collections/${name}`,
    scope: "org",
    guild: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    count: 0,
  };
}

const org: AccessEntry = { type: "org", id: "o1", name: "acme", mode: "read", guild_id: null, guild_name: null };
const ops: AccessEntry = { type: "guild", id: "g_ops", name: "ops", mode: "write", guild_id: "g_ops", guild_name: "ops" };
const scout: AccessEntry = { type: "agent", id: "a1", name: "scout", mode: "none", guild_id: "g_ops", guild_name: "ops" };

const tables = [table("t1", "leads"), table("t2", "orders"), table("t3", "drafts"), table("t4", "slow"), table("t5", "vault"), table("t6", "sealed")];

test("the Tables list by access shows each table under the grants it reads, an unknown list apart from an empty one, keeps a slow or failed read apart with a retry, opens any occurrence, and regroups after an access edit", async () => {
  const window = new Window({ url: "http://localhost/" });
  const globals = {
    window,
    self: window,
    document: window.document,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
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
    // The server: each table's list, the table whose rows of a guild the viewer cannot see are
    // left out, the table whose read
    // fails until it is fixed, a gate that holds the slow table's read, and every read made.
    const lists: Record<string, AccessEntry[]> = {
      t1: [org, ops],
      t2: [],
      t3: [scout],
      t4: [org],
      t5: [{ ...scout, mode: "write" }],
      t6: [],
    };
    const filtered = "t6";
    let failing: string | null = "t5";
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const reads: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      const id = /^\/api\/collections\/(\w+)\/access$/.exec(url.pathname)?.[1];
      if (!id || !(id in lists)) return Response.json({ detail: "Not found" }, { status: 404 });
      if (init?.method === "PUT") {
        const { subjects } = JSON.parse(String(init.body)) as { subjects: AccessRow[] };
        lists[id] = subjects.map((row) => [org, ops, scout].find((entry) => entry.id === row.id) ?? org);
      } else {
        reads.push(id);
        if (id === failing) return Response.json({ detail: "Database unavailable" }, { status: 503 });
        if (id === "t4") await slow;
      }
      const list: AccessList = { subjects: lists[id] ?? [], complete: id !== filtered };
      return Response.json(list);
    };

    const React = await import("react");
    const { act, createElement } = React;
    Object.defineProperty(globalThis, "React", { value: React, configurable: true });
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { useSetItemAccess } = await import("../../api/queries/access");
    const { TablesByAccess } = await import("./TablesByAccess");
    const opened: string[] = [];
    // Beside the list, the Access tab's save for orders, as the access list panel calls it.
    const View = () => {
      const share = useSetItemAccess({ kind: "collection", id: "t2" });
      return createElement(
        "div",
        null,
        createElement("button", { type: "button", onClick: () => share.mutate([{ type: "guild", id: "g_ops", mode: "read" }]) }, "Share orders"),
        createElement(TablesByAccess, { tables, selectedId: "t1", onOpen: (id: string) => opened.push(id) }),
      );
    };

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } },
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
    // The table buttons of one group, or of the whole list, and the name each shows.
    const items = (within: Element = container) => [...within.querySelectorAll<HTMLButtonElement>("button.group\\/db")];
    const nameOf = (item: Element) => item.querySelector(".font-semibold")?.textContent;
    // Each group's label and the table names under it, as the list shows them.
    const groups = () =>
      [...container.querySelectorAll("div.flex.flex-col.gap-1")].map((group) => [
        group.querySelector(".type-label")?.textContent,
        items(group).map(nameOf),
      ]);
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

    await settle(() =>
      mounted.render(createElement(QueryClientProvider, { client }, createElement(View))),
    );
    await until(() => groups().some(([label]) => label === "Couldn't read access"), "the failed read");

    // The slow read is still running and listed apart; the failed one has a retry.
    assert.deepEqual(groups(), [
      ["Organisation", ["leads"]],
      ["Guild · ops", ["leads"]],
      ["No access assigned", ["orders"]],
      ["No granting access", ["drafts"]],
      ["Access not fully known", ["sealed"]],
      ["Reading access", ["slow"]],
      ["Couldn't read access", ["vault"]],
    ]);
    assert.deepEqual([...reads].sort(), ["t1", "t2", "t3", "t4", "t5", "t6"], "each table is read once");

    // Every occurrence of the selected table is marked, and any occurrence opens it.
    const marked = items().filter((item) => item.getAttribute("aria-current") === "true");
    assert.deepEqual(marked.map(nameOf), ["leads", "leads"]);
    await settle(() => marked[1]?.click());
    // A failed read stops no table from opening.
    await settle(() => items().find((item) => nameOf(item) === "vault")?.click());
    assert.deepEqual(opened, ["t1", "t5"]);

    // The slow read lands, and a retry reads only the failed table again.
    await settle(() => release());
    await until(() => !groups().some(([label]) => label === "Reading access"), "the slow read");
    failing = null;
    await press("Retry");
    await until(() => groups().some(([label]) => label === "Individual agents"), "the retried read");
    assert.deepEqual(groups(), [
      ["Organisation", ["leads", "slow"]],
      ["Guild · ops", ["leads"]],
      ["Individual agents", ["vault"]],
      ["No access assigned", ["orders"]],
      ["No granting access", ["drafts"]],
      ["Access not fully known", ["sealed"]],
    ]);
    assert.deepEqual([...reads].sort(), ["t1", "t2", "t3", "t4", "t5", "t5", "t6"]);

    // Sharing orders with ops moves it out of No access assigned without reloading the page.
    await press("Share orders");
    await until(
      () => groups().some(([label, names]) => label === "Guild · ops" && names?.includes("orders")),
      "orders under ops",
    );
    assert.deepEqual(groups(), [
      ["Organisation", ["leads", "slow"]],
      ["Guild · ops", ["leads", "orders"]],
      ["Individual agents", ["vault"]],
      ["No granting access", ["drafts"]],
      ["Access not fully known", ["sealed"]],
    ]);
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
