import { loadToolConfig } from "../src/config/index.js";
import { startErrorReporting } from "../src/error-reporting.js";
import { connect } from "../src/seed/connect.js";
import { applyWorkspaceSweep, parseSweepArgs, planWorkspaceSweep } from "../src/sandbox/sweep.js";
import { listMachineIds, listMachinePlacements } from "../src/db/machines.js";

startErrorReporting();
const args = parseSweepArgs(process.argv.slice(2));
const config = loadToolConfig();
const database = await connect(config.databaseUrl);
try {
  const db = database.pool;
  const machines = new Map<string, Set<string>>();
  for (const machineId of await listMachineIds(db)) {
    machines.set(machineId, new Set());
  }
  for (const { machineId, agentId } of await listMachinePlacements(db)) {
    machines.get(machineId)?.add(agentId);
  }
  const planned = planWorkspaceSweep(config.workspaceRoot, machines, args.ageDays);
  if (!planned.length) {
    process.stdout.write("sweep-workspaces: no orphans\n");
  } else {
    for (const entry of planned) {
      const action = args.apply ? "removed" : "would remove";
      process.stdout.write(
        `${action} ${entry.path} (${entry.agentId ? `agent ${entry.agentId} on ` : ""}machine ${entry.machineId}, age ${entry.ageDays}d)\n`,
      );
    }
    if (args.apply) {
      applyWorkspaceSweep(planned);
    }
  }
} finally {
  await database.close();
}
