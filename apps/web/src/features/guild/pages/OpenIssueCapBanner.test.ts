import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import type { GuildIssueList } from "../../../api/types/issues";

test("the Issues tab warns that new reports are refused exactly while the guild is at its open issue cap", async () => {
  const window = new Window({ url: "http://localhost/" });
  const globals = {
    window,
    self: window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const nodeEnv = process.env.NODE_ENV;
  let root: Root | null = null;
  try {
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
    process.env.NODE_ENV = "test";
    // React DOM tells browser from server when it loads.
    const React = await import("react");
    const { act, createElement } = React;
    // The design system's components are compiled here, outside Vite, with the classic JSX
    // transform, so they reach React as a global.
    Object.defineProperty(globalThis, "React", { value: React, configurable: true });
    const { createRoot } = await import("react-dom/client");
    const { OpenIssueCapBanner } = await import("./OpenIssueCapBanner");

    const container = document.createElement("div");
    const mounted = createRoot(container);
    root = mounted;
    const show = (list: GuildIssueList | undefined) =>
      act(async () => mounted.render(createElement(OpenIssueCapBanner, { list })));
    const warning = () => container.querySelector('[role="alert"]')?.textContent ?? null;

    await show(undefined);
    assert.equal(warning(), null, "nothing while the list loads");

    await show({ issues: [], open_cap: 100, at_open_cap: false });
    assert.equal(warning(), null, "nothing below the cap");

    await show({ issues: [], open_cap: 100, at_open_cap: true });
    assert.match(warning() ?? "", /This guild has reached its limit of 100 open issues/);
    assert.match(warning() ?? "", /new reports are refused, blocking ones included, until some are resolved/);
  } finally {
    if (root) {
      const mounted = root;
      const { act } = await import("react");
      await act(async () => mounted.unmount());
    }
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    for (const name of [...Object.keys(globals), "React"]) Reflect.deleteProperty(globalThis, name);
    await window.happyDOM.close();
  }
});
