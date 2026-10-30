// The Studio tools for tables (collections): listing and reading them, and a proposed change to one.

import { Type, type Static } from "@sinclair/typebox";
import { decodeStudioArguments, studioFunctionSchema } from "./arguments.js";
import { tableEditRequest } from "./edits.js";
import { editScope } from "./source-guild.js";
import { listTables, readTable } from "./tables.js";
import type { StudioTool } from "./tools.js";

const TABLE_COLUMNS = Type.Array(
  Type.Object(
    {
      name: Type.String({
        description: "^[a-z][a-z0-9_]{0,63}$; id, created_at, updated_at, created_by, and updated_by are reserved.",
      }),
      type: Type.String({ enum: ["text", "number", "boolean", "datetime", "array"] }),
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

const TABLE_ACCESS = Type.Object(
  {
    guild: Type.Optional(
      Type.String({
        enum: ["read", "write", "none"],
        description: "The guild's row: the mode of every agent in the guild without a row of its own; none removes the guild's row.",
      }),
    ),
    agents: Type.Optional(
      Type.Array(
        Type.Object(
          {
            agent_id: Type.String({ description: "Source-guild agent id or name." }),
            mode: Type.String({
              enum: ["read", "write", "none", "inherit"],
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

export const studioListCollections: StudioTool = {
  name: "studio_list_collections",
  schema: studioFunctionSchema(
    "studio_list_collections",
    "List the tables (collections) the source guild's agents can be given: the guild's own, then the organisation's. Each has owner, purpose, record count, column names, the source guild's access, and studio_can: edit_or_delete for the guild's own, add_columns_and_access for the organisation's.",
    Type.Object({}),
  ),
  async handler(deps, call) {
    return { collections: await listTables(deps, editScope(call)), trust: "untrusted" };
  },
};

const GetCollectionArguments = Type.Object({
  collection: Type.String({ description: "Table name from studio_list_collections. Required." }),
});
type GetCollectionArguments = Static<typeof GetCollectionArguments>;

export const studioGetCollection: StudioTool = {
  name: "studio_get_collection",
  schema: studioFunctionSchema(
    "studio_get_collection",
    "Read one table: purpose, full columns, record count, updated_at (pass it as base_updated_at to studio_edit_collection), the organisation's row, the source guild's row, each source-guild agent's row and resulting access, the rows of other guilds and their agents, and the latest records.",
    GetCollectionArguments,
  ),
  async handler(deps, call, args) {
    const input: GetCollectionArguments = decodeStudioArguments(GetCollectionArguments, args);
    return { ...(await readTable(deps, editScope(call), input.collection)), trust: "untrusted" };
  },
};

const EditCollectionArguments = Type.Object({
  action: Type.String({ enum: ["create", "edit", "delete"], description: "Required." }),
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
    Type.String({
      enum: ["guild", "org"],
      description: "create: guild (default), the source guild owns the table and starts with the guild at write; org, an organisation table that starts with the organisation at read.",
    }),
  ),
  access: Type.Optional(TABLE_ACCESS),
  reason: Type.String({ description: "Why this change, one or two sentences, citing evidence. Required." }),
});
type EditCollectionArguments = Static<typeof EditCollectionArguments>;

export const studioEditCollection: StudioTool = {
  name: "studio_edit_collection",
  schema: studioFunctionSchema(
    "studio_edit_collection",
    "Propose a change to one table of the source guild or the organisation. Nothing is written: the turn pauses and the operator applies or declines. create: a new table agents read and write with the record tools; check studio_list_collections first and reuse a table that fits. edit: on the source guild's own table, a new name, purpose, column list, or member access; on an organisation table, new columns added to the unchanged current ones, or source-guild access. Fields left out stay as they are. delete: one of the source guild's own tables with every record in it and its access list. edit and delete name the table by collection; read it with studio_get_collection first.",
    EditCollectionArguments,
  ),
  async handler(deps, call, args) {
    const input: EditCollectionArguments = decodeStudioArguments(EditCollectionArguments, args);
    return tableEditRequest(deps, editScope(call), input);
  },
};
