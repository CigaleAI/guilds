# Add a routine

This page wakes the agent on a schedule, with no one posting.

You need the guild from [Your first guild](first-guild.md).

## 1. Create the routine

Click the agent in the sidebar. Open its **Routine** tab. Click
**New routine**. Fill in:

- **Timing**: **Cron**, with `*/5 * * * *`. That means every five
  minutes.
- **Description**: `Five-minute check`
- **Instruction**: `Say hello and tell me the time.`

The form shows the timing in words. Click **Add routine**.

You should see the routine listed, with its next wake-up time.

## 2. Watch it fire

Wait up to five minutes.

Open the agent's **Chat** tab. Click the clock on the tab strip. The
list of sessions opens. The newest run says a routine woke it. Click
it to read the reply.

## 3. Pause it

Go back to the **Routine** tab. Pause the routine. It stops waking
the agent until you resume it.

## Good to know

- Cron times are in UTC. The five fields are minute, hour, day,
  month, and weekday. Wake-ups must be at least five minutes apart.
- **Random window** wakes the agent at random times between two
  hours of the day, in your timezone, up to a number of times a day.
- **Edit routine**, under the selected routine, changes its timing,
  description, or instruction.
- The guild's **Routines** tab lists every routine in the guild. One
  switch there holds them all.

[Runs](../concepts/runs.md) explains what a routine run records.
