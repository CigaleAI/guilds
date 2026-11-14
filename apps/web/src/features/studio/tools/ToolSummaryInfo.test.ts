import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

test("a row's info icon shows the summary on hover, focus, and click, and never opens the row", async () => {
  const window = new Window({ url: "http://localhost/" });
  const globals = {
    window,
    self: window,
    document: window.document,
    navigator: window.navigator,
    PointerEvent: window.PointerEvent,
    KeyboardEvent: window.KeyboardEvent,
    CustomEvent: window.CustomEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    ResizeObserver: window.ResizeObserver,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  let root: Root | null = null;
  try {
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
    // React DOM tells browser from server when it loads.
    const React = await import("react");
    const { act, createElement } = React;
    // The design system's components are compiled here, outside Vite, with the classic JSX
    // transform, so they reach React as a global.
    Object.defineProperty(globalThis, "React", { value: React, configurable: true });
    const { createRoot } = await import("react-dom/client");
    const { DataTable, TooltipProvider } = await import("@guildsrun/ui");
    const { ToolSummaryInfo } = await import("./ToolSummaryInfo");

    const opened: string[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const mounted = createRoot(container);
    root = mounted;
    const settle = (change: () => unknown) =>
      act(async () => {
        await change();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    const summary = () => document.querySelector('[role="tooltip"]')?.textContent ?? null;
    const button = () => {
      const found = container.querySelector('button[aria-label="About note_get"]');
      assert.ok(found instanceof HTMLButtonElement, "the icon is a button named for its tool");
      return found;
    };
    const pointer = (type: string, target: Element) =>
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "mouse" }));
    const pressEscape = () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    await settle(() =>
      mounted.render(
        createElement(
          TooltipProvider,
          null,
          createElement(DataTable<{ name: string }>, {
            label: "Tools",
            columns: [
              {
                id: "tool",
                header: "Tool",
                cell: (row) =>
                  createElement(ToolSummaryInfo, {
                    name: row.name,
                    summary: "Opens one note so the agent can read it.",
                  }),
              },
            ],
            rows: [{ name: "note_get" }],
            getRowKey: (row) => row.name,
            onRowClick: (row) => opened.push(row.name),
          }),
        ),
      ),
    );
    assert.equal(summary(), null, "the summary is closed at first");

    await settle(() => button().focus());
    assert.equal(summary(), "Opens one note so the agent can read it.", "focus opens it");
    assert.ok(button().getAttribute("aria-describedby"), "the summary describes the icon");
    await settle(pressEscape);
    assert.equal(summary(), null, "Esc closes it");

    await settle(() => button().blur());
    await settle(async () => {
      pointer("pointermove", button());
      // The first hover opens after the provider's delay.
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    assert.equal(summary(), "Opens one note so the agent can read it.", "hover opens it");
    await settle(pressEscape);

    await settle(() => {
      pointer("pointerdown", button());
      button().click();
    });
    assert.equal(summary(), "Opens one note so the agent can read it.", "a click opens it");
    await settle(() => pointer("pointerdown", button()));
    await settle(() => button().click());
    assert.equal(
      summary(),
      "Opens one note so the agent can read it.",
      "another click keeps it open",
    );
    const card = document.querySelector('[role="tooltip"]');
    assert.ok(card instanceof HTMLElement, "the summary's card is on screen");
    await settle(() => card.click());
    assert.deepEqual(opened, [], "clicking the icon or its summary leaves the row closed");

    await settle(() => pointer("pointerdown", document.body));
    assert.equal(summary(), null, "a click elsewhere closes it");
  } finally {
    if (root) {
      const mounted = root;
      const { act } = await import("react");
      await act(async () => mounted.unmount());
    }
    for (const name of [...Object.keys(globals), "React"]) Reflect.deleteProperty(globalThis, name);
    await window.happyDOM.close();
  }
});
