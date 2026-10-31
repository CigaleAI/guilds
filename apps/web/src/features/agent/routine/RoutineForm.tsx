import { useState, type FormEvent } from "react";
import { useCreateSchedule, useUpdateSchedule } from "../../../api/queries/schedules";
import type { Schedule, ScheduleInput, WakeWindow } from "../../../api/types/schedules";
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

/** A routine as the form edits it: both timings are kept while the operator switches between them. */
export type RoutineDraft = {
  mode: Mode;
  cron: string;
  window: WakeWindow;
  description: string;
  instruction: string;
};

/** A routine's fields in the form; a new routine's start on a cron, with a daytime window in `timezone`. */
export function routineDraft(routine: Schedule | undefined, timezone: string | null): RoutineDraft {
  return {
    mode: routine?.window ? "window" : "cron",
    cron: routine?.cron ?? "",
    window: routine?.window ?? {
      timezone: localTimezone(timezone),
      start: "08:00",
      end: "20:00",
      max_wakes: 10,
    },
    description: routine?.description ?? "",
    instruction: routine?.instruction ?? "",
  };
}

/** What the form saves: the timing its mode picks, the description and the instruction. */
export function scheduleInput(draft: RoutineDraft): ScheduleInput {
  const { description, instruction } = draft;
  return draft.mode === "cron"
    ? { cron: draft.cron.trim(), description, instruction }
    : { window: draft.window, description, instruction };
}

/** The draft's timing in words, as the server will label it; null before a cron is typed. */
export function timingNote(draft: RoutineDraft): string | null {
  if (draft.mode === "window") return describeWindow(draft.window);
  const cron = draft.cron.trim();
  return cron ? describeCron(cron) : null;
}

/** The form's words for adding a routine and for editing one. */
const FORM_COPY = Object.freeze({
  add: {
    title: "New routine",
    submit: "Add routine",
    pending: "Adding…",
    done: "Routine added",
    failed: "Couldn't add the routine",
  },
  edit: {
    title: "Edit routine",
    submit: "Save routine",
    pending: "Saving…",
    done: "Routine saved",
    failed: "Couldn't save the routine",
  },
});

type WindowFieldsProps = {
  value: WakeWindow;
  /** The window in words. */
  timing: string | null;
  onChange: (next: WakeWindow) => void;
};

/** A daily random window: its span, how many times it may wake the agent, and its timezone. */
function WindowFields({ value, timing, onChange }: WindowFieldsProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <TextField
        tone="surface"
        label="From"
        type="time"
        required
        value={value.start}
        onChange={(event) => onChange({ ...value, start: event.currentTarget.value })}
      />
      <TextField
        tone="surface"
        label="To"
        type="time"
        required
        value={value.end}
        onChange={(event) => onChange({ ...value, end: event.currentTarget.value })}
      />
      <TextField
        tone="surface"
        label="Most wake-ups a day"
        type="number"
        min={1}
        step={1}
        required
        value={String(value.max_wakes)}
        onChange={(event) => onChange({ ...value, max_wakes: Number(event.currentTarget.value) })}
      />
      <TextField
        tone="surface"
        label="Timezone"
        required
        list="routine-timezones"
        value={value.timezone}
        onChange={(event) => onChange({ ...value, timezone: event.currentTarget.value })}
      />
      <datalist id="routine-timezones">
        {timezones.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
      <p className="col-span-2 text-sm text-muted">{timing}</p>
    </div>
  );
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
  const copy = FORM_COPY[routine ? "edit" : "add"];
  const [draft, setDraft] = useState(() => routineDraft(routine, user.timezone));

  const reset = () => {
    setDraft(routineDraft(routine, user.timezone));
    create.reset();
    update.reset();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = scheduleInput(draft);
    const done = (saved: Schedule) => {
      toast({ kind: "success", title: copy.done, description: saved.label });
      reset();
      onOpenChange(false);
    };
    if (routine) {
      update.mutate({ scheduleId: routine.id, input }, { onSuccess: done });
    } else {
      create.mutate(input, { onSuccess: done });
    }
  };

  const timing = timingNote(draft);

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
            title={copy.title}
            description={`Wakes ${agentName} on a schedule with an instruction.`}
          />
          <DialogBody>
            <Segmented
              label="Timing"
              value={draft.mode}
              onValueChange={(mode) => setDraft({ ...draft, mode })}
              options={[
                { value: "cron", label: "Cron" },
                { value: "window", label: "Random window" },
              ]}
            />
            {draft.mode === "cron" ? (
              <TextField
                tone="surface"
                label="Cron expression"
                aside="UTC"
                mono
                required
                value={draft.cron}
                onChange={(event) => setDraft({ ...draft, cron: event.currentTarget.value })}
                placeholder="0 9 * * 1"
                hint={timing ?? "minute hour day month weekday · at least 5 minutes apart"}
              />
            ) : (
              <WindowFields
                value={draft.window}
                timing={timing}
                onChange={(next) => setDraft({ ...draft, window: next })}
              />
            )}
            <TextField
              tone="surface"
              label="Description"
              required
              maxLength={descriptionMax}
              showCount
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.currentTarget.value })}
              placeholder="One-line label"
            />
            <TextAreaField
              tone="surface"
              label="Instruction"
              required
              rows={5}
              maxLength={instructionMax}
              showCount
              value={draft.instruction}
              onChange={(event) => setDraft({ ...draft, instruction: event.currentTarget.value })}
              placeholder="What to do on this wake-up"
              hint="Sent to the agent as the wake-up message."
            />
            {save.isError ? (
              <Banner tone="error" title={copy.failed}>
                {save.error.message}
              </Banner>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? copy.pending : copy.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
