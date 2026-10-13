import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { writeLog } from "../observability/log.js";
import { agentDirectory } from "./index.js";

/**
 * The boot step that lays agent homes out by machine, before any generation starts: every
 * sandbox that ran one agent alone is destroyed, and an agent's folder at the workspace root
 * moves into its machine's directory, with its repositories, scripts, and browser profile.
 */
export async function layOutAgentHomes(services: {
  placements: () => Promise<Array<{ machineId: string; agentId: string }>>;
  workspaceRootFor: (machineId: string) => Promise<string>;
  destroyAgentSandboxes?: (() => Promise<number>) | undefined;
}): Promise<void> {
  if (services.destroyAgentSandboxes) {
    const destroyed = await services.destroyAgentSandboxes();
    if (destroyed) {
      writeLog("info", `${destroyed} agent sandboxes destroyed`, { operation: "machines.layout" });
    }
  }
  for (const { machineId, agentId } of await services.placements()) {
    const root = await services.workspaceRootFor(machineId);
    const source = path.join(root, agentId);
    const target = agentDirectory(root, machineId, agentId);
    if (!existsSync(source) || existsSync(target)) {
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    renameSync(source, target);
    writeLog("info", "agent home moved to its machine", {
      operation: "machines.layout",
      agent_id: agentId,
      machine_id: machineId,
    });
  }
}
