import type { ChangeActor } from "../db/config-changes.js";

/** A person acting through the app or the API. */
export function userActor(user: Record<string, unknown>): ChangeActor {
  return {
    actorType: "user",
    actorId: String(user.id),
    actorName: String(user.name ?? "operator"),
    toolCall: null,
  };
}

/** An agent's run acting through one of its tool calls. */
export function runActor(
  run: { runId: string; agentName: string },
  toolCall: { id: string; name: string },
): ChangeActor {
  return { actorType: "run", actorId: run.runId, actorName: run.agentName, toolCall };
}
