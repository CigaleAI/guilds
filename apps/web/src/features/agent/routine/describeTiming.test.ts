import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { describeCron, describeWindow } from "./describeTiming";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../../../../fixtures/compat/schedules/cron.json", import.meta.url),
    "utf8",
  ),
) as { describe: Record<"monday" | "weekdays" | "names", string> };

test("cron reads as the server's label", () => {
  assert.equal(describeCron("0 9 * * 1"), fixture.describe.monday);
  assert.equal(describeCron("0 9 * * 1-5"), fixture.describe.weekdays);
  assert.equal(describeCron("0 9 * * MON,WED,FRI"), fixture.describe.names);
  assert.equal(describeCron("0 9,18 * * *"), "At 09:00 and 18:00 every day (UTC)");
  assert.equal(describeCron("*/30 * * * *"), "Every 30 minutes (UTC)");
  assert.equal(describeCron("0 * * * *"), "Every hour (UTC)");
  assert.equal(describeCron("0 */6 * * *"), "Every 6 hours (UTC)");
  assert.equal(describeCron("15 14 1 * *"), "At 14:15 on day 1 of the month (UTC)");
  assert.equal(describeCron("0 0 1 1 *"), "At 00:00 on day 1 of the month in January (UTC)");
  assert.equal(describeCron("not cron"), "not cron");
});

test("a window names its count, span and timezone", () => {
  const paris = { timezone: "Europe/Paris", start: "08:00", end: "20:00", max_wakes: 20 };
  assert.equal(
    describeWindow(paris),
    "Up to 20 random wake-ups between 08:00 and 20:00 every day (Europe/Paris)",
  );
  assert.equal(
    describeWindow({ ...paris, max_wakes: 1 }),
    "1 random wake-up between 08:00 and 20:00 every day (Europe/Paris)",
  );
});
