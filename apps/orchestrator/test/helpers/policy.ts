import { UNLIMITED, type OrgLimits, type OrgPolicy, type PolicyError } from "../../src/policy/index.js";

/**
 * A policy with the given caps over core's uncapped ones, and an optional refusal. It reads
 * `limits` on every call, so a test changes a cap by assigning to the object it passed.
 */
export function limitedPolicy(limits: Partial<OrgLimits>, blocked: PolicyError | null = null): OrgPolicy {
  return {
    async standing() {
      return { limits: { ...UNLIMITED, ...limits }, blocked };
    },
  };
}
