import assert from "node:assert/strict";
import { newId } from "../../src/lib/ids.js";

const ID_TOKEN = /<id:([a-z]+):(\d+)>/g;
const ID_TOKEN_EXACT = /^<id:([a-z]+):(\d+)>$/;
const BIGINT_TOKEN_EXACT = /^<bigint:(\d+)>$/;
const TS_TOKEN_EXACT = /^<ts:([^>]+)>$/;
const CROCKFORD_ID = /^([a-z]+)_([0-9A-HJKMNPQRSTVWXYZ]{26})$/;
const TS_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const TS_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:\+00:00|-\d{2}:\d{2})$/;
const MEMORY_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;
const CLOCK_JSON_FIELD = /("utc_(?:now|date)":\s*")[^"]*(")/g;
const CLOCK_SESSION_FIELD = /^(\s*- utc_(?:now|date): ).+$/gm;

function maskClockFields(value: string): string {
  return value.replace(CLOCK_JSON_FIELD, "$1<clock>$2").replace(CLOCK_SESSION_FIELD, "$1<clock>");
}

export const STABLE_IDS = new Set([
  "user_operator",
  "org_home",
  "mcp_notion",
  "mcp_gmail",
  "mcp_drive",
  "mcp_sentry",
  "mcp_cigale",
  "mcp_coingecko",
  "mcp_alchemy",
  "mcp_opensea",
  "mcp_etherscan",
  "mcp_x",
  "mcp_twitterapiio",
  "mcp_qonto",
  "mcp_dexpaprika",
]);

export function timestampKind(value: string): string | null {
  if (TS_Z.test(value)) {
    return value.includes(".") ? "Z-us" : "Z";
  }
  if (TS_OFFSET.test(value)) {
    if (value.includes(".")) {
      return "+00:00-us";
    }
    if (value.endsWith("+00:00")) {
      return "+00:00";
    }
    return "offset";
  }
  if (MEMORY_STAMP.test(value)) {
    return "memory-stamp";
  }
  return null;
}

/** Column timestamps omit a zero fraction, so whole-second UTC matches the `-us` recording token. */
export function timestampKindsCompatible(expected: string, actual: string | null): boolean {
  if (actual === expected) {
    return true;
  }
  if (actual === null) {
    return false;
  }
  const withoutFraction = (kind: string) => (kind.endsWith("-us") ? kind.slice(0, -3) : kind);
  return withoutFraction(expected) === withoutFraction(actual);
}

const CROCKFORD_IN_TEXT = /\b([a-z]+)_([0-9A-HJKMNPQRSTVWXYZ]{26})\b/g;
const TS_Z_IN_TEXT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const TS_OFFSET_IN_TEXT =
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:\+00:00|-\d{2}:\d{2})/g;
const MEMORY_STAMP_IN_TEXT = /\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z/g;

export class PlaceholderMap {
  private readonly ids = new Map<string, string>();
  private readonly bigints = new Map<string, number>();

  substituteText(value: string): string {
    return value.replace(ID_TOKEN, (token, prefix: string) => {
      const existing = this.ids.get(token);
      if (existing) {
        return existing;
      }
      const actual = newId(prefix);
      this.ids.set(token, actual);
      return actual;
    });
  }

