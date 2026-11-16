import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import type { Identity } from "../../api/identity";

const org = {
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  role: "owner",
} as const;

function identityIn(orgId: string): Identity {
  const orgs = [
    { ...org, id: "o1", name: "First", slug: "first" },
    { ...org, id: "o2", name: "Second", slug: "second" },
  ];
  return {
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
    org: orgs.find((candidate) => candidate.id === orgId) ?? orgs[0]!,
    orgs,
  };
}

test("Message chime is checked until the operator turns it off, and this browser keeps that in every organisation", async () => {
  const window = new Window({ url: "http://localhost/" });
  const globals = {
    window,
    self: window,
    document: window.document,
    localStorage: window.localStorage,
    scrollTo: window.scrollTo.bind(window),
    // The menu's panel measures, observes, focuses and dispatches its own events through these.
    getComputedStyle: window.getComputedStyle.bind(window),
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    FocusEvent: window.FocusEvent,
    KeyboardEvent: window.KeyboardEvent,
    PointerEvent: window.PointerEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const nodeGlobals = Object.keys(globals).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const nodeEnv = process.env.NODE_ENV;
  let root: Root | null = null;
  try {
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
    // The router renders for a browser under Node only in a test environment.
    process.env.NODE_ENV = "test";
    // React DOM and the router tell browser from server when they load.
    const React = await import("react");
    const { act, createElement } = React;
    // The design system's components are compiled here, outside Vite, with the classic JSX
    // transform, so they reach React as a global.
    Object.defineProperty(globalThis, "React", { value: React, configurable: true });
    const { createRoot } = await import("react-dom/client");
    const { RouterProvider, createMemoryHistory, createRootRoute, createRouter } =
      await import("@tanstack/react-router");
    const { IdentityContext } = await import("../../app/identity");
    const { AccountMenu } = await import("./AccountMenu");
    const { messageChimeMutedKey } = await import("./newMessages");

    const settle = (change: () => unknown) =>
      act(async () => {
        await change();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    const mountIn = async (orgId: string) => {
      const router = createRouter({
        routeTree: createRootRoute({ component: AccountMenu }),
        history: createMemoryHistory(),
      });
      const mounted = createRoot(document.body.appendChild(document.createElement("div")));
      root = mounted;
      await settle(async () => {
        await router.load();
        mounted.render(
          createElement(
            IdentityContext.Provider,
            { value: identityIn(orgId) },
            createElement(RouterProvider, { router }),
          ),
        );
      });
      return mounted;
    };
    const chimeItem = async () => {
      const trigger = document.querySelector('button[aria-label^="Account:"]');
      assert.ok(trigger, "the account menu's trigger");
      await settle(() =>
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
      );
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(
        (candidate) => candidate.textContent === "Message chime",
      );
      assert.ok(item, "the Message chime item");
      return item;
    };
    const glyph = (item: Element) => item.querySelector("svg")?.getAttribute("class") ?? "";

    let mounted = await mountIn("o1");
    let item = await chimeItem();
    assert.equal(item.getAttribute("aria-checked"), "true", "on until the operator chooses");
    assert.match(glyph(item), /lucide-check/);

    await settle(() => item.click());
    assert.equal(localStorage.getItem(messageChimeMutedKey), "true");
    item = await chimeItem();
    assert.equal(item.getAttribute("aria-checked"), "false");
    assert.match(glyph(item), /lucide-volume-x/);
    await settle(() => mounted.unmount());

    mounted = await mountIn("o2");
    item = await chimeItem();
    assert.equal(
      item.getAttribute("aria-checked"),
      "false",
      "the same choice in another organisation",
    );
    await settle(() => item.click());
    assert.equal(localStorage.getItem(messageChimeMutedKey), "false");
    item = await chimeItem();
    assert.equal(item.getAttribute("aria-checked"), "true");
    await settle(() => mounted.unmount());
    root = null;
  } finally {
    if (root) {
      const leftover: Root = root;
      const { act } = await import("react");
      await act(async () => leftover.unmount());
    }
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

test("Chime sound is Default until the operator chooses a file, and this browser keeps that in every organisation", async () => {
  const window = new Window({ url: "http://localhost/" });
  const globals = {
    window,
    self: window,
    document: window.document,
    localStorage: window.localStorage,
    scrollTo: window.scrollTo.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window),
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    FocusEvent: window.FocusEvent,
    KeyboardEvent: window.KeyboardEvent,
    PointerEvent: window.PointerEvent,
    File: window.File,
    FileReader: window.FileReader,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const nodeGlobals = Object.keys(globals).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const nodeEnv = process.env.NODE_ENV;
  let root: Root | null = null;
  try {
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
    process.env.NODE_ENV = "test";
    const React = await import("react");
    const { act, createElement } = React;
    Object.defineProperty(globalThis, "React", { value: React, configurable: true });
    const { createRoot } = await import("react-dom/client");
    const { RouterProvider, createMemoryHistory, createRootRoute, createRouter } =
      await import("@tanstack/react-router");
    const { IdentityContext } = await import("../../app/identity");
    const { AccountMenu } = await import("./AccountMenu");
    const { chimeSoundKey } = await import("./chime");

    const settle = (change: () => unknown) =>
      act(async () => {
        await change();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    const mountIn = async (orgId: string) => {
      const router = createRouter({
        routeTree: createRootRoute({ component: AccountMenu }),
        history: createMemoryHistory(),
      });
      const mounted = createRoot(document.body.appendChild(document.createElement("div")));
      root = mounted;
      await settle(async () => {
        await router.load();
        mounted.render(
          createElement(
            IdentityContext.Provider,
            { value: identityIn(orgId) },
            createElement(RouterProvider, { router }),
          ),
        );
      });
      return mounted;
    };
    const openMenu = async () => {
      const trigger = document.querySelector('button[aria-label^="Account:"]');
      assert.ok(trigger, "the account menu's trigger");
      await settle(() =>
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
      );
    };
    const itemNamed = (label: string) => {
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (candidate) => candidate.textContent === label,
      );
      assert.ok(item, label);
      return item;
    };
    const glyph = (item: Element) => item.querySelector("svg")?.getAttribute("class") ?? "";

    let mounted = await mountIn("o1");
    await openMenu();
    let def = itemNamed("Default");
    assert.match(glyph(def), /lucide-check/, "Default until the operator chooses");
    itemNamed("Choose a file…");

    localStorage.setItem(
      chimeSoundKey,
      JSON.stringify({ name: "bell.wav", dataUrl: "data:audio/wav;base64,AQID" }),
    );
    await settle(() => mounted.unmount());
    mounted = await mountIn("o2");
    await openMenu();
    def = itemNamed("Default");
    assert.doesNotMatch(
      glyph(def),
      /lucide-check/,
      "Default is not selected once a file is stored",
    );
    const custom = itemNamed("bell.wav");
    assert.match(glyph(custom), /lucide-check/);

    await settle(() => def.click());
    assert.equal(localStorage.getItem(chimeSoundKey), null);
    await openMenu();
    def = itemNamed("Default");
    assert.match(glyph(def), /lucide-check/, "Default again after the operator clears the file");
    assert.equal(
      [...document.querySelectorAll('[role="menuitem"]')].some(
        (candidate) => candidate.textContent === "bell.wav",
      ),
      false,
    );
    await settle(() => mounted.unmount());
    root = null;
  } finally {
    if (root) {
      const leftover: Root = root;
      const { act } = await import("react");
      await act(async () => leftover.unmount());
    }
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
