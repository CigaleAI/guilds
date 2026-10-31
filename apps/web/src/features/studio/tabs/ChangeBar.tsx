import { LatestChange } from "../../notes/LatestChange";
import { useStudio } from "../StudioContext";

type ChangeBarProps = { displayPath: string };

/** Who changed a file last, and every change before, with run steps opened in Studio. */
export function ChangeBar({ displayPath }: ChangeBarProps) {
  const { openStep } = useStudio();
  return (
    <LatestChange
      displayPath={displayPath}
      onOpenStep={(change) =>
        openStep({
          agentId: change.run.agent_id,
          runId: change.run.id,
          call: change.tool?.call_id ?? null,
        })
      }
    />
  );
}
