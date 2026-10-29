// The arguments the model sends a Studio tool.

/** The agent a Studio tool call names: the first non-blank of agent_id, agent, and agent_name. */
export function studioAgentHandleFromArgs(args: Record<string, unknown>): string {
  for (const key of ["agent_id", "agent", "agent_name"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}
