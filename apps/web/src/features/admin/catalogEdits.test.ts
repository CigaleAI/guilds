import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogServer } from "../../api/types/admin";
import type { RemoteServerDraft } from "./types";
import {
  emptyRemoteServerDraft,
  isOAuthStrategy,
  isToolStart,
  remoteServerDraft,
} from "./catalogEdits";

test("a_new_remote_server_starts_blank_and_signs_in_with_a_token", () => {
  assert.equal(emptyRemoteServerDraft.slug, "");
  assert.equal(emptyRemoteServerDraft.auth, "token");
  assert.equal(emptyRemoteServerDraft.oauth_strategy, "none");
});

test("an_edited_remote_server_shows_its_absent_values_as_empty_text", () => {
  const server: Pick<CatalogServer, keyof RemoteServerDraft> = {
    slug: "acme",
    display_name: "Acme",
    url: null,
    auth: "oauth",
    oauth_strategy: "dynamic",
    description: "Calls Acme",
    limitations: null,
    setup_hint: "Ask ops",
  };
  assert.deepEqual(remoteServerDraft(server), {
    slug: "acme",
    display_name: "Acme",
    url: "",
    auth: "oauth",
    oauth_strategy: "dynamic",
    description: "Calls Acme",
    limitations: "",
    setup_hint: "Ask ops",
  });
});

test("an_oauth_strategy_is_none_dynamic_or_configured", () => {
  assert.equal(isOAuthStrategy("dynamic"), true);
  assert.equal(isOAuthStrategy("configured"), true);
  assert.equal(isOAuthStrategy("none"), true);
  assert.equal(isOAuthStrategy("implicit"), false);
});

test("a_tool_starts_as_its_connector_says_on_or_off", () => {
  assert.equal(isToolStart("manifest"), true);
  assert.equal(isToolStart("on"), true);
  assert.equal(isToolStart("off"), true);
  assert.equal(isToolStart("default"), false);
});
