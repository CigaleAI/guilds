# Add a routine

This page wakes the agent on a schedule, with no one posting.

You need the guild from [Your first guild](first-guild.md).

## 1. Create the routine

Click the agent in the sidebar. Open its **Routine** tab. Click
**New routine**. Fill in:

- **Timing**: **Cron**. Type `*/5 * * * *` as the **Cron expression**.
  That means every five minutes.
- **Description**: `Five-minute check`
- **Instruction**: `Say hello and tell me the time.`

The form shows the timing in words. Click **Add routine**.

You should see the routine in the list, with its next wake-up time.
Its details show beside the list.

## 2. Watch it fire

Wait up to five minutes.

In the routine's details, **Last wake** shows a time, and
**Wake-ups** counts one. Click the **Last wake** time. The agent's
**Chat** tab opens on the run the routine started. Read the reply
there.

## 3. Pause it

Go back to the **Routine** tab. Turn off the switch on the routine's
row. The row is tagged **paused**. The routine stops waking the
agent until you turn the switch back on.

## Good to know

- Cron times are in UTC. The five fields are minute, hour, day,
  month, and weekday. Wake-ups must be at least five minutes apart.
- **Random window** wakes the agent at random times between two
  hours of the day, in the timezone you pick, up to a number of
  times a day.
- **Edit routine**, under the selected routine, changes its timing,
  description, or instruction.
- The guild's **Routines** tab lists every routine in the guild. One
  switch there holds them all.

[Runs](../concepts/runs.md) explains what a routine run records.
