import { installedConnectors } from "../connectors/index.js";
import { manifestTools, OVERRIDE_FIELDS, overridesOf, toolStartsOff } from "../connectors/load.js";
import { loadManifest, ManifestError, SLUG_RE } from "../connectors/manifest.js";
import { connectorFacts } from "../connectors/view.js";
import { jsonObj } from "../db/json.js";
import { SLUG_PATTERN, type Manifest, type Overrides, type ToolOverride } from "../db/schema/index.js";
import { newId } from "../lib/ids.js";
import { generateToolPrefix, isReservedSlug, isReservedToolPrefix } from "../mcp/policy.js";
import { namespacedName } from "../mcp/names.js";
import { assertPublicHttpsUrl, EndpointError } from "../net/endpoints.js";
import { oauthSetupState } from "../oauth/index.js";
import {
  getMcpServerBySlug,
  insertConnector,
  listConnectorSlugOwners,
  listTakenToolPrefixes,
  updateConnector,
} from "../db/connectors.js";
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

/** Whether the admin edits the connector's own fields (a server made on this box) or overrides its manifest. */
function editsFields(server: Record<string, unknown>): boolean {
  return server.source === "local";
}

function catalogToolItems(server: Record<string, unknown>): Array<Record<string, unknown>> {
  const overrides = overridesOf(server.overrides).tools ?? {};
  const prefix = String(server.tool_prefix || server.slug);
  const items = manifestTools(server).map((tool) => ({
    ...tool,
    default_override: typeof overrides[tool.remote_name]?.default === "boolean" ? overrides[tool.remote_name]!.default : null,
    overridden: tool.remote_name in overrides,
  }));
  const named = new Set(items.map((tool) => tool.remote_name));
  for (const [name, edit] of Object.entries(overrides)) {
    if (named.has(name)) {
      continue;
    }
    items.push({
      remote_name: name,
      namespaced_name: namespacedName(prefix, name),
      description: edit.description ?? "",
      input_schema: edit.input_schema ?? { type: "object" },
      mutating: false,
      default_enabled: !toolStartsOff(server, name),
      default_override: typeof edit.default === "boolean" ? edit.default : null,
      overridden: true,
    });
  }
  return items;
}

