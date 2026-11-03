import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModeTag } from "./ModeTag";

test("a write mode shows in tide and a read mode in signal, for an agent and a guild alike", () => {
  assert.match(renderToStaticMarkup(createElement(ModeTag, { mode: "write" })), /bg-t-tide/);
  assert.match(renderToStaticMarkup(createElement(ModeTag, { mode: "all_write" })), /bg-t-tide/);
  assert.match(renderToStaticMarkup(createElement(ModeTag, { mode: "read" })), /bg-t-sig/);
  assert.match(renderToStaticMarkup(createElement(ModeTag, { mode: "all_read" })), /bg-t-sig/);
});

test("a guild's mode names whether all of its agents or only some reach the item", () => {
  assert.match(
    renderToStaticMarkup(createElement(ModeTag, { mode: "all_write" })),
    />All agents · read &amp; write</,
  );
  assert.match(
    renderToStaticMarkup(createElement(ModeTag, { mode: "all_read" })),
    />All agents · read</,
  );
  assert.match(renderToStaticMarkup(createElement(ModeTag, { mode: "some" })), />Some agents</);
});

test("no access shows on the well ground", () => {
  const markup = renderToStaticMarkup(createElement(ModeTag, { mode: "none" }));
  assert.match(markup, />No access</);
  assert.match(markup, /bg-well/);
});
