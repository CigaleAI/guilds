import assert from "node:assert/strict";
import { test } from "node:test";
import type { Instance, InstanceIntegration, IntegrationField } from "../../api/types";
import {
  connectorSetupGap,
  integrationFor,
  missingFields,
  missingFieldsPhrase,
  safeReturnTo,
  setupSearch,
  toolIntegrationGap,
} from "./instance";

function field(
  name: string,
  label: string,
  set: boolean,
  flags: Partial<Pick<IntegrationField, "optional" | "secret" | "multiline">> = {},
): IntegrationField {
  return { name, label, set, optional: false, secret: true, multiline: false, ...flags };
}

function integration(
  id: string,
  label: string,
  fields: IntegrationField[],
  extras: {
    provides?: Partial<InstanceIntegration["provides"]>;
    source?: InstanceIntegration["source"];
  } = {},
): InstanceIntegration {
  const required = fields.filter((item) => !item.optional);
  const set = required.filter((item) => item.set).length;
  return {
    id,
    label,
    enables: "",
    source: extras.source ?? "store",
    state: set === required.length ? "on" : set === 0 ? "off" : "incomplete",
    fields,
    setup: null,
    updated_at: null,
    set_by: null,
    provides: { native_tools: [], connectors: [], ...extras.provides },
  };
}

function instance(...integrations: InstanceIntegration[]): Instance {
  return { auth_mode: "compat-cookie", integrations };
}

const searchOff = integration("web-search", "Web search", [field("api_key", "API key", false)], {
  provides: { connectors: ["tavily"] },
});
const githubPartial = integration(
  "github-app",
  "GitHub App",
  [
    field("app_id", "App ID", true, { secret: false }),
    field("slug", "Slug", true, { secret: false }),
    field("private_key", "Private key (PEM)", false, { multiline: true }),
    field("client_id", "Client ID", true, { secret: false }),
    field("client_secret", "Client secret", false),
  ],
  { provides: { connectors: ["github"] } },
);
const githubOn = integration(
  "github-app",
  "GitHub App",
  [field("app_id", "App ID", true, { secret: false }), field("private_key", "Private key", true)],
  { provides: { connectors: ["github"] } },
);
const systemOne = integration(
  "system-one",
  "System One",
  [
    field("provider", "Provider", false, { optional: true, secret: false }),
    field("api_key", "API key", false),
    field("model", "Model", false, { optional: true, secret: false }),
  ],
  { provides: { native_tools: ["browse"] } },
);
const registry = integration(
  "registry",
  "Registry",
  [
    field("REGISTRY_URL", "REGISTRY_URL", false, { secret: false }),
    field("REGISTRY_TOKEN", "REGISTRY_TOKEN", false),
    field("REGISTRY_KEY", "REGISTRY_KEY", false),
  ],
  { source: "env" },
);

test("an integration is found by what it switches on", () => {
  const box = instance(searchOff, githubPartial);
  assert.equal(integrationFor(box, "connectors", "tavily")?.id, "web-search");
  assert.equal(integrationFor(box, "connectors", "github")?.id, "github-app");
  assert.equal(integrationFor(box, "connectors", "notion"), undefined);
  assert.equal(integrationFor(undefined, "connectors", "github"), undefined);
});

test("only required fields that are unset count as missing", () => {
  assert.deepEqual(
    missingFields(systemOne).map((item) => item.name),
    ["api_key"],
  );
  assert.deepEqual(
    missingFields(githubPartial).map((item) => item.name),
    ["private_key", "client_secret"],
  );
  assert.deepEqual(missingFields(githubOn), []);
  assert.equal(missingFieldsPhrase(searchOff), "API key");
  assert.equal(missingFieldsPhrase(githubPartial), "Private key (PEM) and Client secret");
  assert.equal(missingFieldsPhrase(registry), "REGISTRY_URL, REGISTRY_TOKEN, and REGISTRY_KEY");
});

test("a native tool waits for its integration and no other tool does", () => {
  const lookupOff = integration("lookup", "Lookup", [field("api_key", "API key", false)], {
    provides: { native_tools: ["lookup_find"] },
  });
  assert.equal(toolIntegrationGap(instance(lookupOff), "lookup_find")?.id, "lookup");
  assert.equal(toolIntegrationGap(instance(lookupOff), "note_find"), null);
  assert.equal(toolIntegrationGap(instance(systemOne), "browse")?.id, "system-one");
  const on = integration("lookup", "Lookup", [field("api_key", "API key", true)], {
    provides: { native_tools: ["lookup_find"] },
  });
  assert.equal(toolIntegrationGap(instance(on), "lookup_find"), null);
  assert.equal(
    toolIntegrationGap(undefined, "lookup_find"),
    null,
    "nothing is flagged before the server answers",
  );
});

test("a connector that cannot start its sign-in names the platform key it waits for", () => {
  const github = { slug: "github", oauth_setup_state: "unsupported" as const };
  assert.deepEqual(connectorSetupGap(github, instance(githubPartial)), {
    text: "GitHub App is not set up on this server: Private key (PEM) and Client secret missing.",
    integration: "github-app",
  });
  assert.deepEqual(connectorSetupGap(github, instance(searchOff)), {
    text: "This server has no OAuth client for this connector.",
    integration: null,
  });
  assert.deepEqual(
    connectorSetupGap(github, instance(githubOn)),
    { text: "This server has no OAuth client for this connector.", integration: null },
    "an integration that is on explains nothing",
  );
  assert.equal(
    connectorSetupGap({ ...github, oauth_setup_state: "configured" }, instance(githubPartial)),
    null,
  );
  assert.equal(
    connectorSetupGap({ slug: "notion", oauth_setup_state: "dynamic" }, instance()),
    null,
  );
  assert.deepEqual(
    connectorSetupGap(
      { slug: "custom", oauth_setup_state: "unsupported" },
      instance(githubPartial),
    ),
    { text: "This server has no OAuth client for this connector.", integration: null },
  );
});

test("the setup link opens the integration and remembers where to return", () => {
  assert.deepEqual(setupSearch("github-app"), { tab: "instance", integration: "github-app" });
  assert.deepEqual(setupSearch("github-app", "/guilds/g1/tools"), {
    tab: "instance",
    integration: "github-app",
    return_to: "/guilds/g1/tools",
  });
});

test("only a path on this origin is followed back", () => {
  assert.equal(safeReturnTo("/guilds/g1/tools?tab=mcp"), "/guilds/g1/tools?tab=mcp");
  assert.equal(safeReturnTo("//evil.example/x"), null);
  assert.equal(safeReturnTo("https://evil.example/x"), null);
  assert.equal(safeReturnTo("/\\evil.example"), null);
  assert.equal(safeReturnTo("guilds"), null);
  assert.equal(safeReturnTo(""), null);
  assert.equal(safeReturnTo(undefined), null);
});
