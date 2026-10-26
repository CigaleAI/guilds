import type { Adapter } from "../types.js";

// GitHub runs through GitHub's hosted endpoint. The State hook names the repositories the login
// picked, which are the only ones its tools reach, as the `owner` and `repo` those tools take.
const REPOSITORY_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

type PickedRepository = { owner: string; repo: string; default_branch: string };

function picked(settings: Readonly<Record<string, unknown>>): PickedRepository[] {
  const listed = Array.isArray(settings.repositories) ? (settings.repositories as Array<Record<string, unknown>>) : [];
  return listed.flatMap((item) => {
    const match = REPOSITORY_URL.exec(String(item.url ?? ""));
    return match ? [{ owner: match[1]!, repo: match[2]!, default_branch: String(item.default_branch ?? "") }] : [];
  });
}

const adapter: Adapter = {
  async state(_creds, ctx) {
    const repositories = picked(ctx.settings);
    return repositories.length ? repositories : null;
  },
};

export default adapter;
