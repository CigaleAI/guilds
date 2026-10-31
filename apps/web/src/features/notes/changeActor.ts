import type { FileChange } from "../../api/types/notes";
import type { ChangeActor } from "@guildsrun/ui";

const runTrigger: Record<string, string> = {
  direct: "direct session",
  group: "group chat",
  schedule: "routine wake-up",
};

/** The run that made a recorded change: its id, what woke it, and the tool it changed it with. */
function runActor(change: FileChange): ChangeActor {
  const runId = change.run?.id ?? change.actor.id ?? "";
  const trigger = change.run ? runTrigger[change.run.kind] : undefined;
  return {
    kind: "run",
    runId,
    ...(trigger ? { trigger } : {}),
    ...(change.tool?.name ? { tool: change.tool.name } : {}),
  };
}

/** Who made a recorded change, as the version strip names them. */
export function changeActor(change: FileChange): ChangeActor {
  if (change.actor.type === "run") return runActor(change);
  if (change.actor.type === "agent")
    return { kind: "agent", name: change.actor.name ?? "an agent" };
  return { kind: "user", name: change.actor.name ?? "someone" };
}
