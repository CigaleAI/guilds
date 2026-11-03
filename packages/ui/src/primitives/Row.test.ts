import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Row } from "./Row";

test("a muted row greys its text and stays interactive", () => {
  const markup = renderToStaticMarkup(
    createElement(Row, { muted: true, interactive: true, title: "draft" }),
  );
  assert.match(markup, /text-muted/);
  assert.match(markup, /cursor-pointer/);
  assert.doesNotMatch(markup, /pointer-events-none/);
  assert.doesNotMatch(markup, /aria-disabled/);
});

test("a disabled row is marked disabled and takes no pointer events", () => {
  const markup = renderToStaticMarkup(createElement(Row, { disabled: true, title: "draft" }));
  assert.match(markup, /aria-disabled="true"/);
  assert.match(markup, /pointer-events-none/);
});

test("a selected muted row takes the selected text colour", () => {
  const markup = renderToStaticMarkup(
    createElement(Row, { muted: true, selected: true, title: "draft" }),
  );
  assert.match(markup, /text-on-plum/);
  assert.doesNotMatch(markup, /text-muted/);
});
