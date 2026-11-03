import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModeTagProps } from "@guildsrun/ui";
import type { ViewerMode } from "../../api/types/access";

/** True when each union holds every member of the other; false, and a compile error below, otherwise. */
type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const modeTagShowsEveryViewerMode: SameUnion<ViewerMode, ModeTagProps["mode"]> = true;

test("ModeTag shows each mode a page's viewer can have on an item, and no other", () => {
  assert.equal(modeTagShowsEveryViewerMode, true);
});
