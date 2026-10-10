import assert from "node:assert/strict";
import { test } from "node:test";
import type { Instance, InstanceIntegration } from "../../api/types";
import {
  connectorSetupGap,
  integrationFor,
  missingVariables,
  missingVariablesPhrase,
  toolIntegrationGap,
} from "./instance";

function integration(
  id: string,
  variables: Record<string, boolean | "optional">,
  provides: Partial<InstanceIntegration["provides"]> = {},
): InstanceIntegration {
  const required = Object.entries(variables).filter(([, set]) => set !== "optional");
  const set = required.filter(([, value]) => value === true).length;
  return {
    id,
    label: id,
    enables: "",
    state: set === required.length ? "on" : set === 0 ? "off" : "incomplete",
    variables: Object.entries(variables).map(([name, value]) => ({
      name,
      optional: value === "optional",
      set: value === true,
    })),
    provides: { native_tools: [], connectors: [], ...provides },
  };
}

function instance(...integrations: InstanceIntegration[]): Instance {
  return { auth_mode: "compat-cookie", integrations };
}

const searchOff = integration("web-search", { TAVILY_API_KEY: false }, { connectors: ["tavily"] });
const githubPartial = integration(
  "github-app",
  {
    GITHUB_APP_ID: true,
    GITHUB_APP_SLUG: false,
    GITHUB_APP_PRIVATE_KEY: false,
    GITHUB_APP_CLIENT_ID: false,
  },
  { connectors: ["github"] },
);
const routing = integration("group-routing", {
  TYPESAFE_API_KEY: false,
  TYPESAFE_MODEL: "optional",
});

test("an integration is found by what it switches on", () => {
  const box = instance(searchOff, githubPartial);
  assert.equal(integrationFor(box, "connectors", "tavily")?.id, "web-search");
  assert.equal(integrationFor(box, "connectors", "github")?.id, "github-app");
  assert.equal(integrationFor(box, "connectors", "notion"), undefined);
  assert.equal(integrationFor(undefined, "connectors", "github"), undefined);
});

test("only required variables that are unset count as missing", () => {
  assert.deepEqual(missingVariables(routing), ["TYPESAFE_API_KEY"]);
  assert.deepEqual(missingVariables(githubPartial), [
    "GITHUB_APP_SLUG",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_CLIENT_ID",
  ]);
  assert.equal(missingVariablesPhrase(searchOff), "TAVILY_API_KEY");
  assert.equal(
    missingVariablesPhrase(githubPartial),
    "GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_CLIENT_ID",
  );
});

test("a native tool waits for its integration and no other tool does", () => {
  const lookupOff = integration(
    "lookup",
    { LOOKUP_API_KEY: false },
    { native_tools: ["lookup_find"] },
  );
  assert.equal(toolIntegrationGap(instance(lookupOff), "lookup_find")?.id, "lookup");
  assert.equal(toolIntegrationGap(instance(lookupOff), "note_find"), null);
  const on = integration("lookup", { LOOKUP_API_KEY: true }, { native_tools: ["lookup_find"] });
  assert.equal(toolIntegrationGap(instance(on), "lookup_find"), null);
  assert.equal(
    toolIntegrationGap(undefined, "lookup_find"),
    null,
    "nothing is flagged before the server answers",
  );
});

test("a connector that cannot start its sign-in names what the server lacks", () => {
  const github = { slug: "github", oauth_setup_state: "unsupported" as const };
  assert.equal(
    connectorSetupGap(github, instance(githubPartial)),
    "Needs GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_CLIENT_ID set on this server.",
  );
  assert.equal(
    connectorSetupGap({ ...github, oauth_setup_state: "configured" }, instance(githubPartial)),
    null,
  );
  assert.equal(
    connectorSetupGap({ slug: "notion", oauth_setup_state: "dynamic" }, instance()),
    null,
  );
  assert.equal(
    connectorSetupGap(
      { slug: "custom", oauth_setup_state: "unsupported" },
      instance(githubPartial),
    ),
    "This server has no OAuth client for this connector.",
  );
});
