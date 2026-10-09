import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PlaceholderMap,
  timestampKind,
  timestampKindsCompatible,
} from "../helpers/placeholders.js";

test("timestampKind splits whole-second UTC from a fraction", () => {
  assert.equal(timestampKind("2026-09-24T09:50:58+00:00"), "+00:00");
  assert.equal(timestampKind("2026-09-24T09:50:58.123456+00:00"), "+00:00-us");
  assert.equal(timestampKind("2026-09-24T09:50:58Z"), "Z");
  assert.equal(timestampKind("2026-09-24T09:50:58.1Z"), "Z-us");
});

test("HTTP recordings accept a zero fraction on UTC timestamps", () => {
  assert.equal(timestampKindsCompatible("+00:00-us", "+00:00"), true);
  assert.equal(timestampKindsCompatible("+00:00", "+00:00-us"), true);
  assert.equal(timestampKindsCompatible("Z-us", "Z"), true);
  assert.equal(timestampKindsCompatible("Z", "+00:00"), false);
  const placeholders = new PlaceholderMap();
  placeholders.compare(
    { replaced_at: "<ts:+00:00-us>" },
    { replaced_at: "2026-09-24T09:50:58+00:00" },
  );
  assert.throws(() => {
    placeholders.compare({ t: "<ts:Z>" }, { t: "2026-09-24T09:50:58+00:00" });
  });
});
