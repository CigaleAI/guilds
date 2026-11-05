import { AlarmClock } from "lucide-react";
import type { Run } from "../../../api/types/runs";
import { Banner, Button } from "@guildsrun/ui";
import { pendingWakeNote, pendingWakeTitle } from "./wakeUp";

type PendingWakeBannerProps = {
  run: Run;
  /** The cancel is on its way. */
  cancelling: boolean;
  onCancel: () => void;
};

/** The run's pending wake-up under the transcript: when it is due, its note, and Cancel; nothing without one. */
export function PendingWakeBanner({ run, cancelling, onCancel }: PendingWakeBannerProps) {
  const wake = run.pending_wake ?? null;
  if (wake === null) return null;
  return (
    <Banner
      tone="info"
      icon={AlarmClock}
      title={pendingWakeTitle(wake)}
      className="mx-auto w-full max-w-240"
      action={
        <Button variant="outline" size="sm" disabled={cancelling} onClick={onCancel}>
          Cancel
        </Button>
      }
    >
      {pendingWakeNote(wake)}
    </Banner>
  );
}
