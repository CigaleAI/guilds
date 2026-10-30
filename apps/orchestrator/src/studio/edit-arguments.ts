// The arguments of the Studio edit tools: what the model is offered and sends, decoded when the
// tool runs and again from the recorded call when the operator reviews or applies the proposal.

import { Type, type Static } from "@sinclair/typebox";
import { AGENT_ROW_MODES, GUILD_ROW_MODES } from "../artifacts/access-lists.js";
import { ARTIFACT_LEVELS } from "../artifacts/types.js";
import { EDIT_ACTIONS } from "./actions.js";
import { studioChoice, studioMap } from "./arguments.js";

const ACTION = studioChoice(EDIT_ACTIONS, { description: "Required." });

const REASON = Type.String({ description: "Why this change, one or two sentences, citing evidence. Required." });

export const EditMemoryArguments = Type.Object({
  agent_id: Type.String({ description: "Source-guild agent id or name. Required." }),
  content: Type.String({ description: "Complete proposed Memory, not a description of changes. Required." }),
  base_version: Type.Integer({ description: "Memory version the proposal was built from. Required." }),
  reason: Type.String({ description: "Why this edit, one or two sentences, citing evidence. Required." }),
});
export type EditMemoryArguments = Static<typeof EditMemoryArguments>;

export const EditGuildArguments = Type.Object({
  about: Type.Optional(Type.String({ description: "Complete proposed about line." })),
  description: Type.Optional(Type.String({ description: "Complete proposed description." })),
  reason: Type.String({ description: "Why this edit, one or two sentences. Required." }),
});
export type EditGuildArguments = Static<typeof EditGuildArguments>;

export const EditNoteArguments = Type.Object({
  action: ACTION,
  display_path: Type.Optional(
    Type.String({ description: "edit and delete: display path from studio_find_artifacts or studio_get_artifact." }),
  ),
  base_version: Type.Optional(
    Type.Integer({ description: "edit and delete: the note version the proposal was built from." }),
  ),
  level: Type.Optional(
    studioChoice(ARTIFACT_LEVELS, {
      description:
        "create: agent is one agent's own file, guild is read by the source guild's agents, org is read across the organisation.",
    }),
  ),
  agent_id: Type.Optional(Type.String({ description: "create at level agent: source-guild agent id or name." })),
  key: Type.Optional(Type.String({ description: "create: file name ending in .md, no folders, for example playbook.md." })),
  title: Type.Optional(Type.String({ description: "create: short title shown in Files." })),
  content: Type.Optional(
    Type.String({ description: "create and edit: the complete note body, not a description of changes." }),
  ),
  reason: REASON,
});
export type EditNoteArguments = Static<typeof EditNoteArguments>;

const TABLE_COLUMNS = Type.Array(
  Type.Object(
    {
      name: Type.String({
        description: "^[a-z][a-z0-9_]{0,63}$; id, created_at, updated_at, created_by, and updated_by are reserved.",
      }),
      type: studioChoice(["text", "number", "boolean", "datetime", "array"]),
      description: Type.String({ description: "What the value means and how agents should fill it. At most 1000 characters." }),
      required: Type.Optional(Type.Boolean()),
      unique: Type.Optional(
        Type.Boolean({
          description: "Text or number only, at most one per table. A record_add that repeats the value merges into that record.",
        }),
      ),
      values: Type.Optional(
        Type.Array(Type.String(), {
          description: "Text or array only: the closed list of accepted values, such as a queue's state.",
        }),
      ),
      rename_from: Type.Optional(
        Type.String({
          description: "The column's current name when this entry renames it; its values move to the new name.",
        }),
      ),
    },
    { additionalProperties: false },
  ),
  {
    description:
      "create: the typed columns, in display order; every record write is validated against them. edit: the complete column list replacing the current one; keep every column you do not mean to change, since a column left out is dropped from every record.",
  },
);

