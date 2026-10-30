// The Studio tools for tables (collections): listing and reading them, and a proposed change to one.

import { Type, type Static } from "@sinclair/typebox";
import { studioTool } from "./arguments.js";
import { EditCollectionArguments } from "./edit-arguments.js";
import { tableEditRequest } from "./edits.js";
import { editScope } from "./source-guild.js";
import { listTables, readTable } from "./tables.js";
import type { StudioTool } from "./tools.js";

export const studioListCollections: StudioTool = studioTool({
  name: "studio_list_collections",
  description:
    "List the tables (collections) the source guild's agents can be given: the guild's own, then the organisation's. Each has owner, purpose, record count, column names, the source guild's access, and studio_can: edit_or_delete for the guild's own, add_columns_and_access for the organisation's.",
  parameters: Type.Object({}),
  async run(deps, call) {
    return { collections: await listTables(deps, editScope(call)), trust: "untrusted" };
  },
});

const GetCollectionArguments = Type.Object({
  collection: Type.String({ description: "Table name from studio_list_collections. Required." }),
});
type GetCollectionArguments = Static<typeof GetCollectionArguments>;

export const studioGetCollection: StudioTool = studioTool({
  name: "studio_get_collection",
  description:
    "Read one table: purpose, full columns, record count, updated_at (pass it as base_updated_at to studio_edit_collection), the organisation's row, the source guild's row, each source-guild agent's row and resulting access, the rows of other guilds and their agents, and the latest records.",
  parameters: GetCollectionArguments,
  async run(deps, call, input: GetCollectionArguments) {
    return { ...(await readTable(deps, editScope(call), input.collection)), trust: "untrusted" };
  },
});

export const studioEditCollection: StudioTool = studioTool({
  name: "studio_edit_collection",
  description:
    "Propose a change to one table of the source guild or the organisation. Nothing is written: the turn pauses and the operator applies or declines. create: a new table agents read and write with the record tools; check studio_list_collections first and reuse a table that fits. edit: on the source guild's own table, a new name, purpose, column list, or member access; on an organisation table, new columns added to the unchanged current ones, or source-guild access. Fields left out stay as they are. delete: one of the source guild's own tables with every record in it and its access list. edit and delete name the table by collection; read it with studio_get_collection first.",
  parameters: EditCollectionArguments,
  async run(deps, call, input: EditCollectionArguments) {
    return tableEditRequest(deps, editScope(call), input);
  },
});
