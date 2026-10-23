import { useState, type FormEvent } from "react";
import { useCreateSchedule, useUpdateSchedule } from "../../../api/queries";
import type { Schedule, ScheduleInput, WakeWindow } from "../../../api/types";
import { useIdentity } from "../../../app/identity";
import {
  Button,
  Segmented,
  TextAreaField,
  TextField,
  Banner,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  toast,
} from "@guildsrun/ui";
import { describeCron, describeWindow } from "./describeTiming";

type Mode = "cron" | "window";

/** The server's limits on a routine's text. */
const descriptionMax = 400;
const instructionMax = 2000;

const timezones = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== "UTC")];

function localTimezone(preferred: string | null): string {
  return preferred || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

type RoutineFormProps = {
  agentId: string;
  agentName: string;
  /** The routine to edit; without one, the form adds a new routine. */
  routine?: Schedule;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Adds or edits a routine: a UTC cron expression or a daily random window, and what to do on each
 * wake-up.
 */
export function RoutineForm({ agentId, agentName, routine, open, onOpenChange }: RoutineFormProps) {
  const { user } = useIdentity();
  const create = useCreateSchedule(agentId);
  const update = useUpdateSchedule(agentId);
  const save = routine ? update : create;
  const defaultWindow = (): WakeWindow =>
    routine?.window ?? {
      timezone: localTimezone(user.timezone),
      start: "08:00",
      end: "20:00",
      max_wakes: 10,
    };
  const [mode, setMode] = useState<Mode>(routine?.window ? "window" : "cron");
  const [cron, setCron] = useState(routine?.cron ?? "");
  const [wakeWindow, setWakeWindow] = useState<WakeWindow>(defaultWindow);
  const [description, setDescription] = useState(routine?.description ?? "");
  const [instruction, setInstruction] = useState(routine?.instruction ?? "");

  const reset = () => {
    setMode(routine?.window ? "window" : "cron");
    setCron(routine?.cron ?? "");
    setWakeWindow(defaultWindow());
    setDescription(routine?.description ?? "");
    setInstruction(routine?.instruction ?? "");
    create.reset();
    update.reset();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input: ScheduleInput =
      mode === "cron"
        ? { cron: cron.trim(), description, instruction }
        : { window: wakeWindow, description, instruction };
    const done = (saved: Schedule) => {
      toast({
        kind: "success",
        title: routine ? "Routine saved" : "Routine added",
        description: saved.label,
      });
      reset();
      onOpenChange(false);
    };
    if (routine) {
      update.mutate({ scheduleId: routine.id, input }, { onSuccess: done });
    } else {
      create.mutate(input, { onSuccess: done });
    }
  };

  const timing =
    mode === "cron" ? (cron.trim() ? describeCron(cron.trim()) : null) : describeWindow(wakeWindow);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent size="md">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader
            title={routine ? "Edit routine" : "New routine"}
            description={`Wakes ${agentName} on a schedule with an instruction.`}
          />
          <DialogBody>
            <Segmented
              label="Timing"
              value={mode}
              onValueChange={setMode}
              options={[
                { value: "cron", label: "Cron" },
                { value: "window", label: "Random window" },
              ]}
            />
            {mode === "cron" ? (
              <TextField
                tone="surface"
                label="Cron expression"
                aside="UTC"
                mono
                required
                value={cron}
                onChange={(event) => setCron(event.currentTarget.value)}
                placeholder="0 9 * * 1"
                hint={timing ?? "minute hour day month weekday · at least 5 minutes apart"}
              />
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <TextField
                  tone="surface"
                  label="From"
                  type="time"
                  required
                  value={wakeWindow.start}
                  onChange={(event) =>
                    setWakeWindow({ ...wakeWindow, start: event.currentTarget.value })
                  }
                />
                <TextField
                  tone="surface"
                  label="To"
                  type="time"
                  required
                  value={wakeWindow.end}
                  onChange={(event) =>
                    setWakeWindow({ ...wakeWindow, end: event.currentTarget.value })
                  }
                />
                <TextField
                  tone="surface"
                  label="Most wake-ups a day"
                  type="number"
                  min={1}
                  step={1}
                  required
                  value={String(wakeWindow.max_wakes)}
                  onChange={(event) =>
                    setWakeWindow({ ...wakeWindow, max_wakes: Number(event.currentTarget.value) })
                  }
                />
                <TextField
                  tone="surface"
                  label="Timezone"
                  required
                  list="routine-timezones"
                  value={wakeWindow.timezone}
                  onChange={(event) =>
                    setWakeWindow({ ...wakeWindow, timezone: event.currentTarget.value })
                  }
                />
                <datalist id="routine-timezones">
                  {timezones.map((zone) => (
                    <option key={zone} value={zone} />
                  ))}
                </datalist>
                <p className="col-span-2 text-sm text-muted">{timing}</p>
              </div>
            )}
            <TextField
              tone="surface"
              label="Description"
              required
              maxLength={descriptionMax}
              showCount
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
              placeholder="One-line label"
            />
            <TextAreaField
              tone="surface"
              label="Instruction"
              required
              rows={5}
              maxLength={instructionMax}
              showCount
              value={instruction}
              onChange={(event) => setInstruction(event.currentTarget.value)}
              placeholder="What to do on this wake-up"
              hint="Sent to the agent as the wake-up message."
            />
            {save.isError ? (
              <Banner
                tone="error"
                title={routine ? "Couldn't save the routine" : "Couldn't add the routine"}
              >
                {save.error.message}
              </Banner>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={save.isPending}>
              {routine
                ? save.isPending
                  ? "Saving…"
                  : "Save routine"
                : save.isPending
                  ? "Adding…"
                  : "Add routine"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
