// The Studio tools for guilds: the source guild's public history, about, and description, the
// organisation's other guilds, and a proposed change to the source guild's text.

import { Type, type Static } from "@sinclair/typebox";
import { listGroupMessages } from "../db/group-chat.js";
import { listGuildsForUser } from "../db/guilds.js";
import { ABOUT_MAX, DESCRIPTION_MAX } from "../guilds/validation.js";
import { studioTool } from "./arguments.js";
import { EditGuildArguments } from "./edit-arguments.js";
import { STUDIO_DEFAULT_LIMIT, STUDIO_GROUP_LIST_MAX, STUDIO_TOTAL_RETURNED_BYTES } from "./constants.js";
import { editRequest, loadGuildBase } from "./edits.js";
import { StudioUnprocessableError } from "./errors.js";
import { clampLimit, cursorOffset, truncatePayload } from "./paging.js";
import { editScope } from "./source-guild.js";
import { wrapEvidence } from "./system.js";
import type { StudioTool } from "./tools.js";

const ListGroupMessagesArguments = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer()),
  author_type: Type.Optional(Type.String()),
  author_handle: Type.Optional(Type.String()),
});
type ListGroupMessagesArguments = Static<typeof ListGroupMessagesArguments>;

export const studioListGroupMessages: StudioTool = studioTool({
  name: "studio_list_group_messages",
  description: "Inspect bounded public guild history.",
  parameters: ListGroupMessagesArguments,
  async run(deps, call, input: ListGroupMessagesArguments) {
    const limit = clampLimit(input.limit, STUDIO_DEFAULT_LIMIT, STUDIO_GROUP_LIST_MAX);
    const offset = cursorOffset(input.cursor);
    const { author_type: authorType, author_handle: authorHandle } = input;
    let rows = await listGroupMessages(deps.db, call.sourceGuildId);
    if (authorType) {
      rows = rows.filter((row) => row.author_type === authorType);
    }
    if (authorHandle) {
      rows = rows.filter((row) => row.author_agent_id === authorHandle || row.author_name === authorHandle);
    }
    const slice = rows.slice(offset, offset + limit);
    return {
      messages: slice.map((row) => ({
        seq: row.seq,
        author_type: row.author_type,
        author_name: row.author_name,
        author_agent_id: row.author_agent_id,
        created_at: row.created_at,
        content: wrapEvidence({
          source: "group_message",
          coordinates: { seq: row.seq },
          body: String(row.content ?? ""),
        }),
      })),
      next_cursor: offset + slice.length < rows.length ? String(offset + slice.length) : null,
    };
  },
});

export const studioGetGuild: StudioTool = studioTool({
  name: "studio_get_guild",
  description:
    "Read the source guild's live about (short, one line) and description (long) in full. The system message holds the text from session start, capped; this tool returns the current text.",
  parameters: Type.Object({}),
  async run(deps, call) {
    const base = await loadGuildBase(deps, editScope(call));
    if (base.kind !== "guild") {
      throw new StudioUnprocessableError("source guild not found");
    }
    return {
      guild_id: base.guildId,
      name: base.guildName,
      ownership: "operator-owned",
      editable: true,
      about_max_chars: ABOUT_MAX,
      description_max_chars: DESCRIPTION_MAX,
      about: wrapEvidence({ source: "guild_about", coordinates: { guild_id: base.guildId }, body: base.text.about }),
      description: wrapEvidence({
        source: "guild_description",
        coordinates: { guild_id: base.guildId },
        body: base.text.description,
      }),
    };
  },
});

const ListGuildsArguments = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer()),
});
type ListGuildsArguments = Static<typeof ListGuildsArguments>;

export const studioListGuilds: StudioTool = studioTool({
  name: "studio_list_guilds",
  description:
    "Read the organisation's other guilds that the operator can see: each one's name, about (short), and description (long). Their agents, files, and tables stay out of reach; their shared output reaches this guild through organisation tables and notes.",
  parameters: ListGuildsArguments,
  async run(deps, call, input: ListGuildsArguments) {
    const limit = clampLimit(input.limit, STUDIO_DEFAULT_LIMIT, STUDIO_GROUP_LIST_MAX);
    const offset = cursorOffset(input.cursor);
    const others = (await listGuildsForUser(deps.db, call.orgId, String(call.user.id))).filter(
      (row) => row.id !== String(call.sourceGuildId),
    );
    // A page ends at the limit or where the next guild would pass the byte cap.
    const guilds: Array<Record<string, unknown>> = [];
    let bytes = 0;
    for (const row of others.slice(offset, offset + limit)) {
      const item = {
        guild_id: row.id,
        name: wrapEvidence({ source: "guild_name", coordinates: { guild_id: row.id }, body: String(row.name ?? "") }),
        about: wrapEvidence({ source: "guild_about", coordinates: { guild_id: row.id }, body: String(row.about ?? "") }),
        description: wrapEvidence({
          source: "guild_description",
          coordinates: { guild_id: row.id },
          body: String(row.description ?? ""),
        }),
      };
      const size = Buffer.byteLength(JSON.stringify(item), "utf8");
      if (guilds.length && bytes + size > STUDIO_TOTAL_RETURNED_BYTES / 2) break;
      guilds.push(item);
      bytes += size;
    }
    const next = offset + guilds.length;
    return truncatePayload({
      guilds,
      editable: false,
      next_cursor: next < others.length ? String(next) : null,
    });
  },
});

export const studioEditGuild: StudioTool = studioTool({
  name: "studio_edit_guild",
  description:
    `Propose new text for the source guild's about (short, at most ${ABOUT_MAX} characters), description (long, at most ${DESCRIPTION_MAX} characters), or both. A field left out keeps its live text. Nothing is written: the turn pauses and the operator applies or declines. Read the live text with studio_get_guild first.`,
  parameters: EditGuildArguments,
  async run(deps, call, input: EditGuildArguments) {
    const base = await loadGuildBase(deps, editScope(call));
    return editRequest(base, input, null);
  },
});
