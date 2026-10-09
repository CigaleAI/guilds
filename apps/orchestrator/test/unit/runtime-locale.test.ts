import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { repoRoot } from "../../src/lib/paths.js";

const helper = path.join(repoRoot(import.meta.url), "runtime/guilds-locale");

function localeFromGeo(payload: Record<string, unknown>, language?: string) {
  const stdout = execFileSync("python3", [helper, "--from-json", JSON.stringify(payload), "--json"], {
    encoding: "utf8",
    env: { ...process.env, GUILDS_BROWSER_LANGUAGE: language ?? "" },
  });
  return JSON.parse(stdout) as Record<string, string>;
}

function shellExports(payload: Record<string, unknown>, language?: string) {
  return execFileSync("python3", [helper, "--from-json", JSON.stringify(payload)], {
    encoding: "utf8",
    env: { ...process.env, GUILDS_BROWSER_LANGUAGE: language ?? "" },
  });
}

test("French egress IP keeps Paris and defaults Chrome to en-US", () => {
  const values = localeFromGeo({
    status: "success",
    countryCode: "FR",
    timezone: "Europe/Paris",
    query: "203.0.113.10",
  });
  assert.equal(values.country, "FR");
  assert.equal(values.timezone, "Europe/Paris");
  assert.equal(values.locale, "en-US");
  assert.equal(values.lang, "en_US.UTF-8");
  assert.equal(values.chrome_lang, "en-US");
  assert.equal(values.chrome_accept_lang, "en-US,en;q=0.9");
  assert.equal(values.ip, "203.0.113.10");
});

test("US egress IP keeps the city timezone and en-US", () => {
  const values = localeFromGeo({
    country: "US",
    timezone: "America/Los_Angeles",
    ip: "198.51.100.20",
  });
  assert.equal(values.locale, "en-US");
  assert.equal(values.timezone, "America/Los_Angeles");
  assert.equal(values.chrome_accept_lang, "en-US,en;q=0.9");
});

test("preferred language is independent of the egress country", () => {
  const values = localeFromGeo(
    {
      success: true,
      country_code: "JP",
      timezone: { id: "Asia/Tokyo" },
      ip: "192.0.2.8",
    },
    "fr-FR",
  );
  assert.equal(values.locale, "fr-FR");
  assert.equal(values.lang, "fr_FR.UTF-8");
  assert.equal(values.chrome_lang, "fr-FR");
  assert.equal(values.chrome_accept_lang, "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7");
  assert.equal(values.timezone, "Asia/Tokyo");
});

test("unknown country and bad timezone fall back safely", () => {
  const values = localeFromGeo({
    countryCode: "ZZ",
    timezone: "../../etc/passwd",
  });
  assert.equal(values.country, "ZZ");
  assert.equal(values.timezone, "UTC");
  assert.equal(values.locale, "en-US");
});

test("locale helper prints quoted shell exports", () => {
  const text = shellExports({ countryCode: "FR", timezone: "Europe/Paris" }, "fr-FR");
  assert.match(text, /export TZ=Europe\/Paris/);
  assert.match(text, /export LANG=fr_FR\.UTF-8/);
  assert.match(text, /export CHROME_LANG=fr-FR/);
  assert.match(text, /CHROME_ACCEPT_LANG='fr-FR,fr;q=0\.9,en-US;q=0\.8,en;q=0\.7'/);
});

test("write-profile sets Chrome intl from the preferred language", () => {
  const profile = mkdtempSync(path.join(tmpdir(), "guilds-locale-profile-"));
  mkdirSync(path.join(profile, "Default"), { recursive: true });
  writeFileSync(
    path.join(profile, "Default", "Preferences"),
    JSON.stringify({ bookmark_bar: { show_on_all_tabs: true }, intl: { accept_languages: "en-US,en" } }),
  );
  execFileSync(
    "python3",
    [
      helper,
      "--from-json",
      JSON.stringify({ countryCode: "FR", timezone: "Europe/Paris" }),
      "--write-profile",
      profile,
    ],
    { env: { ...process.env, GUILDS_BROWSER_LANGUAGE: "fr-FR" } },
  );
  const prefs = JSON.parse(readFileSync(path.join(profile, "Default", "Preferences"), "utf8"));
  const localState = JSON.parse(readFileSync(path.join(profile, "Local State"), "utf8"));
  assert.equal(prefs.intl.accept_languages, "fr-FR,fr,en-US,en");
  assert.equal(prefs.intl.selected_languages, "fr-FR,fr,en-US,en");
  assert.equal(prefs.bookmark_bar.show_on_all_tabs, true);
  assert.equal(localState.intl.app_locale, "fr-FR");
});
