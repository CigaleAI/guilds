import { type ChangeActor, runActor } from "../lib/change-actor.js";
import { ScheduleError } from "../schedules/cron.js";
import { formatScheduleStamp, timingText } from "../schedules/item.js";
import { scheduleChanges } from "../schedules/service.js";
import { rowTiming } from "../schedules/timing.js";
import { argString, functionSchema } from "./schema.js";
import { identityOutput } from "./output.js";
import type { Tool, ToolContext, ToolInvocation } from "./types.js";

export const SCHEDULE_TOOLS = [
  "schedule_create_cron",
  "schedule_create_window",
  "schedule_list",
  "schedule_update",
  "schedule_pause",
  "schedule_resume",
  "schedule_delete",
] as const;

function schedules(ctx: ToolContext) {
  if (ctx.run_kind !== "direct" && ctx.run_kind !== "group") {
    throw new ScheduleError("schedule tools are only available in chat");
  }
  if (ctx.schedules === null) {
    throw new ScheduleError("schedules are not available");
  }
  return ctx.schedules;
}

/** The run making the call, as the routine's change log names it. */
function routineActor(ctx: ToolContext, call: ToolInvocation): ChangeActor {
  return runActor({ runId: ctx.run_id, agentName: ctx.agent_name }, { id: call.id, name: call.name });
}

/** What a new routine wakes on: a fixed UTC clock, or random times inside a daily window. */
type RoutineTiming = { cron?: unknown; window?: unknown };

async function publish(ctx: ToolContext, action: string, scheduleId: string): Promise<void> {
  if (ctx.group_chat !== null && ctx.guild_id && ctx.group_chat.publish) {
    await ctx.group_chat.publish(ctx.guild_id, "agent.routines.changed", {
      agent_id: ctx.agent_id,
      action,
      schedule_id: scheduleId,
    });
  }
}

async function createAndPublish(ctx: ToolContext, call: ToolInvocation, when: RoutineTiming): Promise<string> {
  const args = call.arguments;
  const row = await schedules(ctx).create(
    routineActor(ctx, call),
    ctx.agent_id,
    when,
    argString(args, "description"),
    argString(args, "instruction"),
  );
  await publish(ctx, "create", String(row.id));
  return `created ${row.id}  ${timingText(rowTiming(row))}\n${row.description}`;
}

const CRON_DESCRIPTION =
  "Create a repeating wake-up on a fixed UTC clock. Do not pass a window or random times; " +
  "use schedule_create_window for those. cron is a 5-field UTC expression " +
  "(minute hour day month weekday), for example '0 9 * * 1' or '*/30 * * * *'; consecutive " +
  "wake-ups must be at least 5 minutes apart. description is a one-line label for the " +
  "Routine tab and schedule_list. instruction is short markdown stored on the schedule row " +
  "and passed on the Schedule wake-up user message.";

const WINDOW_DESCRIPTION =
  "Create a repeating wake-up at random times inside a daily local-time window. Do not pass " +
  "a cron; use schedule_create_cron for a fixed UTC clock. timezone is an IANA name such as " +
  "Europe/Paris; ask when you do not know it. start and end are 24-hour HH:MM local times; " +
  "end before start spans midnight. max_wakes is the most wake-ups per window; actual times " +
  "and gaps vary, and gaps are at least 5 minutes. description is a one-line label for the " +
  "Routine tab and schedule_list. instruction is short markdown stored on the schedule row " +
  "and passed on the Schedule wake-up user message.";

export const scheduleCreateCron: Tool = {
  name: "schedule_create_cron",
  description: CRON_DESCRIPTION,
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "schedule_create_cron",
    CRON_DESCRIPTION,
    {
      cron: {
        type: "string",
        description: "5-field UTC expression: minute hour day month weekday, e.g. '0 9 * * 1'",
      },
      description: {
        type: "string",
        description: "one-line label for the Routine tab and schedule_list",
      },
      instruction: {
        type: "string",
        description: "short markdown for the Schedule wake-up user message",
      },
    },
    ["cron", "description", "instruction"],
  ),
  async handler(ctx, call) {
    return createAndPublish(ctx, call, { cron: call.arguments.cron });
  },
};

export const scheduleCreateWindow: Tool = {
  name: "schedule_create_window",
  description: WINDOW_DESCRIPTION,
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "schedule_create_window",
    WINDOW_DESCRIPTION,
    {
      timezone: { type: "string", description: "IANA name, e.g. Europe/Paris" },
      start: { type: "string", description: "HH:MM local time" },
      end: { type: "string", description: "HH:MM local time; earlier than start spans midnight" },
      max_wakes: {
        type: "integer",
        description: "most wake-ups per window; gaps are at least 5 minutes",
      },
      description: {
        type: "string",
        description: "one-line label for the Routine tab and schedule_list",
      },
      instruction: {
        type: "string",
        description: "short markdown for the Schedule wake-up user message",
      },
    },
    ["timezone", "start", "end", "max_wakes", "description", "instruction"],
  ),
  async handler(ctx, call) {
    const args = call.arguments;
    return createAndPublish(ctx, call, {
      window: {
        timezone: args.timezone,
        start: args.start,
        end: args.end,
        max_wakes: args.max_wakes,
      },
    });
  },
};

