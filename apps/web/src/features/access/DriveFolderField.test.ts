import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";
import type { AccessOwner, McpServerAccess } from "../../api/types/access";
import type { Identity } from "../../api/identity";

const SAVED = "1ReportsFolderId_abc/def";
const CURRENT = "1InvoicesCurrent_abcdefgh";
const ARCHIVED = "1InvoicesArchived_abcdefg";
const ORG: AccessOwner = { scope: "org", id: "o1" };
const GUILD: AccessOwner = { scope: "guild", id: "g1" };

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
    name: "Home",
    slug: "home",
    role: "owner",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  },
  orgs: [],
};

/** The organisation's Drive login with SAVED as its folder; `owned` when the organisation is the scope being edited. */
function driveServer(owned: boolean): McpServerAccess {
  return {
    id: "mcp_drive",
    slug: "drive",
    name: "Google Drive",
    auth: "oauth",
    auth_fields: [],
    settings_schema: {
      type: "object",
      properties: { folder_id: { type: "string", title: "Folder", "x-lookup": true } },
      required: ["folder_id"],
    },
    settings: { folder_id: SAVED },
    needs_settings: false,
    source: "core",
    verified: true,
    experimental: false,
    publisher: "guilds",
    logo_url: null,
    description: "",
    oauth_strategy: "configured",
    oauth_setup_state: "configured",
    catalog_enabled: true,
    org_owned: false,
    enabled: true,
    source_scope: "org",
    overlay: owned ? { enabled: true, connection_id: "conn_drive" } : null,
    connection_id: "conn_drive",
    status: "connected",
    account_hint: "Reports",
    connection_owner_scope: "org",
    tools: [],
  };
}

/** The synthetic Drive folders the login's lookup answers with, by query. */
const lookups: Record<string, { value: string; label: string; detail: string }[]> = {
  [SAVED]: [{ value: SAVED, label: "Reports", detail: "My Drive / Projects / Reports" }],
  Invoices: [
    { value: CURRENT, label: "Invoices", detail: "My Drive / Clients / Invoices" },
    { value: ARCHIVED, label: "Invoices", detail: "My Drive / Clients / Archive / Invoices" },
  ],
};

type Request = { method: string; path: string; body: string };

/**
 * Renders the Drive card for `owner`, answering the login's lookup from `lookups` (or refusing it
 * when `lookupFails`), and the settings save with each of `saveStatuses` in turn. Runs `check`
 * with the page's helpers and every request the page sent.
 */
