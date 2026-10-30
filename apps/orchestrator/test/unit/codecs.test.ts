import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import {
  compareColumnTimestamps,
  formatColumnTimestamp,
  formatOperationalTimestamp,
  parseInt8,
  sortableColumnTimestamp,
  utcIso,
  utcStamp,
} from "../../src/db/codecs.js";
import { repoRoot } from "../../src/lib/paths.js";

const fixture = JSON.parse(
  readFileSync(
    path.join(repoRoot(import.meta.url), "fixtures/compat/codecs/timestamps.json"),
    "utf8",
  ),
) as {
  isoformat_us: string;
  isoformat_whole: string;
  z_from_offset: string;
  memory_iso: string;
  memory_stamp: string;
  bigint_id: number;
};

describe("codecs", () => {
  test("column timestamps match Python isoformat shapes", () => {
    assert.equal(
      formatColumnTimestamp("2026-09-13 12:00:00.123456+00"),
      fixture.isoformat_us,
    );
    assert.equal(
      formatColumnTimestamp("2026-09-13T12:00:00.123456+00:00"),
      fixture.isoformat_us,
    );
    assert.equal(
      formatColumnTimestamp("2026-09-13 12:00:00+00"),
      fixture.isoformat_whole,
    );
    assert.equal(
      formatColumnTimestamp("2026-09-13T12:00:00+00:00"),
      fixture.isoformat_whole,
    );
  });

  test("sortable column timestamps keep short fractions in chronological order", () => {
    assert.equal(
      sortableColumnTimestamp("2026-09-13 12:00:00.123+00"),
      "2026-09-13T12:00:00.123000+00:00",
    );
    assert.equal(
      sortableColumnTimestamp("2026-09-13T12:00:00+00:00"),
      "2026-09-13T12:00:00.000000+00:00",
    );
    assert.ok(compareColumnTimestamps("2026-09-13T12:00:00.123Z", "2026-09-13 12:00:00.124+00") < 0);
    assert.ok(compareColumnTimestamps("2026-09-13T12:00:00.123Z", "2026-09-13T12:00:00.123+00:00") === 0);
    assert.ok(compareColumnTimestamps("2026-09-13 12:00:00.123001+00", "2026-09-13T12:00:00.123Z") > 0);
  });

  test("operational and memory stamps use the Z shape", () => {
    assert.equal(formatOperationalTimestamp("2026-09-13 12:00:00+00"), fixture.z_from_offset);
    assert.equal(utcIso("2026-09-13 12:00:00.123456+00"), fixture.memory_iso);
    assert.equal(utcStamp("2026-09-13 12:00:00.123456+00"), fixture.memory_stamp);
  });

  test("int8 values above 2^31 stay numbers", () => {
    assert.equal(parseInt8("4294967303"), fixture.bigint_id);
    assert.equal(parseInt8(String(fixture.bigint_id)), fixture.bigint_id);
    assert.throws(() => parseInt8("9007199254740992"), /MAX_SAFE_INTEGER/);
    assert.throws(() => parseInt8("1.5"), /not an integer/);
  });
});