  substituteJson(value: unknown): unknown {
    if (typeof value === "string") {
      return this.substituteText(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.substituteJson(item));
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] = this.substituteJson(item);
      }
      return out;
    }
    return value;
  }

  compare(expected: unknown, actual: unknown, path = "$"): void {
    if (expected && typeof expected === "object" && actual && typeof actual === "object") {
      if (Array.isArray(expected) || Array.isArray(actual)) {
        assert.ok(Array.isArray(expected) && Array.isArray(actual), `${path} array`);
        assert.equal(actual.length, expected.length, `${path} length`);
        for (let index = 0; index < expected.length; index += 1) {
          this.compare(expected[index], actual[index], `${path}[${index}]`);
        }
        return;
      }
      const expectedObj = expected as Record<string, unknown>;
      const actualObj = actual as Record<string, unknown>;
      const expectedKeys = Object.keys(expectedObj).sort();
      const actualKeys = Object.keys(actualObj).sort();
      assert.deepEqual(actualKeys, expectedKeys, `${path} keys`);
      for (const key of Object.keys(expectedObj)) {
        if (key === "obsidian") {
          this.compareObsidian(
            String(expectedObj[key]),
            String(actualObj[key]),
            `${path}.obsidian`,
            typeof actualObj.path === "string" ? actualObj.path : undefined,
          );
          continue;
        }
        if (key === "system_prompt_hash") {
          assert.ok(
            typeof actualObj[key] === "string" && /^[0-9a-f]{64}$/.test(actualObj[key]),
            `${path}.${key} sha256`,
          );
          continue;
        }
        this.compare(expectedObj[key], actualObj[key], `${path}.${key}`);
      }
      return;
    }
    if (typeof expected === "string" && BIGINT_TOKEN_EXACT.test(expected)) {
      assert.ok(typeof actual === "number" && Number.isInteger(actual), `${path} bigint ${actual}`);
      const bound = this.bigints.get(expected);
      if (bound !== undefined) {
        assert.equal(actual, bound, path);
        return;
      }
      this.bigints.set(expected, actual);
      return;
    }
    if (typeof expected === "string" && typeof actual === "string") {
      this.compareString(maskClockFields(expected), maskClockFields(actual), path);
      return;
    }
    assert.deepEqual(actual, expected, path);
  }

  private compareString(expected: string, actual: string, path: string): void {
    const idMatch = ID_TOKEN_EXACT.exec(expected);
    if (idMatch) {
      const token = expected;
      const crockford = CROCKFORD_ID.exec(actual);
      assert.ok(crockford, `${path} expected Crockford id, got ${actual}`);
      assert.equal(crockford[1], idMatch[1], `${path} id prefix`);
      const bound = this.ids.get(token);
      if (bound) {
        assert.equal(actual, bound, path);
        return;
      }
      this.ids.set(token, actual);
      return;
    }
    const tsMatch = TS_TOKEN_EXACT.exec(expected);
    if (tsMatch) {
      assert.ok(
        timestampKindsCompatible(tsMatch[1]!, timestampKind(actual)),
        `${path} timestamp ${actual}`,
      );
      return;
    }
    if (expected.includes("<id:")) {
      const substituted = expected.replace(ID_TOKEN, (token) => {
        const bound = this.ids.get(token);
        assert.ok(bound, `${path} unbound ${token}`);
        return bound ?? token;
      });
      assert.equal(actual, substituted, path);
      return;
    }
    assert.equal(actual, expected, path);
  }

  private compareObsidian(
    expected: string,
    actual: string,
    path: string,
    filePath?: string,
  ): void {
    const prefix = "obsidian://open?path=";
    assert.ok(actual.startsWith(prefix), `${path} prefix`);
    assert.ok(expected.startsWith(prefix), `${path} fixture prefix`);
    const actualPath = decodeURIComponent(actual.slice(prefix.length));
    if (filePath) {
      assert.ok(
        actualPath === filePath || actualPath.endsWith(`/${filePath}`),
        `${path} should end with ${filePath}`,
      );
      return;
    }
    const expectedPath = decodeURIComponent(expected.slice(prefix.length));
    const actualBase = actualPath.split("/").pop() ?? "";
    const expectedBase = (expectedPath.split("/").pop() ?? "").replace(ID_TOKEN, (token) => {
      return this.ids.get(token) ?? token;
    });
    assert.equal(actualBase, expectedBase, `${path} basename`);
  }

  remapRecordedId(value: string): string {
    const substituted = this.substituteText(value);
    const match = CROCKFORD_ID.exec(substituted);
    if (!match || STABLE_IDS.has(substituted)) {
      return substituted;
    }
    const prefix = match[1];
    const bound = this.ids.get(`<id:${prefix}:1>`);
    return bound ?? substituted;
  }

  maskText(value: string): string {
    const reverse = new Map<string, string>();
    for (const [token, actual] of this.ids) {
      reverse.set(actual, token);
    }
    let text = value.replace(CROCKFORD_IN_TEXT, (match) => {
      if (STABLE_IDS.has(match)) {
        return match;
      }
      return reverse.get(match) ?? match;
    });
    text = text.replace(TS_Z_IN_TEXT, (match) => `<ts:${timestampKind(match) ?? "Z"}>`);
    text = text.replace(TS_OFFSET_IN_TEXT, (match) => `<ts:${timestampKind(match) ?? "offset"}>`);
    text = text.replace(MEMORY_STAMP_IN_TEXT, "<ts:memory-stamp>");
    return text;
  }
}
