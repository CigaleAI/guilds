import { loadToolConfig } from "../src/config/index.js";
import { connect } from "../src/db/client.js";
import { Repositories } from "../src/db/repositories.js";
import { applyWorkspaceSweep, parseSweepArgs, planWorkspaceSweep } from "../src/sandbox/sweep.js";

const args = parseSweepArgs(process.argv.slice(2));
const config = loadToolConfig();
const database = await connect(config.databaseUrl);
try {
  const repo = new Repositories(database.pool);
  const liveAgentIds = new Set(await repo.listAgentIds());
  const planned = planWorkspaceSweep(config.workspaceRoot, liveAgentIds, args.ageDays);
  if (!planned.length) {
    process.stdout.write("sweep-workspaces: no orphans\n");
  } else {
    for (const entry of planned) {
      const action = args.apply ? "removed" : "would remove";
      process.stdout.write(
        `${action} ${entry.path} (agent ${entry.agentId}, age ${entry.ageDays}d)\n`,
      );
    }
    if (args.apply) {
      applyWorkspaceSweep(planned);
    }
  }
} finally {
  await database.close();
}
