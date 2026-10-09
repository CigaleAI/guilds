import { CONNECTORS } from "../../connectors/index.js";

export const SHARED_HOST_ID = "host_shared";

export const NOTE_TOOLS = ["note_find", "note_get", "note_write", "note_delete"] as const;

export const RECORD_TOOLS = [
  "record_search",
  "record_list",
  "record_add",
  "record_update",
  "record_remove",
] as const;

export const ARTIFACT_TOOLS = [...NOTE_TOOLS, ...RECORD_TOOLS, "memory_write"] as const;

export const SCRIPT_TOOLS = [
  "script_create",
  "script_list",
  "script_read",
  "script_run",
  "script_delete",
] as const;

export const SCHEDULE_TOOLS = [
  "schedule_create_cron",
  "schedule_create_window",
  "schedule_list",
  "schedule_pause",
  "schedule_resume",
  "schedule_delete",
] as const;

// secret_request is offered on direct runs only; the operator answers it in that chat.
export const SECRET_TOOLS = ["secret_store", "secret_request"] as const;

export const NATIVE_TOOLS = [
  ...ARTIFACT_TOOLS,
  ...SCRIPT_TOOLS,
  ...SCHEDULE_TOOLS,
  ...SECRET_TOOLS,
  "group_post",
] as const;

export const DROPPED_NATIVE_TOOLS = [
  "artifact_find",
  "artifact_get",
  "artifact_delete",
  "note_read",
  "note_list",
  "collection_create",
  "collection_delete",
  "object_find",
  "object_get",
  "object_put",
  "object_delete",
  "schedule_create",
] as const;

// Connectors that no longer exist. Seed deletes the row, which cascades
// its connections, listed tools, and connection bindings, plus the server
// and tool overlays that name it.
export const DROPPED_MCP_SERVERS: ReadonlyArray<{ id: string; slug: string; tools: readonly string[] }> = [];

export const PLATFORM_NATIVE_TOOLS = [
  ...NOTE_TOOLS,
  ...RECORD_TOOLS,
  ...SCRIPT_TOOLS,
  ...SCHEDULE_TOOLS,
  "memory_write",
  ...SECRET_TOOLS,
  "group_post",
] as const;

export const PLATFORM_ARTIFACT_GRANTS = [
  { id: "read_guild", enabled: true },
  { id: "read_org", enabled: true },
  { id: "write_guild", enabled: true },
  { id: "write_org", enabled: false },
] as const;

/** Core's connectors as the seed installs them. */
export const MCP_SEED_SERVERS = CONNECTORS.entries().map((entry) => ({ id: entry.id, slug: entry.manifest.slug }));
