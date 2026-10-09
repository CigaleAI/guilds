import assert from "node:assert/strict";
import { test } from "node:test";
import { registryAction } from "./registry";

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
