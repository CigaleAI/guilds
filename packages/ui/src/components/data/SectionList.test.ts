import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SectionList } from "./SectionList";

const item = createElement("button", { type: "button" }, "playbook.md");

test("a section shows its label, its count and its items", () => {
  const markup = renderToStaticMarkup(
    createElement(SectionList, { label: "Guild notes", count: 1, empty: "None yet." }, item),
  );
  assert.match(markup, /<section aria-label="Guild notes"/);
  assert.match(markup, />Guild notes</);
  assert.match(markup, />1</);
  assert.match(markup, />playbook\.md</);
  assert.doesNotMatch(markup, /None yet\./);
});

test("an empty section shows its empty-state message", () => {
  const markup = renderToStaticMarkup(
    createElement(SectionList, { label: "Shared with this guild", count: 0, empty: "None yet." }),
  );
  assert.match(markup, />0</);
  assert.match(markup, />None yet\.</);
});

test("an empty section without a message shows nothing under its label", () => {
  const markup = renderToStaticMarkup(
    createElement(SectionList, { label: "Shared with this guild", count: 0 }),
  );
  assert.match(markup, /><\/div><\/section>$/);
  assert.doesNotMatch(markup, /text-sm text-muted/);
});

test("a closed section shows its label and count but not its items", () => {
  const markup = renderToStaticMarkup(
    createElement(SectionList, { label: "Guild notes", count: 1, defaultOpen: false }, item),
  );
  assert.match(markup, /data-state="closed"/);
  assert.match(markup, />1</);
  assert.doesNotMatch(markup, /playbook\.md/);
});

test("a section given its open state follows it", () => {
  const markup = renderToStaticMarkup(
    createElement(
      SectionList,
      { label: "Guild notes", count: 1, open: false, defaultOpen: true },
      item,
    ),
  );
  assert.doesNotMatch(markup, /playbook\.md/);
});
