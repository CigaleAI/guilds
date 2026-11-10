import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Window } from "happy-dom";
import type { QuestionWidget } from "../../api/types/builder";
import type { ReplyOutcome } from "./types";

const widget: QuestionWidget = {
  widget: "question",
  await_operator: true,
  title: "Which chain?",
  questions: [
    {
      id: "q-1",
      header: "Chain",
      question: "Which chain?",
      options: [{ id: "opt-1", label: "Solana", description: "" }],
      allow_other: false,
      multi_select: false,
    },
  ],
};

const window = new Window({ url: "http://localhost/" });
const globals = {
  window,
  self: window,
  document: window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
};

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
});

after(async () => {
  for (const name of [...Object.keys(globals), "React"]) Reflect.deleteProperty(globalThis, name);
  await window.happyDOM.close();
});

/** Renders a question card, picks its option, sends it, and waits for the reply's outcome. */
async function sendAnswers(outcome: ReplyOutcome) {
  // React DOM tells browser from server when it loads, so it loads once the globals are set.
  const React = await import("react");
  const { act, createElement } = React;
  const { createRoot } = await import("react-dom/client");
  // tsx compiles the UI kit's components outside this app's tsconfig, with the classic JSX
  // transform, so they reach React as a global.
  Object.defineProperty(globalThis, "React", { value: React, configurable: true });
  const { QuestionCard } = await import("./BuilderWidgets");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const replies: string[] = [];
  const onReply = (message: string) => {
    replies.push(message);
    return Promise.resolve(outcome);
  };
  const settle = (change: () => void) =>
    act(async () => {
      change();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  await settle(() =>
    root.render(createElement(QuestionCard, { widget, answered: false, live: true, onReply })),
  );
  const option = container.querySelector<HTMLButtonElement>("button[aria-pressed]");
  await settle(() => option?.click());
  const send = () =>
    [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Send answers",
    );
  await settle(() => send()?.click());
  const view = {
    replies,
    fieldsetDisabled: container.querySelector("fieldset")?.disabled,
    send: send() ?? null,
    text: container.textContent ?? "",
  };
  await settle(() => root.unmount());
  container.remove();
  return view;
}

test("a_failed_reply_leaves_the_card_open_in_the_view", async () => {
  const view = await sendAnswers("failed");
  assert.deepEqual(view.replies, ["I answered:\n- Chain: Solana"]);
  assert.equal(view.fieldsetDisabled, false);
  assert.ok(view.send);
  assert.equal(view.send.disabled, false);
  assert.doesNotMatch(view.text, /Answered/);
});

test("a_delivered_reply_settles_the_card_in_the_view", async () => {
  const view = await sendAnswers("delivered");
  assert.deepEqual(view.replies, ["I answered:\n- Chain: Solana"]);
  assert.equal(view.fieldsetDisabled, true);
  assert.equal(view.send, null);
  assert.match(view.text, /Answered/);
});