/** A connector as the Admin tab shows it: the effective copy, what overrides it, and its tools. */
export function catalogServerItem(server: Record<string, unknown>): Record<string, unknown> {
  const upstream = (server.upstream ?? {}) as Partial<Manifest>;
  const overrides = overridesOf(server.overrides);
  const config = jsonObj(server.config) as { url?: unknown } | null;
  return {
    id: server.id,
    slug: server.slug,
    display_name: server.display_name,
    auth: server.auth,
    oauth_strategy: server.oauth_strategy,
    oauth_setup_state: oauthSetupState(server),
    description: server.description || "",
    limitations: server.limitations ?? null,
    setup_hint: server.setup_hint ?? null,
    url: typeof config?.url === "string" ? config.url : null,
    enabled: server.enabled !== false,
    tool_prefix: server.tool_prefix,
    version: server.version ?? "",
    editable: editsFields(server) ? "fields" : "overrides",
    upstream: {
      display_name: upstream.display_name ?? "",
      description: upstream.description ?? "",
      limitations: upstream.limitations ?? null,
      setup_hint: upstream.setup_hint ?? null,
    },
    overridden: OVERRIDE_FIELDS.filter((field) => typeof overrides[field] === "string"),
    ...connectorFacts(server),
    tools: catalogToolItems(server),
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new CatalogError(`${field} is required`);
  }
  return value;
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

export function validateInputSchema(raw: unknown): Record<string, unknown> {
  const obj = jsonObj(raw);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new CatalogError("input_schema must be an object");
  }
  const encoded = JSON.stringify(obj);
  if (Buffer.byteLength(encoded, "utf8") > SCHEMA_MAX_BYTES) {
    throw new CatalogError("input_schema exceeds size limit");
  }
  return obj as Record<string, unknown>;
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
  const installed = installedConnectors().bySlug(slug);
  if (installed && installed.id !== serverId) {
    throw new CatalogError(`slug ${slug} is the platform's ${installed.manifest.display_name} connector`, 409);
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
  body: Record<string, unknown>,
  now = new Date(),
  ownerOrgId: string | null = null,
): Promise<Record<string, unknown>> {
  const slug = validateSlug(requireString(body.slug, "slug"));
  await assertSlugFree(db, slug, ownerOrgId);
  const auth = validateAuth(String(body.auth ?? "token"));
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
  return insertConnector(db,
    {
      id: newId("mcp"),
      slug,
      toolPrefix,
      ownerOrgId,
      manifest,
      source: "local",
      verified: false,
      publisher: "",
      enabled: body.enabled === undefined ? true : body.enabled === true,
    },
    now,
  );
}

/**
 * Edits a connector. Its switch always; a hand-made one's own fields; any other's copy as
 * overrides, where null clears an override. The endpoint, auth, and slug of a connector the
 * box did not write come from its manifest.
 */
export async function patchConnector(
  db: Queryable,
  server: Record<string, unknown>,
  body: Record<string, unknown>,
  now = new Date(),
): Promise<Record<string, unknown>> {
  const patch: { slug?: string; manifest?: Manifest; overrides?: Overrides; enabled?: boolean } = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      throw new CatalogError("enabled must be a boolean");
    }
    patch.enabled = body.enabled;
  }
  if (editsFields(server)) {
    const current = server.manifest as Manifest;
    const slug = body.slug !== undefined ? validateSlug(String(body.slug)) : current.slug;
    const ownerOrgId = server.owner_org_id ? String(server.owner_org_id) : null;
    if (slug !== current.slug) {
      await assertSlugFree(db, slug, ownerOrgId, String(server.id));
      patch.slug = slug;
    }
    const auth = body.auth !== undefined ? validateAuth(String(body.auth)) : current.auth.kind;
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
    for (const field of ["slug", "url", "auth", "oauth_strategy"]) {
      if (body[field] !== undefined) {
        throw new CatalogError(`${field} comes from the connector's manifest`);
      }
    }
    const overrides: Overrides = { ...overridesOf(server.overrides) };
    for (const field of OVERRIDE_FIELDS) {
      if (body[field] === undefined) {
        continue;
      }
      if (body[field] === null) {
        delete overrides[field];
      } else if (field === "description") {
        overrides[field] = validateCatalogDescription(body[field]);
      } else if (field === "display_name") {
        overrides[field] = String(body[field]).trim();
      } else {
        overrides[field] = validateOptionalText(body[field], field) ?? "";
      }
    }
    patch.overrides = overrides;
  }
  const updated = await updateConnector(db, String(server.id), patch, now);
  if (!updated) {
    throw new CatalogError("mcp server not found", 404);
  }
  return updated;
}

/** Edits one tool by name: its description, its input schema, and whether it starts On. Null clears an edit. */
export async function patchConnectorTool(
  db: Queryable,
  server: Record<string, unknown>,
  name: string,
  body: Record<string, unknown>,
  now = new Date(),
): Promise<Record<string, unknown>> {
  const toolName = name.trim();
  if (!toolName || toolName.length > 128) {
    throw new CatalogError("tool name is invalid");
  }
  const overrides: Overrides = { ...overridesOf(server.overrides) };
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
    } else if (typeof body.default === "boolean") {
      edit.default = body.default;
    } else {
      throw new CatalogError("default must be a boolean or null");
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
  const updated = await updateConnector(db, String(server.id), { overrides }, now);
  if (!updated) {
    throw new CatalogError("mcp server not found", 404);
  }
  return updated;
}

/** The connector in the folder format: its manifest with the admin's overrides applied. */
export function exportManifest(server: Record<string, unknown>): Manifest {
  return server.manifest as Manifest;
}