export const TableAccessArguments = Type.Object(
  {
    guild: Type.Optional(
      studioChoice(GUILD_ROW_MODES, {
        description: "The guild's row: the mode of every agent in the guild without a row of its own; none removes the guild's row.",
      }),
    ),
    agents: Type.Optional(
      Type.Array(
        Type.Object(
          {
            agent_id: Type.String({ description: "Source-guild agent id or name." }),
            mode: studioChoice(AGENT_ROW_MODES, {
              description: "The agent's own row over the guild's: none keeps it out; inherit removes its own row.",
            }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  {
    description: "Who in the source guild reaches the table. Only the entries given change.",
    additionalProperties: false,
  },
);
export type TableAccessArguments = Static<typeof TableAccessArguments>;

export const EditCollectionArguments = Type.Object({
  action: ACTION,
  collection: Type.Optional(Type.String({ description: "edit and delete: the table's current name." })),
  base_updated_at: Type.Optional(Type.String({ description: "edit: the updated_at studio_get_collection returned." })),
  name: Type.Optional(
    Type.String({
      description:
        "create: ^[a-z][a-z0-9_-]{0,62}$, unique in the organisation. edit: the new name; Tasks, notes, and routines that name the old one must change too.",
    }),
  ),
  purpose: Type.Optional(
    Type.String({ description: "create and edit: one line, at most 400 characters: what one record is and who writes it." }),
  ),
  columns: Type.Optional(TABLE_COLUMNS),
  scope: Type.Optional(
    studioChoice(["guild", "org"], {
      description: "create: guild (default), the source guild owns the table and starts with the guild at write; org, an organisation table that starts with the organisation at read.",
    }),
  ),
  access: Type.Optional(TableAccessArguments),
  reason: REASON,
});
export type EditCollectionArguments = Static<typeof EditCollectionArguments>;

const ACCESS_SETTINGS = ["on", "off", "inherit"] as const;
export type AccessSetting = (typeof ACCESS_SETTINGS)[number];
const ACCESS_SETTING = studioChoice(ACCESS_SETTINGS);

export const EditAccessArguments = Type.Object({
  agent_id: Type.String({ description: "Source-guild agent id or name. Required." }),
  native_tools: Type.Optional(
    studioMap(ACCESS_SETTING, {
      description: "Native tool name to setting, from native_tools or withheld_native_tools.",
    }),
  ),
  connections: Type.Optional(
    studioMap(ACCESS_SETTING, {
      description: "Connection id from studio_get_agent_access to setting: the whole connection for this agent.",
    }),
  ),
  connection_tools: Type.Optional(
    studioMap(ACCESS_SETTING, {
      description: "Connection tool name from offered_tools or withheld_tools to setting.",
    }),
  ),
  reason: REASON,
});
export type EditAccessArguments = Static<typeof EditAccessArguments>;

export const EditRoutineArguments = Type.Object({
  action: ACTION,
  agent_id: Type.Optional(Type.String({ description: "create: source-guild agent id or name." })),
  schedule_id: Type.Optional(Type.String({ description: "edit and delete: the routine's id from studio_list_routines." })),
  cron: Type.Optional(
    Type.String({
      description:
        "5-field UTC expression (minute hour day month weekday), for example '0 9 * * 1'; wake-ups at least 5 minutes apart. Pass cron or window, not both.",
    }),
  ),
  window: Type.Optional(
    Type.Object(
      {
        timezone: Type.String({ description: "IANA name, for example Europe/Paris." }),
        start: Type.String({ description: "HH:MM local time." }),
        end: Type.String({ description: "HH:MM local time; earlier than start spans midnight." }),
        max_wakes: Type.Integer({ description: "Most wake-ups per window; gaps are at least 5 minutes." }),
      },
      {
        description: "Random wake-ups inside a daily local-time window. Pass cron or window, not both.",
        additionalProperties: false,
      },
    ),
  ),
  description: Type.Optional(
    Type.String({ description: "One-line label shown in the Routine tab, at most 400 characters." }),
  ),
  instruction: Type.Optional(
    Type.String({
      description: "Short markdown the agent receives on each wake-up, at most 2000 characters: what this wake-up is for, not the agent's whole Task.",
    }),
  ),
  paused: Type.Optional(
    Type.Boolean({ description: "create: true creates it paused. edit: true pauses it; false resumes it." }),
  ),
  reason: REASON,
});
export type EditRoutineArguments = Static<typeof EditRoutineArguments>;
