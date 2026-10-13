import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

/**
 * Makes the organisation's default machine a code machine through the machine routes, so coding
 * agents can sit on it.
 */
export async function codeDefaultMachine(
  app: FastifyInstance,
  headers: Record<string, string>,
  orgId = "org_home",
): Promise<string> {
  const listed = await app.inject({ method: "GET", url: `/api/orgs/${orgId}/machines`, headers });
  assert.equal(listed.statusCode, 200, listed.body);
  const machine = (listed.json() as Array<{ id: string; name: string }>).find((item) => item.name === "default");
  assert.ok(machine, "the organisation has its default machine");
  const patched = await app.inject({
    method: "PATCH",
    url: `/api/orgs/${orgId}/machines/${machine.id}`,
    headers: { ...headers, "content-type": "application/json" },
    payload: { box: "code" },
  });
  assert.equal(patched.statusCode, 200, patched.body);
  return machine.id;
}
