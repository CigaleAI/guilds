# Routines

A routine wakes an [agent](agents.md) on a schedule, with no one
posting. Each routine has a timing, a one-line description, and a
short instruction. When it comes due, the agent gets a one-shot
[run](runs.md) that hands it the instruction.

A routine belongs to one agent. An agent may have several. The
[guild](guilds.md) has one switch that holds every routine of its
agents at once.

## When you use it

Use a routine for work that should happen on its own: a morning
digest, an hourly check of a source, a weekly clean-up. Use a random
window when the wake-ups should not look mechanical, for example a
few posts spread over the working day.

A routine can be set up four ways: the operator adds it on the
agent's **Routine** tab, asks the agent to set one up in a direct
chat or in the group chat (the agent then uses its schedule tools),
or applies a [Prompt Studio](prompt-studio.md) coach's proposal to
create one ([Studio proposals](studio-proposals.md)).

Only a coach proposal changes a routine's timing, description, or
instruction. The Routine tab, the agent's schedule tools, and the
HTTP routes create, pause, resume, and delete.

## How it works

### Timing

A routine has one of two timings:

- **Cron**: a five-field expression (minute, hour, day, month,
  weekday), always in UTC. When it is saved, its next two wake-ups
  must be at least five minutes apart.
- **Random window**: every day between two times of day, in a chosen
  timezone, the agent wakes at random moments, up to a number of
  times a day. The timezone follows daylight saving. A window whose
  end is before its start spans midnight.

A random window plans one wake-up at a time. The first lands somewhere
in the window's first slot (the window split into as many slots as
wake-ups). After each wake-up, the next gap is roughly the time left
divided by the wake-ups left, give or take half. Gaps are never under
five minutes. When the window is spent, the plan moves to the next
day's window. The number of wake-ups is a ceiling: a day usually gets
one or two fewer.

### The ticker

Every 30 seconds the orchestrator looks for routines that are due,
not paused, and in a guild whose routines are on. For each, it starts
a run for the agent.

If the agent is busy with any other run, including a group-chat
delivery, the routine is skipped for this tick and stays due. The next
tick tries again. Nothing piles up: a due routine is one due routine,
however long it waits.

Every other outcome moves the routine on to its next planned wake-up
and records the fire as its last wake, even when no run could be
created (broken prompts, an unusable agent). So one broken agent does
not retry in a tight loop.

### Pausing

Each routine can be paused on its own. A paused routine never fires.
Resuming plans its next wake-up from now.

The guild's routine switch holds every routine of the guild. While it
is off, the ticker skips them all. Turning it back on plans the next
wake-up from now for each unpaused routine that is already due.
Missed wake-ups are not replayed.

A recipe apply creates its routines paused. While the apply's
checklist is open, the guild says so ([Applying recipes](applying-recipes.md)).

### What the agent receives

The run opens with the agent's usual system prompt, then one
**Schedule wake-up** message. It carries the routine's id, its timing,
its instruction, and when the routine last fired. A routine that reads
new records can pass that last time as `since` to `record_list`, so
each wake-up handles only what is new ([Collections](collections.md)).

