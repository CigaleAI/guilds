import { useState, type FormEvent } from "react";
import { useCreateSchedule } from "../../../api/queries";
import type { ScheduleInput, WakeWindow } from "../../../api/types";
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
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Adds a routine: a UTC cron expression or a daily random window, and what to do on each wake-up. */
export function RoutineForm({ agentId, agentName, open, onOpenChange }: RoutineFormProps) {
  const { user } = useIdentity();
  const create = useCreateSchedule(agentId);
  const [mode, setMode] = useState<Mode>("cron");
  const [cron, setCron] = useState("");
  const [wakeWindow, setWakeWindow] = useState<WakeWindow>(() => ({
    timezone: localTimezone(user.timezone),
    start: "08:00",
    end: "20:00",
    max_wakes: 10,
  }));
  const [description, setDescription] = useState("");
  const [instruction, setInstruction] = useState("");

  const reset = () => {
    setMode("cron");
    setCron("");
    setWakeWindow({
      timezone: localTimezone(user.timezone),
      start: "08:00",
      end: "20:00",
      max_wakes: 10,
    });
    setDescription("");
    setInstruction("");
    create.reset();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input: ScheduleInput =
      mode === "cron"
        ? { cron: cron.trim(), description, instruction }
        : { window: wakeWindow, description, instruction };
    create.mutate(input, {
      onSuccess: (routine) => {
        toast({ kind: "success", title: "Routine added", description: routine.label });
        reset();
        onOpenChange(false);
      },
    });
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
            title="New routine"
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
            {create.isError ? (
              <Banner tone="error" title="Couldn't add the routine">
                {create.error.message}
              </Banner>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Adding…" : "Add routine"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