async function withDriveCard(
  server: McpServerAccess,
  owner: AccessOwner,
  lookupFails: boolean,
  saveStatuses: number[],
  check: (page: {
    text: () => string;
    button: (label: string) => HTMLButtonElement | undefined;
    press: (label: string) => Promise<void>;
    type: (text: string) => Promise<void>;
    until: (shown: () => boolean, what: string) => Promise<void>;
    requests: Request[];
    toastTitles: () => string[];
  }) => Promise<void>,
) {
  const window = new Window({ url: "http://localhost/" });
  const globals = {
    window,
    self: window,
    document: window.document,
    scrollTo: window.scrollTo.bind(window),
    // The dialog measures, observes, focuses and dispatches its own events through these.
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
  const requests: Request[] = [];
  const statuses = [...saveStatuses];
  let unmount: (() => Promise<void>) | null = null;
  let clearQueries: (() => void) | null = null;
  try {
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      requests.push({ method, path: url.pathname, body: String(init?.body ?? "") });
      if (url.pathname === "/api/mcp/connections/conn_drive/lookup") {
        if (lookupFails) {
          return Response.json({ detail: "Drive folder lookup failed: backend error" }, { status: 422 });
        }
        return Response.json({ options: lookups[url.searchParams.get("q") ?? ""] ?? [] });
      }
      if (url.pathname === "/api/mcp/connections/conn_drive/settings" && method === "PUT") {
        const status = statuses.shift() ?? 200;
        return status === 200
          ? Response.json({ id: "conn_drive", status: "connected" })
          : Response.json({ detail: "picked folder is not available to this login" }, { status });
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
    const { IdentityContext } = await import("../../app/identity");
    const { ServerCard } = await import("./ServerCard");

    // A finite gcTime leaves a timer after the card unmounts that keeps the test running.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } },
    });
    clearQueries = () => client.clear();
    const noop = () => undefined;
    const router = createRouter({
      routeTree: createRootRoute({
        component: () =>
          createElement(ServerCard, {
            server,
            owner,
            busy: false,
            onServerEnabled: noop,
            onToolEnabled: noop,
            onBulk: noop,
            onConnect: noop,
            onDisconnect: noop,
          }),
      }),
      history: createMemoryHistory(),
    });
    const mounted = createRoot(document.body.appendChild(document.createElement("div")));
    unmount = () => act(async () => mounted.unmount());
    const settle = (change: () => unknown) =>
      act(async () => {
        await change();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    await settle(async () => {
      await router.load();
      mounted.render(
        createElement(
          IdentityContext.Provider,
          { value: identity },
          createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
        ),
      );
    });
    const button = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) =>
          candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
      );
    await check({
      text: () => document.body.textContent ?? "",
      button,
      press: (label) =>
        settle(() => {
          const target = button(label);
          assert.ok(target, `the ${label} button`);
          target.click();
        }),
      type: (text) =>
        settle(() => {
          const input = document.querySelector<HTMLInputElement>('input[aria-label="Search folders"]');
          assert.ok(input, "the folder search");
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(input, text);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }),
      // A lookup answers after the search's delay and a few ticks; the page is read once it shows what it waits for.
      until: async (shown, what) => {
        for (let tick = 0; tick < 60 && !shown(); tick++) {
          await settle(() => new Promise((resolve) => setTimeout(resolve, 20)));
        }
        assert.ok(shown(), what);
      },
      requests,
      toastTitles: () => getToasts().map((record) => String(record.title)),
    });
  } finally {
    await unmount?.();
    clearQueries?.();
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    for (const [name, descriptor] of nodeGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    Reflect.deleteProperty(globalThis, "React");
    await window.happyDOM.close();
  }
}

test("the saved Drive folder shows its path and link on load; removing it clears only the unsaved pick, and Save waits for a replacement", async () => {
  await withDriveCard(driveServer(true), ORG, false, [422, 200], async (page) => {
    await page.until(() => page.text().includes("My Drive / Projects / Reports"), "the saved folder's path");
    assert.match(page.text(), /Reports/);
    const link = document.querySelector<HTMLAnchorElement>('a[href^="https://drive.google.com/"]');
    assert.equal(link?.href, `https://drive.google.com/drive/folders/${encodeURIComponent(SAVED)}`);
    assert.equal(link?.rel, "noopener noreferrer");
    const remove = page.button("Remove folder Reports");
    assert.ok(remove, "the remove button");
    assert.equal(link?.contains(remove), false, "the remove button is apart from the link");
    assert.equal(page.button("Save settings")?.disabled, true, "nothing to save yet");

    await page.press("Remove folder Reports");
    const dialog = () => document.querySelector('[role="alertdialog"]');
    assert.match(dialog()?.textContent ?? "", /Remove Reports\?/);
    assert.match(dialog()?.textContent ?? "", /removes Reports from these unsaved settings only/);
    assert.match(dialog()?.textContent ?? "", /Nothing in Google Drive is deleted or trashed/);
    assert.match(dialog()?.textContent ?? "", /the Google login stays connected/);
    assert.equal(document.activeElement?.textContent, "Cancel", "focus starts on Cancel");

    await page.press("Cancel");
    assert.equal(dialog(), null);
    assert.match(page.text(), /My Drive \/ Projects \/ Reports/);
    assert.equal(page.button("Save settings")?.disabled, true, "cancel leaves nothing to save");

    await page.press("Remove folder Reports");
    await page.press("Remove folder");
    assert.match(page.text(), /No folder picked\. Pick a folder, then save\./);
    assert.ok(page.button("Discard"), "the removal is an unsaved change");
    assert.equal(page.button("Save settings")?.disabled, true, "Save waits for a replacement");
    await page.until(
      () => document.activeElement?.getAttribute("aria-label") === "Search folders",
      "focus moves to the folder search",
    );

    await page.press("Discard");
    await page.until(() => page.text().includes("My Drive / Projects / Reports"), "discard brings the saved folder back");
    await page.press("Remove folder Reports");
    await page.press("Remove folder");

    await page.type("Invoices");
    await page.until(() => page.text().includes("My Drive / Clients / Archive / Invoices"), "the found folders' paths");
    assert.match(page.text(), /My Drive \/ Clients \/ Invoices/);
    await page.press("InvoicesMy Drive / Clients / Archive / Invoices");
    assert.ok(page.button("Remove folder Invoices"), "the picked folder shows");
    assert.match(page.text(), /My Drive \/ Clients \/ Archive \/ Invoices/);
    assert.doesNotMatch(page.text(), /My Drive \/ Clients \/ Invoices/, "the results close on a pick");
    assert.equal(page.button("Save settings")?.disabled, false);

    await page.press("Save settings");
    await page.until(() => page.toastTitles().includes("Couldn't save the settings"), "the refused save says so");
    assert.ok(page.button("Remove folder Invoices"), "a refused save keeps the pick to retry");
    await page.press("Save settings");
    await page.until(() => page.toastTitles().includes("Google Drive settings saved"), "the save goes through");

    const saves = page.requests.filter((request) => request.method === "PUT");
    assert.deepEqual(
      saves.map((request) => JSON.parse(request.body)),
      [{ settings: { folder_id: ARCHIVED } }, { settings: { folder_id: ARCHIVED } }],
    );
    assert.deepEqual(
      page.requests.filter((request) => request.method !== "GET" && request.method !== "PUT"),
      [],
      "nothing is deleted",
    );
  });
});

test("an inherited Drive login's folder shows its path and link, with no removal and no search", async () => {
  await withDriveCard(driveServer(false), GUILD, false, [], async (page) => {
    await page.until(() => page.text().includes("My Drive / Projects / Reports"), "the inherited folder's path");
    assert.ok(document.querySelector('a[href^="https://drive.google.com/drive/folders/"]'));
    assert.equal(page.button("Remove folder Reports"), undefined);
    assert.equal(document.querySelector('input[aria-label="Search folders"]'), null);
    assert.equal(page.button("Save settings"), undefined);
  });
});

test("a saved folder the lookup cannot read still shows its id and link, says its path is unavailable, and keeps the setting", async () => {
  await withDriveCard(driveServer(true), ORG, true, [], async (page) => {
    await page.until(() => page.text().includes("Drive folder lookup failed: backend error"), "the lookup's error");
    assert.match(page.text(), /Full path unavailable/);
    assert.match(page.text(), new RegExp(SAVED));
    assert.equal(
      document.querySelector<HTMLAnchorElement>('a[href^="https://drive.google.com/"]')?.href,
      `https://drive.google.com/drive/folders/${encodeURIComponent(SAVED)}`,
    );
    assert.ok(page.button(`Remove folder ${SAVED}`));
    assert.equal(page.button("Save settings")?.disabled, true);
    assert.deepEqual(page.requests.filter((request) => request.method !== "GET"), []);
  });
});
