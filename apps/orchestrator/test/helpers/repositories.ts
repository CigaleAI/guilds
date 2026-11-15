import type { CodingRepository } from "../../src/coding/repositories.js";

/**
 * A repository as a coding run clones it: `shop` on GitHub, cloned without credentials, unless
 * `overrides` says otherwise. One given a GitHub login takes the GitHub provider.
 */
export function codingRepository(overrides: Partial<CodingRepository> = {}): CodingRepository {
  return {
    name: "shop",
    url: "https://github.com/acme/shop",
    default_branch: "main",
    remote_id: null,
    provider: overrides.connection_id ? "github" : null,
    connection_id: null,
    connection_status: null,
    connection_account: null,
    secret_id: null,
    username: null,
    ...overrides,
  };
}
