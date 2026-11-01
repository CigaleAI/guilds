import type { CodingRepository } from "../../src/coding/repositories.js";

/** A repository as a coding run clones it: `shop` on GitHub, cloned without a login, unless `overrides` says otherwise. */
export function codingRepository(overrides: Partial<CodingRepository> = {}): CodingRepository {
  return {
    name: "shop",
    url: "https://github.com/acme/shop",
    default_branch: "main",
    github_id: null,
    connection_id: null,
    connection_status: null,
    connection_account: null,
    ...overrides,
  };
}