export const scheduleList: Tool = {
  name: "schedule_list",
  description:
    "List this agent's schedules, one-line descriptions, " + "and when each fires next (UTC).",
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "schedule_list",
    "List this agent's schedules, one-line descriptions, " + "and when each fires next (UTC).",
    {},
    [],
  ),
  async handler(ctx) {
    return schedules(ctx).listForAgent(ctx.agent_id);
  },
};

const UPDATE_DESCRIPTION =
  "Change one of this agent's schedules by id from schedule_list: a new timing, description, " +
  "or instruction. Pass only what changes; the rest stays. Pass cron or window, not both; a " +
  "new timing on a running schedule plans the next wake-up from now. Pausing and resuming " +
  "use schedule_pause and schedule_resume.";

export const scheduleUpdate: Tool = {
  name: "schedule_update",
  description: UPDATE_DESCRIPTION,
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "schedule_update",
    UPDATE_DESCRIPTION,
    {
      schedule_id: { type: "string" },
      cron: {
        type: "string",
        description: "new 5-field UTC expression: minute hour day month weekday, e.g. '0 9 * * 1'",
      },
      window: {
        type: "object",
        description: "new random wake-ups inside a daily local-time window",
        properties: {
          timezone: { type: "string", description: "IANA name, e.g. Europe/Paris" },
          start: { type: "string", description: "HH:MM local time" },
          end: { type: "string", description: "HH:MM local time; earlier than start spans midnight" },
          max_wakes: {
            type: "integer",
            description: "most wake-ups per window; gaps are at least 5 minutes",
          },
        },
        required: ["timezone", "start", "end", "max_wakes"],
        additionalProperties: false,
      },
      description: {
        type: "string",
        description: "new one-line label for the Routine tab and schedule_list",
      },
      instruction: {
        type: "string",
        description: "new short markdown for the Schedule wake-up user message",
      },
    },
    ["schedule_id"],
  ),
  async handler(ctx, call) {
    const args = call.arguments;
    const { cron, window, description, instruction } = args;
    const row = await schedules(ctx).update(
      routineActor(ctx, call),
      ctx.agent_id,
      argString(args, "schedule_id"),
      scheduleChanges({ cron, window, description, instruction }),
    );
    await publish(ctx, "edit", String(row.id));
    const next = row.paused ? "paused" : `next ${formatScheduleStamp(row.next_run_at)}`;
    return `updated ${row.id}  ${timingText(rowTiming(row))}  ${next}\n${row.description}`;
  },
};

export const schedulePause: Tool = {
  name: "schedule_pause",
  description: "Pause a schedule so it stops firing. Resume later with schedule_resume.",
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "schedule_pause",
    "Pause a schedule so it stops firing. Resume later with schedule_resume.",
    {
      schedule_id: { type: "string" },
    },
    ["schedule_id"],
  ),
  async handler(ctx, call) {
    const args = call.arguments;
    const row = await schedules(ctx).setPaused(
      routineActor(ctx, call),
      ctx.agent_id,
      argString(args, "schedule_id"),
      true,
    );
    await publish(ctx, "pause", String(row.id));
    return `paused ${row.id}`;
  },
};

export const scheduleResume: Tool = {
  name: "schedule_resume",
  description: "Resume a paused schedule. The next fire is recomputed from now.",
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "schedule_resume",
    "Resume a paused schedule. The next fire is recomputed from now.",
    {
      schedule_id: { type: "string" },
    },
    ["schedule_id"],
  ),
  async handler(ctx, call) {
    const args = call.arguments;
    const row = await schedules(ctx).setPaused(
      routineActor(ctx, call),
      ctx.agent_id,
      argString(args, "schedule_id"),
      false,
    );
    await publish(ctx, "resume", String(row.id));
    return `resumed ${row.id}  next ${formatScheduleStamp(row.next_run_at)}`;
  },
};

export const scheduleDelete: Tool = {
  name: "schedule_delete",
  description: "Delete one of this agent's schedules by id from schedule_list.",
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "schedule_delete",
    "Delete one of this agent's schedules by id from schedule_list.",
    {
      schedule_id: { type: "string" },
    },
    ["schedule_id"],
  ),
  async handler(ctx, call) {
    const args = call.arguments;
    const row = await schedules(ctx).delete(
      routineActor(ctx, call),
      ctx.agent_id,
      argString(args, "schedule_id"),
    );
    await publish(ctx, "delete", String(row.id));
    return `deleted ${row.id}`;
  },
};
