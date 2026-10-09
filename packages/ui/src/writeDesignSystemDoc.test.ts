import assert from "node:assert/strict";
import { test } from "node:test";
import { designSystemMarkdown } from "./writeDesignSystemDoc";

test("the design-system doc is generated from live tokens, identity, and stories", () => {
  const md = designSystemMarkdown();
  assert.match(md, /^# guilds\.run design system/m);
  assert.match(md, /pnpm design-system-doc/);
  assert.match(md, /`--page`/);
  assert.match(md, /`--fg`/);
  assert.match(md, /`type-body`/);
  assert.match(md, /`rounded-md`/);
  assert.match(md, /rosewood `#b8627f`/);
  assert.match(md, /wake `posted`/);
  assert.match(md, /### Components\/Actions\/Button/);
  assert.match(md, /variant: primary \| accent/);
  assert.match(md, /Stories: Playground/);
  assert.match(md, /### Foundations/);
  assert.match(md, /### Primitives\/Icon/);
  assert.match(md, /\*\*CopyButton\.\*\* Copies text to the clipboard/);
  assert.doesNotMatch(md, /\*\*CopyButton\.\*\* The text to copy/);
  assert.doesNotMatch(md, /writeDesignSystemDoc/);
});
