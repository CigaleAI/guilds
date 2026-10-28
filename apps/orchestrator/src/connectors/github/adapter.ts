import type { ConnectionSettings } from "../../db/schema/index.js";
import type { Adapter } from "../types.js";

// GitHub runs through GitHub's hosted endpoint. The State hook names the repositories the login
// picked, which are the only ones its tools reach, as the `owner` and `repo` those tools take.
const REPOSITORY_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

type PickedRepository = { owner: string; repo: string; default_branch: string };

function picked(settings: Readonly<ConnectionSettings>): PickedRepository[] {
  return (settings.repositories ?? []).flatMap((item) => {
    const match = REPOSITORY_URL.exec(item.url);
    return match ? [{ owner: match[1]!, repo: match[2]!, default_branch: item.default_branch }] : [];
  });
}

const adapter: Adapter = {
  async state(_creds, ctx) {
    const repositories = picked(ctx.settings);
    return repositories.length ? repositories : null;
  },
};

export default adapter;
