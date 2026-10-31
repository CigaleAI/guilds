import type { AgentBrief } from "./agents";

/**
 * Shapes of the orchestrator's JSON API for routines, as the app reads them. Timestamps are
 * ISO-8601 in UTC.
 */

/** A daily random wake window, in local time of its time zone. */
export type WakeWindow = { timezone: string; start: string; end: string; max_wakes: number };

/** A routine: wakes its agent on a UTC cron expression or within a daily window. */
export type Schedule = {
  id: string;
  agent_id: string;
  cron: string | null;
  window: WakeWindow | null;
  /** The timing in words, such as "Every hour at :35". */
  label: string;
  /** The routine's description, or the first line of its instruction. */
  description: string;
  instruction: string;
  instruction_hash: string;
  paused: boolean;
  /** False while the guild's routines are off: the routine is held and does not fire. */
  guild_routines_enabled?: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
};

/** A new routine: exactly one of `cron` (UTC) or `window`. */
export type ScheduleInput =
  | { cron: string; description: string; instruction: string }
  | { window: WakeWindow; description: string; instruction: string };

/** A routine's new timing, description and instruction. */
export type ScheduleUpdate = { scheduleId: string; input: ScheduleInput };

/** A routine paused or resumed. */
export type SchedulePause = { scheduleId: string; paused: boolean };

/** A routine paused or resumed, with the agent it wakes. */
export type GuildSchedulePause = SchedulePause & { agentId: string };

/** A routine with the agent it wakes, as a guild lists them. */
export type GuildSchedule = Schedule & { agent: AgentBrief };
