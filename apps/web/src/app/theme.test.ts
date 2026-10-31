import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readThemePreference } from "./theme";

function storeTheme(value: string | null) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => (key === "guilds-theme" ? value : null) },
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

test("a stored light or dark choice is the preference", () => {
  storeTheme("dark");
  assert.equal(readThemePreference(), "dark");
  storeTheme("light");
  assert.equal(readThemePreference(), "light");
});

test("the preference follows the system without a readable choice", () => {
  storeTheme("sepia");
  assert.equal(readThemePreference(), "system");
  storeTheme(null);
  assert.equal(readThemePreference(), "system");
});

test("the preference follows the system when storage is unavailable", () => {
  assert.equal(readThemePreference(), "system");
});
