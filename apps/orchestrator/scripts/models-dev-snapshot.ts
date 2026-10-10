// Writes src/llm/models-dev.snapshot.json: the models.dev feed reduced to the hosted providers
// and the fields the catalog reads, keeping the rows the catalog keeps. The whole feed is never
// checked in. The snapshot serves the
// catalog on a box with no cache and no network.
//
//   pnpm --filter @guildsrun/orchestrator models:snapshot
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  MODELS_DEV_URL,
  keepModelsDevRow,
  projectModelsDevFeed,
  snapshotFileName,
  type ModelsDevFeed,
} from "../src/llm/models-dev.js";
import { PROVIDERS } from "../src/llm/providers.js";
import { orchestratorRoot } from "../src/lib/paths.js";

const url = process.argv[2] ?? MODELS_DEV_URL;
const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "guilds.run" } });
if (!response.ok) {
  throw new Error(`${url} answered ${response.status}`);
}
const ids = PROVIDERS.flatMap((provider) => (provider.modelsDev ? [provider.modelsDev] : []));
const projected = projectModelsDevFeed(await response.json(), ids);
const providers: ModelsDevFeed = {};
for (const [id, provider] of Object.entries(projected)) {
  providers[id] = {
    id,
    models: Object.fromEntries(Object.entries(provider.models).filter(([, row]) => keepModelsDevRow(row))),
  };
}
const snapshot = { fetched_at: new Date().toISOString().slice(0, 10), providers };
const target = path.join(orchestratorRoot(import.meta.url), "src/llm", snapshotFileName());
writeFileSync(target, `${JSON.stringify(snapshot)}\n`);
const count = Object.values(providers).reduce((sum, provider) => sum + Object.keys(provider.models).length, 0);
process.stdout.write(`wrote ${path.relative(process.cwd(), target)}: ${ids.length} providers, ${count} models\n`);