With Memory on, the agent may update its
[Memory](memory.md#when-the-agent-writes) before the run ends. The run
then completes and takes no further messages, unless the operator
resumes it ([Runs](runs.md#cancel-interrupt-resume)).

## In the app

### Routine tab

An agent's **Routine** tab lists its routines. A line says that cron
wake-ups run in UTC and random windows run in their own timezone.

- Each routine shows its timing (a cron, or a window with its span,
  count, and timezone), its description, and its state: next wake,
  paused, or held.
- Selecting one shows it in full: the timing in words, **Next wake**,
  **Last wake** (a link to that run), the number of wake-ups so far,
  when it was added, and the instruction.
- A switch on each row pauses and resumes it.
- **Delete routine** asks first. Past wake-ups stay in the Chat tab's
  **History**.
- **New routine** opens a form: **Timing** is **Cron** (UTC) or
  **Random window** (**From**, **To**, **Most wake-ups a day**, and a
  **Timezone** pre-filled from the operator's profile). Then
  **Description** and **Instruction**. The form previews the timing in
  words.
- With no routine yet, the tab invites the operator to add one or to
  ask the agent in chat.
- While the guild's routines are off, a banner says that the wake-ups
  are held and links to the guild's Routines tab. Routines that are
  not paused on their own show as held and do not fire.

The Chat tab's **History** lists each routine run as a schedule
wake-up ([Runs](runs.md#in-the-app)), and its
[transcript](run-transcript.md) shows the wake-up message.

### Guild Routines tab

The guild's **Routines** tab lists every routine in the guild, grouped
by agent. Within an agent, running routines come first, soonest wake
first, then paused ones. Each agent's name opens its Routine tab.

- A switch, **Routines on** or **Routines off**, holds every wake-up
  in the guild. Its line says that turning it back on plans missed
  ones from now. A count beside it reads, for example, "3 active · 1
  paused", or "3 held · 1 paused" while the switch is off.
- Each routine row has its own pause switch.
- Routines are added and deleted from the agent's Routine tab.

While the switch is off, the guild header shows a **Routines off**
chip. The guild **Settings** tab edits the same switch
([Guilds](guilds.md)).

## Rules and limits

| Rule | Value or behaviour |
| --- | --- |
| Timing | exactly one of cron or random window |
| Cron | five fields, UTC; at save, the next two wake-ups at least 5 minutes apart |
| Window times | 24-hour `HH:MM`; start and end must differ |
| Window timezone | an IANA name, such as `Europe/Paris` |
| Wake-ups a day | positive; must leave at least 5 minutes per wake-up |
| Description | non-empty, collapsed to one line, at most 400 characters |
| Instruction | non-empty Markdown, trimmed, at most 2000 characters |
| Ticker | every 30 seconds |
| Busy agent | skipped this tick, stays due |
| Any other outcome, a failed create included | moves to the next planned wake-up and sets the last wake |
| Guild switch | on by default; off holds every routine |
| Missed wake-ups | never replayed |
| Run | one-shot; completes after its generation |

## Reference

### Schedule row

A routine is a row of `schedules`:

| Column | Holds |
| --- | --- |
| `id` | `sch_…` |
| `agent_id` | the agent; deleting the agent deletes its schedules |
| `cron` | the 5-field UTC expression, or null |
| `wake_window` | the random window, or null; exactly one of `cron` and `wake_window` is set |
| `description` | the one-line description |
| `instruction` | the Markdown instruction |
| `paused` | the routine's own pause |
| `next_run_at` | the planned wake-up |
| `last_run_at` | the last fire, or null |
| `window_fires` | fires so far in the window that holds `next_run_at` |
| `created_at`, `updated_at` | timestamps |

The guild switch is `guilds.routines_enabled` (default true). The
ticker fires rows with `next_run_at <= now`, `paused = false`, and
`routines_enabled` on the guild.

### Random window

`wake_window` is `{ timezone, start, end, max_wakes }`, with no other
field. `start` and `end` are 24-hour `HH:MM` local times in
`timezone`. `max_wakes` must be at most the window's span divided by
5 minutes.

Wake-ups are planned one at a time
(`apps/orchestrator/src/schedules/window.ts`):

- The first wake-up of a window lands uniformly in its first slot,
  `(end - start) / max_wakes`.
- After each fire inside a window, the mean gap is the time left in
  the window divided by the wake-ups left (`max_wakes -
  window_fires`). The next gap is drawn uniformly between 0.5× and
  1.5× that mean, never under 5 minutes.
- A gap that reaches the window's end, or a spent window, moves to the
  first slot of the next window.

`window_fires` counts fires in the window that holds `next_run_at`. A
late fire outside any window does not count. Create, resume, a new
timing, and a guild re-enable start the count at 0.

### Changing a routine

A change replaces the routine's timing, description, instruction, or
pause; what it leaves out stays. A new timing on an unpaused routine,
or a resume, plans the next wake-up from now. Any other change keeps
the planned wake-up. Runs that already fired keep the instruction they
fired with.

### Firing

`fireDueSchedules` (`apps/orchestrator/src/generation/index.ts`) runs
on the 30-second tick (`SCHEDULER_TICK_MS`). It skips a busy agent and
does not advance `next_run_at`, so the routine is delayed, not queued
as a second job and not skipped forever. Every other outcome, a failed
create (bad prompts, bad config) included, sets `last_run_at` to the
tick and `next_run_at` to the next planned wake-up.

A schedule-triggered run uses the composed system row, then one user
message:

```text
Schedule wake-up: {
  id, cron | window, instruction, previous_run_at
}
```

`instruction` is the Markdown on the schedule row. `previous_run_at`
is the schedule's `last_run_at` at the moment it fires, null on the
first wake.

The run records the routine on `runs.schedule_id`. Its metadata
carries `instruction_hash`, the hash of the instruction it fired
with. Run views expose both, so a routine's runs can be listed and a
run that fired with an older instruction can be told apart.

Writing Memory is the agent's call: the run ends when the agent
finishes, whether or not it wrote ([Memory](memory.md#when-the-agent-writes)).

Schedule runs do not offer the schedule tools or `secret_request`.

### Tools

Direct and group-chat runs offer six schedule tools:
`schedule_create_cron`, `schedule_create_window`, `schedule_list`,
`schedule_pause`, `schedule_resume`, and `schedule_delete`
([Native tools](../tools-and-connectors/native.md)).

The Studio coach reads routines with `studio_list_routines` and
proposes changes with `studio_create_routine` (which can create a
routine paused), `studio_edit_routine`, and `studio_delete_routine`.
A proposal writes nothing until the operator applies it
([Studio proposals](studio-proposals.md)).

### HTTP

| Route | Does | Success | Refusals |
| --- | --- | --- | --- |
| `GET /api/agents/:id/schedules` | the agent's schedules | 200 | 404 |
| `POST /api/agents/:id/schedules` | creates one from `cron` or `window`, `description`, `instruction` | 201 | 422 missing `description` or `instruction`, or an invalid timing, description, or instruction; 404 |
| `PATCH /api/agents/:id/schedules/:schedule_id` | sets `paused` | 200 | 404 |
| `DELETE /api/agents/:id/schedules/:schedule_id` | deletes one | 204 | 404 |
| `GET /api/guilds/:id/schedules` | every schedule in the guild, with its agent | 200 | |
| `PUT /api/guilds/:id` | `routines_enabled` switches the guild's routines ([Guilds](guilds.md)) | 200 | |

A schedule item carries `id`, `agent_id`, `cron`, `window`, `label`
(the timing in words), `description`, `instruction`,
`instruction_hash`, `paused`, `next_run_at`, `last_run_at`,
`created_at`, `updated_at`, and on guild listings
`guild_routines_enabled` and the `agent`. Each change publishes
`agent.routines.changed` on the guild's stream.

### Code

- `apps/orchestrator/src/schedules/`: cron, random window, timing
  labels, instruction, and `Schedules.update`
- `apps/orchestrator/src/generation/`: the busy lock,
  `fireDueSchedules`, `deliverScheduleRun`
- `apps/orchestrator/src/toolbox/schedule.ts`: the schedule tools
- `apps/web/src/features/agent/routine/`: the Routine tab
