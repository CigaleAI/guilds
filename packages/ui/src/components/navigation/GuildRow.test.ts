import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GuildRow } from "./GuildRow";

const row = { name: "Research", agentCount: 2, maxAgents: 15 };

test("unread tags show as a blue count and open issues as a red one", () => {
  const markup = renderToStaticMarkup(createElement(GuildRow, { ...row, tags: 3, issues: 140 }));
  assert.match(markup, /class="[^"]*bg-signal[^"]*" aria-label="3 unread tags">3</);
  assert.match(markup, /class="[^"]*bg-alert[^"]*" aria-label="140 open issues">140</);
});

test("a zero count shows no badge", () => {
  const issuesOnly = renderToStaticMarkup(createElement(GuildRow, { ...row, tags: 0, issues: 1 }));
  assert.doesNotMatch(issuesOnly, /unread tags/);
  assert.match(issuesOnly, /1 open issues/);
  const none = renderToStaticMarkup(createElement(GuildRow, { ...row, tags: 0, issues: 0 }));
  assert.doesNotMatch(none, /aria-label="\d+ (unread tags|open issues)"/);
});
