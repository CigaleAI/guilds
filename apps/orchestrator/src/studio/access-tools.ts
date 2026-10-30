// The Studio tools for what a source-guild agent is offered: its native tools, scripts, secrets, and
// connections, one script's source, and a proposed change to its access.

import { Type, type Static } from "@sinclair/typebox";
import { ScriptError } from "../scripts/validation.js";
import { NATIVE_TOOLS } from "../seed/catalog.js";
import { decodeStudioArguments, studioFunctionSchema } from "./arguments.js";
import { liveGrantedConnectionIds } from "./connection-tools.js";
import { accessEditRequest } from "./edits.js";
import { StudioUnprocessableError } from "./errors.js";
import { sliceStudioBytes, truncatePayload } from "./paging.js";
import { projectAgentAccess } from "./preview.js";
import { editScope, resolveHandle } from "./source-guild.js";
import { wrapEvidence } from "./system.js";
import type { StudioTool } from "./tools.js";

const GetAgentAccessArguments = Type.Object({
  agent_id: Type.String({ description: "Source-guild agent id or name. Required." }),
});
type GetAgentAccessArguments = Static<typeof GetAgentAccessArguments>;

export const studioGetAgentAccess: StudioTool = {
  name: "studio_get_agent_access",
  schema: studioFunctionSchema(
    "studio_get_agent_access",
    "Inspect what one source-guild agent is offered at run start: native tools, scripts, secret names, and MCP connections with their listed tools. Withheld lists name what the agent could be offered but is not. Each connection says whether this Studio session may read through it (studio_granted).",
    GetAgentAccessArguments,
  ),
  async handler(deps, call, args) {
    const input: GetAgentAccessArguments = decodeStudioArguments(GetAgentAccessArguments, args);
    const agent = await resolveHandle(deps, call, input.agent_id);
    const access = await projectAgentAccess(deps.preview, agent);
    const granted = await liveGrantedConnectionIds(deps, call);
    return truncatePayload({
      agent_id: agent.id,
      name: agent.name,
      native_tools: access.native_tools,
      withheld_native_tools: NATIVE_TOOLS.filter((name) => !access.native_tools.includes(name)),
      scripts: access.scripts,
      secrets: access.secrets,
      connections: access.connections.map((connection) => ({
        id: connection.id,
        server: connection.server,
        owner_scope: connection.owner_scope,
        account_hint: connection.account_hint,
        status: connection.status,
        server_enabled: connection.server_enabled,
        offered_tools: connection.offered_tools,
        withheld_tools: connection.tools
          .map((tool) => tool.name)
          .filter((name) => !connection.offered_tools.includes(name)),
        studio_granted: granted.has(connection.id),
        studio_readable_tools: connection.tools.filter((tool) => tool.read_only).map((tool) => tool.name),
      })),
    });
  },
};

const GetScriptArguments = Type.Object({
  agent_id: Type.String({ description: "Source-guild agent id or name. Required." }),
  name: Type.String({ description: "Script name. Required." }),
  cursor: Type.Optional(Type.String()),
});
type GetScriptArguments = Static<typeof GetScriptArguments>;

export const studioGetScript: StudioTool = {
  name: "studio_get_script",
  schema: studioFunctionSchema(
    "studio_get_script",
    "Read the source of one script owned by a source-guild agent. Script names come from the State projection or studio_get_agent_access.",
    GetScriptArguments,
  ),
  async handler(deps, call, args) {
    const input: GetScriptArguments = decodeStudioArguments(GetScriptArguments, args);
    const agent = await resolveHandle(deps, call, input.agent_id);
    let script: Record<string, unknown>;
    try {
      script = await deps.preview.scripts.get(agent.id, input.name);
    } catch (error) {
      if (error instanceof ScriptError) {
        throw new StudioUnprocessableError(error.message);
      }
      throw error;
    }
    const sliced = sliceStudioBytes(String(script.source ?? ""), input.cursor);
    return {
      agent_id: agent.id,
      name: script.name,
      description: script.description,
      parameters: script.parameters,
      source_hash: script.source_hash,
      ownership: "agent-owned",
      editable: false,
      content: wrapEvidence({
        source: "script",
        coordinates: { agent_id: agent.id, name: String(script.name), source_hash: String(script.source_hash ?? "") },
        body: sliced.text,
      }),
      ...(sliced.next_cursor ? { next_cursor: sliced.next_cursor } : {}),
      ...(sliced.truncated ? { truncated: true } : {}),
    };
  },
};

const ACCESS_SETTING = Type.String({ enum: ["on", "off", "inherit"] });

const EditAccessArguments = Type.Object({
  agent_id: Type.String({ description: "Source-guild agent id or name. Required." }),
  native_tools: Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: ACCESS_SETTING,
        description: "Native tool name to setting, from native_tools or withheld_native_tools.",
      },
    ),
  ),
  connections: Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: ACCESS_SETTING,
        description: "Connection id from studio_get_agent_access to setting: the whole connection for this agent.",
      },
    ),
  ),
  connection_tools: Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: ACCESS_SETTING,
        description: "Connection tool name from offered_tools or withheld_tools to setting.",
      },
    ),
  ),
  reason: Type.String({ description: "Why this change, one or two sentences, citing evidence. Required." }),
});
type EditAccessArguments = Static<typeof EditAccessArguments>;

export const studioEditAccess: StudioTool = {
  name: "studio_edit_access",
  schema: studioFunctionSchema(
    "studio_edit_access",
    "Propose what one source-guild agent is offered: native tools, whole connections, and single connection tools. Each entry sets the agent's own overlay: on, off, or inherit (drop the overlay and take the guild's setting). Entries left out stay as they are. Nothing is written: the turn pauses and the operator applies or declines. Read the agent with studio_get_agent_access first. The browser, coding, scripting, and memory switches are agent configuration, not access.",
    EditAccessArguments,
  ),
  async handler(deps, call, args) {
    const input: EditAccessArguments = decodeStudioArguments(EditAccessArguments, args);
    const agent = await resolveHandle(deps, call, input.agent_id);
    return accessEditRequest(deps, editScope(call), agent.id, input);
  },
};
