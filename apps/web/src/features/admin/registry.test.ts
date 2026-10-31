import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptanceOf, registryAction } from "./registry";

test("installing_a_connector_accepts_what_the_registry_has_not_vouched_for", () => {
  assert.deepEqual(acceptanceOf({ slug: "linear", verified: true }), {
    slug: "linear",
    unverified: false,
    experimental: false,
  });
  assert.deepEqual(acceptanceOf({ slug: "beta", verified: false, experimental: true }), {
    slug: "beta",
    unverified: true,
    experimental: true,
  });
});

test("a registry connector offers install, update, or nothing by what the box has", () => {
  assert.equal(registryAction({ version: "1.2.0", installed: null }), "install");
  assert.equal(
    registryAction({ version: "1.2.0", installed: { source: "registry", version: "1.1.0" } }),
    "update",
  );
  assert.equal(
    registryAction({ version: "1.2.0", installed: { source: "registry", version: "1.2.0" } }),
    "current",
  );
  assert.equal(
    registryAction({ version: "1.2.0", installed: { source: "core", version: "1.0.0" } }),
    "elsewhere",
  );
  assert.equal(
    registryAction({ version: "1.2.0", installed: { source: "local", version: "" } }),
    "elsewhere",
  );
});
