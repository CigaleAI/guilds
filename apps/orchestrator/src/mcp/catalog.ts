import { Type, type Static } from "@sinclair/typebox";
import { loadManifest, ManifestError, SLUG_RE } from "../connectors/manifest.js";
import {
  connectorFacts,
  editableTools,
  editCopyOverrides,
  getMcpServerBySlug,
  installedConnectorBySlug,
  loadConnector,
  overriddenCopyFields,
  type CopyField,
  type LoadedConnector,
} from "../connectors/servers.js";
import { isPlainRecord, jsonObj } from "../db/json.js";
import { SLUG_PATTERN, ToolInputSchema, type Manifest, type Overrides, type ToolOverride } from "../db/schema/index.js";
import { decode } from "../lib/decode.js";
import { newId } from "../lib/ids.js";
import { generateToolPrefix, isReservedSlug, isReservedToolPrefix } from "../mcp/policy.js";
import { assertPublicHttpsUrl, EndpointError } from "../net/endpoints.js";
import { oauthSetupState } from "../oauth/index.js";
import { insertConnector, listConnectorSlugOwners, listTakenToolPrefixes, updateConnector } from "../db/connectors.js";
import type { Queryable } from "../db/pg.js";

export const AUTH_KINDS = ["none", "token", "oauth"] as const;
export const OAUTH_STRATEGIES = ["none", "dynamic", "configured"] as const;
export const SCHEMA_MAX_BYTES = 64 * 1024;
export const DESCRIPTION_MAX = 4000;

export class CatalogError extends Error {
  status: number;

  constructor(message: string, status = 422) {
    super(message);
    this.name = "CatalogError";
    this.status = status;
  }
}

/** A hand-made connector as its create request sends it: the slug and endpoint, and its copy. */
export const ConnectorDraftSchema = Type.Object({
  slug: Type.String(),
  url: Type.String(),
  display_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  auth: Type.Optional(Type.String()),
  oauth_strategy: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  limitations: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  setup_hint: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  enabled: Type.Optional(Type.Boolean()),
});

export type ConnectorDraft = Static<typeof ConnectorDraftSchema>;

/** A change to a connector: the draft's fields it changes, each left out kept. */
export const ConnectorPatchSchema = Type.Partial(ConnectorDraftSchema);

export type ConnectorPatch = Static<typeof ConnectorPatchSchema>;

/** A change to one of a connector's tools; null clears that edit, and a field left out keeps it. */
export const ToolEditSchema = Type.Object({
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  input_schema: Type.Optional(Type.Unknown()),
  default: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
});

export type ToolEdit = Static<typeof ToolEditSchema>;

/** Whether the admin edits the connector's own fields (a server made on this box) or overrides its manifest. */
function editsFields(server: LoadedConnector): boolean {
  return server.source === "local";
}

/** A connector as the Admin tab shows it: the effective copy, what overrides it, and its tools. */
export function catalogServerItem(server: LoadedConnector): Record<string, unknown> {
  const upstream = server.upstream;
  const config = jsonObj(server.config) as { url?: unknown } | null;
  return {
    id: server.id,
    slug: server.slug,
    display_name: server.display_name,
    auth: server.auth,
    oauth_strategy: server.oauth_strategy,
    oauth_setup_state: oauthSetupState(server),
    description: server.description || "",
    limitations: server.limitations,
    setup_hint: server.setup_hint,
    url: typeof config?.url === "string" ? config.url : null,
    enabled: server.enabled,
    tool_prefix: server.tool_prefix,
    version: server.version,
    editable: editsFields(server) ? "fields" : "overrides",
    upstream: {
      display_name: upstream.display_name ?? "",
      description: upstream.description ?? "",
      limitations: upstream.limitations ?? null,
      setup_hint: upstream.setup_hint ?? null,
    },
    overridden: overriddenCopyFields(server),
    ...connectorFacts(server),
    tools: editableTools(server),
  };
}

export function validateSlug(raw: string): string {
  const slug = raw.trim();
  if (!SLUG_RE.test(slug)) {
    throw new CatalogError(`slug must match ${SLUG_PATTERN}`);
  }
  if (isReservedSlug(slug)) {
    throw new CatalogError(`slug '${slug}' is reserved`);
  }
  return slug;
}

export function validateAuth(raw: string): Manifest["auth"]["kind"] {
  if (!(AUTH_KINDS as readonly string[]).includes(raw)) {
    throw new CatalogError("auth must be none, token, or oauth");
  }
  return raw as Manifest["auth"]["kind"];
}

export function validateOauthStrategy(auth: string, raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") {
    return auth === "oauth" ? "dynamic" : "none";
  }
  if (typeof raw !== "string" || !(OAUTH_STRATEGIES as readonly string[]).includes(raw)) {
    throw new CatalogError("oauth_strategy must be none, dynamic, or configured");
  }
  if (auth !== "oauth" && raw !== "none") {
    throw new CatalogError("oauth_strategy must be none unless auth is oauth");
  }
  if (auth === "oauth" && raw === "none") {
    throw new CatalogError("oauth connectors require dynamic or configured oauth_strategy");
  }
  return raw;
}

