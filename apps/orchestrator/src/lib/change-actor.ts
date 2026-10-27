/** The coach message an operator applied a change from: its Studio session and sequence. */
export type StudioOrigin = { sessionId: string; seq: number };

/**
 * Who made a change: a person, an agent, or an agent's run, with the tool
 * call that carried it and, for an edit applied in the Studio, its coach message.
 */
export type ChangeActor = {
  actorType: "user" | "agent" | "run";
  actorId: string;
  actorName: string;
  toolCall: { id: string; name: string } | null;
  studio?: StudioOrigin;
};

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
