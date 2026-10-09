import type { StudioMessage } from "../../api/types";
import type { RunMessage } from "../agent/runs/runFlowModel";

/** A coach conversation as run rows, so the run flow model groups its steps and tool calls. */
export function asRunMessages(
  messages: readonly StudioMessage[],
): (StudioMessage & RunMessage & { metadata: Record<string, unknown> })[] {
  return messages.map((message) => ({
    ...message,
    metadata: { ...(message.metadata ?? {}), generation: message.generation },
  }));
}

/** A coach's request counts as answered once the operator wrote after it. */
export function answered(
  messages: readonly Pick<StudioMessage, "seq" | "payload">[],
  seq: number,
): boolean {
  return messages.some((message) => message.seq > seq && message.payload.role === "user");
}