/** The trimmed description, or an empty string when none is given. */
export function validateCatalogDescription(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length > DESCRIPTION_MAX) {
    throw new CatalogError(`description exceeds ${DESCRIPTION_MAX} characters`);
  }
  return text;
}

export function validateOptionalText(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  if (typeof raw !== "string") {
    throw new CatalogError(`${field} must be a string`);
  }
  if (raw.length > DESCRIPTION_MAX) {
    throw new CatalogError(`${field} exceeds ${DESCRIPTION_MAX} characters`);
  }
  return raw;
}

/** How the Admin form's value for each copy field an override replaces is checked. */
const COPY_CHECKS: Readonly<Record<CopyField, (value: unknown) => string>> = {
  display_name: (value) => String(value).trim(),
  description: validateCatalogDescription,
  limitations: (value) => validateOptionalText(value, "limitations") ?? "",
  setup_hint: (value) => validateOptionalText(value, "setup_hint") ?? "",
};

export function validateEndpointUrl(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new CatalogError("url is required");
  }
  try {
    return assertPublicHttpsUrl(raw.trim(), "url").toString();
  } catch (error) {
    if (error instanceof EndpointError) {
      throw new CatalogError(error.message);
    }
    throw error;
  }
}

export function validateInputSchema(raw: unknown): ToolInputSchema {
  const obj = jsonObj(raw);
  if (!isPlainRecord(obj)) {
    throw new CatalogError("input_schema must be an object");
  }
  const schema = decode(ToolInputSchema, obj, (problem) => new CatalogError(`input_schema ${problem}`));
  const encoded = JSON.stringify(schema);
  if (Buffer.byteLength(encoded, "utf8") > SCHEMA_MAX_BYTES) {
    throw new CatalogError("input_schema exceeds size limit");
  }
  return schema;
}

/** A hand-made connector's manifest from the Admin form, checked like a folder's. */
function handManifest(fields: {
  slug: string;
  displayName: string;
  url: string;
  auth: Manifest["auth"]["kind"];
  oauthStrategy: string;
  description: string;
  limitations: string | null;
  setupHint: string | null;
  tools?: Manifest["tools"];
}): Manifest {
  const manifest = {
    slug: fields.slug,
    display_name: fields.displayName,
    endpoint: { url: fields.url },
    auth: {
      kind: fields.auth,
      ...(fields.auth === "oauth" ? { oauth: { strategy: fields.oauthStrategy === "configured" ? "configured" : "dynamic" } } : {}),
    },
    description: fields.description,
    ...(fields.limitations !== null ? { limitations: fields.limitations } : {}),
    ...(fields.setupHint !== null ? { setup_hint: fields.setupHint } : {}),
    ...(fields.tools?.length ? { tools: fields.tools } : {}),
  };
  try {
    return loadManifest(manifest);
  } catch (error) {
    if (error instanceof ManifestError) {
      throw new CatalogError(error.message);
    }
    throw error;
  }
}

/**
 * Refuses a slug another server holds. A platform server's slug may not match any server's, and
 * an organisation's may not match a platform server's or another of its own; two organisations
 * may each add a server under one slug. The refusal names the side that holds it.
 */
export async function assertSlugFree(
  db: Queryable,
  slug: string,
  ownerOrgId: string | null,
  serverId?: string,
): Promise<void> {
  const installed = installedConnectorBySlug(slug);
  if (installed && installed.id !== serverId) {
    throw new CatalogError(`slug ${slug} is the platform's ${installed.display_name} connector`, 409);
  }
  const holders = [...new Set(await listConnectorSlugOwners(db, slug))];
  const existing = await getMcpServerBySlug(db, slug, ownerOrgId);
  if (existing && existing.id === serverId) {
    return;
  }
  if (holders.includes(null)) {
    throw new CatalogError(`slug ${slug} is a platform connector on this box`, 409);
  }
  if (ownerOrgId === null && holders.length) {
    throw new CatalogError(`slug ${slug} is used by an organisation's own server`, 409);
  }
  if (ownerOrgId !== null && holders.includes(ownerOrgId)) {
    throw new CatalogError(`this organisation already has a server named ${slug}`, 409);
  }
}

/** Installs a remote MCP server the instance admin adds by hand: a platform row with no folder, on at creation. */
export async function createConnector(
  db: Queryable,
  body: ConnectorDraft,
  now = new Date(),
  ownerOrgId: string | null = null,
): Promise<LoadedConnector> {
  const slug = validateSlug(body.slug);
  await assertSlugFree(db, slug, ownerOrgId);
  const auth = validateAuth(body.auth ?? "token");
  if (ownerOrgId !== null && auth === "oauth" && body.oauth_strategy === "configured") {
    throw new CatalogError("an organisation's server signs in with a dynamically registered client");
  }
  const manifest = handManifest({
    slug,
    displayName: String(body.display_name ?? slug).trim() || slug,
    url: validateEndpointUrl(body.url),
    auth,
    oauthStrategy: validateOauthStrategy(auth, body.oauth_strategy),
    description: validateCatalogDescription(body.description),
    limitations: validateOptionalText(body.limitations, "limitations"),
    setupHint: validateOptionalText(body.setup_hint, "setup_hint"),
  });
  const toolPrefix = generateToolPrefix(slug, await listTakenToolPrefixes(db));
  if (isReservedToolPrefix(toolPrefix)) {
    throw new CatalogError("generated tool prefix is reserved");
  }
  const row = await insertConnector(
    db,
    {
      id: newId("mcp"),
      slug,
      toolPrefix,
      ownerOrgId,
      manifest,
      source: "local",
      verified: false,
      publisher: "",
      enabled: body.enabled ?? true,
    },
    now,
  );
  return loadConnector(row);
}

