import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueryClient } from "@tanstack/react-query";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import type { Identity } from "../../api/identity";
import type { BuilderSession } from "../../api/types/builder";

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

const session: BuilderSession = {
  id: "b_1",
  org_id: "o1",
  recipe_id: "rc_1",
  status: "active",
  blocked_reason: null,
  generation_state: "idle",
  generation_number: 1,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  recipe: {
    id: "rc_1",
    org_id: "o1",
    created_by_user_id: "u1",
    name: "Research desk",
    description: "",
    visibility: "org",
    status: "draft",
    body: {
      format: "guilds.recipe",
      version: 1,
      meta: {
        name: "Research desk",
        description: "",
        created_at: "2026-01-01T00:00:00.000Z",
        source: { kind: "builder", session_id: "b_1" },
      },
      guild: {
        name_suggestion: "research",
        about: "",
        objective: "",
        group_agent_message_limit: 20,
      },
      roles: [],
      collections: [],
      notes: [],
      connections: [],
      secrets: [],
      external: [],
      repositories: [],
      design: { systems: [], specialization: [], routines: [], handoffs: [], browser: [] },
    },
    body_version: 1,
    source_kind: "builder",
    source_guild_id: null,
    source_builder_session_id: "b_1",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  },
};

test("a_refused_message_stays_in_the_composer_and_a_delivered_one_leaves_it", async () => {
  const window = new Window({ url: "http://localhost/" });
  const globals = {
    window,
    self: window,
    document: window.document,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window),
    Event: window.Event,
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
    // The server: the reply the next posted message gets.
    let postReply = () => Response.json({ detail: "The coach is busy" }, { status: 409 });
    const posted: string[] = [];
    globalThis.fetch = async (input, init) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (init?.method === "POST" && path === "/api/builder/sessions/b_1/messages") {
        posted.push(String(init.body));
        return postReply();
      }
      return Response.json({ detail: "Not found" }, { status: 404 });
    };

    process.env.NODE_ENV = "test";
    // React DOM and the query client tell browser from server when they load.
    const React = await import("react");
    const { act, createElement } = React;
    // tsx compiles the UI kit's components outside this app's tsconfig, with the classic JSX
    // transform, so they reach React as a global.
    Object.defineProperty(globalThis, "React", { value: React, configurable: true });
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { IdentityContext } = await import("../../app/identity");
    const { BuilderChat } = await import("./BuilderChat");

    // A finite gcTime leaves a timer after the chat unmounts that keeps the test running.
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
    // A fetch answers over several ticks; the view is read once it shows what it waits for.
    const until = async (shown: () => boolean, what: string) => {
      for (let tick = 0; tick < 20 && !shown(); tick++) await settle(() => undefined);
      assert.ok(shown(), what);
    };
    await settle(() =>
      mounted.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            IdentityContext.Provider,
            { value: identity },
            createElement(BuilderChat, { session, messages: [], live: null }),
          ),
        ),
      ),
    );
    const box = () => {
      const found = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message the coach"]',
      );
      assert.ok(found, "the composer is shown");
      return found;
    };
    const type = (text: string) =>
      settle(() => {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.call(
          box(),
          text,
        );
        box().dispatchEvent(new Event("input", { bubbles: true }));
      });
    const sendButton = () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Send",
      );

    // A refused post puts the message back in the box once its error arrives.
    await type("Design a research desk");
    await settle(() => sendButton()?.click());
    await until(() => posted.length === 1, "the message is posted");
    await until(() => box().value === "Design a research desk", "the refused message is back");

    // A delivered post leaves the box empty.
    postReply = () => Response.json(session);
    await settle(() => sendButton()?.click());
    await until(() => posted.length === 2, "the message is posted again");
    assert.deepEqual(posted, [
      '{"content":"Design a research desk"}',
      '{"content":"Design a research desk"}',
    ]);
    assert.equal(box().value, "");

    // Unmounted inside act, React has no work left that would outlive the window.
    await settle(() => mounted.unmount());
    root = null;
  } finally {
    root?.unmount();
    queries?.clear();
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    for (const [name, descriptor] of nodeGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    Reflect.deleteProperty(globalThis, "React");
    await window.happyDOM.close();
  }
});
