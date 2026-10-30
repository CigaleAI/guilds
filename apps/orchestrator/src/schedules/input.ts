// A routine's timing and changes as a request or a tool call names them, decoded once at the
// boundary into these types. The decode checks each value's type; the domain validates what it says.

import { Type, type Static } from "@sinclair/typebox";

/** A random-wake window: when an agent may wake, in which timezone, and how often at most. */
export const WakeWindowInput = Type.Object({
  timezone: Type.String(),
  start: Type.String(),
  end: Type.String(),
  max_wakes: Type.Number(),
});

/** When a routine runs: a cron expression or a wake window; null is neither. */
export const RoutineTimingInput = Type.Object({
  cron: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  window: Type.Optional(Type.Union([WakeWindowInput, Type.Null()])),
});
export type RoutineTimingInput = Static<typeof RoutineTimingInput>;

/** A change to a routine: a new timing, description, instruction, or paused state; a field left out keeps its value. */
export const RoutineChangeInput = Type.Object({
  ...RoutineTimingInput.properties,
  description: Type.Optional(Type.String()),
  instruction: Type.Optional(Type.String()),
  paused: Type.Optional(Type.Boolean()),
});
export type RoutineChangeInput = Static<typeof RoutineChangeInput>;