/**
 * Edits a connector. Its switch always; a hand-made one's own fields; any other's copy as
 * overrides, where null clears an override. The endpoint, auth, and slug of a connector the
 * box did not write come from its manifest.
 */
export async function patchConnector(
  db: Queryable,
  server: LoadedConnector,
  body: ConnectorPatch,
  now = new Date(),
): Promise<LoadedConnector> {
  const patch: { slug?: string; manifest?: Manifest; overrides?: Overrides; enabled?: boolean } = {};
  if (body.enabled !== undefined) {
    patch.enabled = body.enabled;
  }
  if (editsFields(server)) {
    const current = server.manifest;
    const slug = body.slug !== undefined ? validateSlug(body.slug) : current.slug;
    const ownerOrgId = server.owner_org_id ? String(server.owner_org_id) : null;
    if (slug !== current.slug) {
      await assertSlugFree(db, slug, ownerOrgId, server.id);
      patch.slug = slug;
    }
    const auth = body.auth !== undefined ? validateAuth(body.auth) : current.auth.kind;
    if (ownerOrgId !== null && auth === "oauth" && body.oauth_strategy === "configured") {
      throw new CatalogError("an organisation's server signs in with a dynamically registered client");
    }
    const pick = (field: "description" | "limitations" | "setup_hint"): string | null =>
      body[field] !== undefined
        ? field === "description"
          ? validateCatalogDescription(body[field])
          : validateOptionalText(body[field], field)
        : (current[field] ?? (field === "description" ? "" : null));
    patch.manifest = handManifest({
      slug,
      displayName: body.display_name !== undefined ? String(body.display_name).trim() || slug : current.display_name,
      url: body.url !== undefined ? validateEndpointUrl(body.url) : String(current.endpoint?.url ?? ""),
      auth,
      oauthStrategy: validateOauthStrategy(
        auth,
        body.oauth_strategy ?? (body.auth !== undefined ? undefined : server.oauth_strategy),
      ),
      description: String(pick("description") ?? ""),
      limitations: pick("limitations"),
      setupHint: pick("setup_hint"),
      tools: current.tools,
    });
  } else {
    for (const field of ["slug", "url", "auth", "oauth_strategy"] as const) {
      if (body[field] !== undefined) {
        throw new CatalogError(`${field} comes from the connector's manifest`);
      }
    }
    patch.overrides = editCopyOverrides(server.overrides, body, COPY_CHECKS);
  }
  const updated = await updateConnector(db, server.id, patch, now);
  if (!updated) {
    throw new CatalogError("mcp server not found", 404);
  }
  return loadConnector(updated);
}

/** Edits one tool by name: its description, its input schema, and whether it starts On. Null clears an edit. */
export async function patchConnectorTool(
  db: Queryable,
  server: LoadedConnector,
  name: string,
  body: ToolEdit,
  now = new Date(),
): Promise<LoadedConnector> {
  const toolName = name.trim();
  if (!toolName || toolName.length > 128) {
    throw new CatalogError("tool name is invalid");
  }
  const overrides: Overrides = { ...server.overrides };
  const tools = { ...(overrides.tools ?? {}) };
  const edit: ToolOverride = { ...(tools[toolName] ?? {}) };
  if (body.description !== undefined) {
    if (body.description === null) {
      delete edit.description;
    } else {
      edit.description = validateCatalogDescription(body.description);
    }
  }
  if (body.input_schema !== undefined) {
    if (body.input_schema === null) {
      delete edit.input_schema;
    } else {
      edit.input_schema = validateInputSchema(body.input_schema);
    }
  }
  if (body.default !== undefined) {
    if (body.default === null) {
      delete edit.default;
    } else {
      edit.default = body.default;
    }
  }
  if (Object.keys(edit).length) {
    tools[toolName] = edit;
  } else {
    delete tools[toolName];
  }
  if (Object.keys(tools).length) {
    overrides.tools = tools;
  } else {
    delete overrides.tools;
  }
  const updated = await updateConnector(db, server.id, { overrides }, now);
  if (!updated) {
    throw new CatalogError("mcp server not found", 404);
  }
  return loadConnector(updated);
}

/** The connector in the folder format: its manifest with the admin's overrides applied. */
export function exportManifest(server: LoadedConnector): Manifest {
  return server.manifest;
}
