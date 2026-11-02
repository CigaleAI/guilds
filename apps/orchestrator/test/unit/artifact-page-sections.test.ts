import assert from "node:assert/strict";
import { test } from "node:test";
import type { GuildViewerMode, SectionedArtifactRow } from "../../src/db/artifact-lists.js";
import { hostNoteView, itemHome, pageSections } from "../../src/artifacts/store.js";
import { artifactRow } from "../helpers/artifacts.js";

function listed(key: string, home: string | null, homed: boolean): SectionedArtifactRow<GuildViewerMode> {
  return {
    ...artifactRow({ id: `art_${key}`, key, origin_guild_id: home }),
    home_name: home === null ? null : `${home}-name`,
    viewer_mode: "none",
    homed,
  };
}

test("pageSections puts the rows homed in the page's guild in own and the others in shared, in their order", () => {
  const rows = [listed("a.md", "guild_page", true), listed("b.md", null, false), listed("c.md", "guild_other", false)];
  const sections = pageSections(rows, (row) => row.key);
  assert.deepEqual(sections, { own: ["a.md"], shared: ["b.md", "c.md"] });
});

test("pageSections of no rows is two empty sections", () => {
  assert.deepEqual(pageSections([], (row) => row.key), { own: [], shared: [] });
});

test("itemHome names the guild an item is homed in, and is null for the organisation's", () => {
  assert.deepEqual(itemHome(listed("a.md", "guild_page", true)), { id: "guild_page", name: "guild_page-name" });
  assert.equal(itemHome(listed("b.md", null, false)), null);
});

test("itemHome is null for a home that names no guild", () => {
  assert.equal(itemHome({ ...listed("a.md", "guild_gone", false), home_name: null }), null);
});

test("hostNoteView carries the home and the viewer's mode", () => {
  const view = hostNoteView({ ...listed("a.md", "guild_page", true), viewer_mode: "all_read" });
  assert.deepEqual(view, {
    id: "art_a.md",
    path: "a.md",
    display_path: "org/org_1/a.md",
    kind: "note",
    title: null,
    version: 1,
    home: { id: "guild_page", name: "guild_page-name" },
    viewer_mode: "all_read",
  });
});
