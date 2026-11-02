import { Value } from "typebox/value";
import {
  ManifestSchema,
  SLUG_PATTERN,
  type AuthField,
  type ListedTool,
  type Manifest,
  type ManifestSource,
  type ManifestTool,
} from "../db/schema/index.js";
import type { JsonValue } from "../lib/json.js";
import { offeredParameters } from "../lib/tool-schema.js";
import { assertPublicHttpsUrl, EndpointError } from "../net/endpoints.js";
import type { AdapterTool } from "./types.js";

export const SLUG_RE = new RegExp(SLUG_PATTERN);

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

/** The server id of a connector: `mcp_` and its slug. */
export function serverIdOf(slug: string): string {
  return `mcp_${slug}`;
}

/** The credential inputs a token login asks for: the manifest's, or one secret field named `token`. */
export function authFields(manifest: Manifest): AuthField[] {
  if (manifest.auth.kind !== "token") {
    return [];
  }
  return manifest.auth.fields ?? [{ name: "token", label: "API key", secret: true }];
}

/** Whether a remote tool name matches one of `patterns`; `*` matches any run of characters. */
export function matchesPattern(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const re = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return re.test(name);
  });
}

/**
 * Why a manifest installed at runtime reaches for the box's own wiring, or null when it does not:
 * a shipped integration's key, the box's OAuth client, or the GitHub App stay with the connectors
 * the box ships. A key or an OAuth client the connector declares of its own is not that: the
 * instance admin fills it in by name, for that connector alone.
 */
export function boxWiringProblem(manifest: Manifest): string | null {
  const instance = manifest.auth.instance;
  if (instance && "integration" in instance) {
    return `connector ${manifest.slug} asks for the box's ${instance.integration} key, which only a connector the box ships may use; a key of its own is declared with own`;
  }
  const oauth = manifest.auth.oauth;
  if (oauth?.strategy === "github_app") {
    return `connector ${manifest.slug} signs in with the box's GitHub App, which only a connector the box ships may use`;
  }
  if (oauth?.strategy === "configured" && oauth.provider) {
    return `connector ${manifest.slug} signs in with the box's ${oauth.provider} client; it declares a client of its own or registers one`;
  }
  return null;
}

/**
 * Why a manifest that arrives without code (a registry package) claims more than an endpoint-only
 * connector may, or null when it does not. It needs an endpoint the pool calls, nothing of the
 * box's wiring, and no state hook, which is adapter code.
 */
export function endpointOnlyProblem(manifest: Manifest): string | null {
  if (!manifest.endpoint) {
    return `connector ${manifest.slug} has no endpoint; without adapter code it needs one`;
  }
  const wiring = boxWiringProblem(manifest);
  if (wiring !== null) {
    return wiring;
  }
  if (manifest.state) {
    return `connector ${manifest.slug} declares a state hook, which needs adapter code`;
  }
  return null;
}

/**
 * Why a recipe's organisation server claims more than an organisation may hold, or null: it is
 * endpoint-only, and holds nothing at instance level, neither a platform key nor a configured
 * client. It signs in with a token or a dynamically registered client of the login's own.
 */
export function recipeManifestProblem(manifest: Manifest): string | null {
  const problem = endpointOnlyProblem(manifest);
  if (problem !== null) {
    return problem;
  }
  if (manifest.auth.instance) {
    return `connector ${manifest.slug} asks for an instance key, which an organisation's server cannot hold`;
  }
  if (manifest.auth.oauth && manifest.auth.oauth.strategy !== "dynamic") {
    return `connector ${manifest.slug} signs in with a configured client; an organisation's server registers its own`;
  }
  return null;
}

/**
 * Why the endpoint's headers clash, or null when they do not: header names are case-insensitive,
 * so two of them may not share a name, and none may take the name the credential travels in.
 */
function endpointHeaderProblem(manifest: Manifest): string | null {
  const taken = new Set([manifest.auth.header?.name.toLowerCase() ?? "authorization"]);
  for (const name of Object.keys(manifest.endpoint?.headers ?? {})) {
    if (taken.has(name.toLowerCase())) {
      return `connector ${manifest.slug} endpoint header ${name} is named twice or carries the credential`;
    }
    taken.add(name.toLowerCase());
  }
  return null;
}

/** Why the endpoint may not be called, or null when it may: its URL is public HTTPS. */
function endpointUrlProblem(manifest: Manifest): string | null {
  if (!manifest.endpoint) {
    return null;
  }
  try {
    assertPublicHttpsUrl(manifest.endpoint.url);
  } catch (error) {
    if (error instanceof EndpointError) {
      return `connector ${manifest.slug} endpoint: ${error.message}`;
    }
    throw error;
  }
  return null;
}

/**
 * Why the auth block contradicts its kind, or null when it does not: oauth has its block, and
 * credential fields and a platform key of its own go with token auth.
 */
function authKindProblem(manifest: Manifest): string | null {
  const { auth, slug } = manifest;
  if (auth.kind === "oauth" && !auth.oauth) {
    return `connector ${slug} uses oauth with no oauth block`;
  }
  if (auth.kind !== "token" && auth.fields) {
    return `connector ${slug} lists credential fields without token auth`;
  }
  if (auth.instance && "own" in auth.instance && auth.kind !== "token") {
    return `connector ${slug} declares a platform key of its own without token auth`;
  }
  return null;
}

/** Why a configured OAuth client of the connector's own cannot be used, or null: it needs an endpoint to discover its authorization server. */
function ownClientProblem(manifest: Manifest): string | null {
  const oauth = manifest.auth.oauth;
  if (oauth?.strategy === "configured" && !oauth.provider && !manifest.endpoint) {
    return `connector ${manifest.slug} signs in with a configured client of its own and needs an endpoint to discover its authorization server`;
  }
  return null;
}

/** Why the manifest's tools clash, or null when they do not: each name is listed once, with an object input schema. */
function toolsProblem(manifest: Manifest): string | null {
  const names = new Set<string>();
  for (const tool of manifest.tools ?? []) {
    if (names.has(tool.name)) {
      return `connector ${manifest.slug} lists tool ${tool.name} twice`;
    }
    names.add(tool.name);
    if (tool.input_schema.type !== "object") {
      return `connector ${manifest.slug} tool ${tool.name} input schema must be an object`;
    }
  }
  return null;
}

/** Why the settings schema cannot describe a settings document, or null when it can: it is an object. */
function settingsSchemaProblem(manifest: Manifest): string | null {
  if (manifest.settings_schema && manifest.settings_schema.type !== "object") {
    return `connector ${manifest.slug} settings schema must be an object`;
  }
  return null;
}

/** What a manifest that matches the schema is checked for next, in order; the first problem found is thrown. */
const MANIFEST_PROBLEMS: ReadonlyArray<(manifest: Manifest) => string | null> = [
  endpointUrlProblem,
  endpointHeaderProblem,
  authKindProblem,
  ownClientProblem,
  toolsProblem,
  settingsSchemaProblem,
];

/**
 * A listed tool with its input schema: for a tool `code` runs, the JSON Schema of the parameters
 * the code declares; for a tool the endpoint runs, the one its listing carries. Throws
 * `ManifestError` when the listing of a coded tool carries a schema, or that of an endpoint tool
 * carries none.
 */
function toolWithSchema(slug: string, listed: ListedTool, code: readonly AdapterTool[]): ManifestTool {
  const { input_schema, ...fields } = listed;
  const coded = code.find((tool) => tool.name === listed.name);
  if (coded !== undefined) {
    if (input_schema !== undefined) {
      throw new ManifestError(`connector ${slug} tool ${listed.name} lists an input_schema; its code declares its parameters`);
    }
    return { ...fields, input_schema: offeredParameters(coded.parameters) };
  }
  if (input_schema === undefined) {
    throw new ManifestError(`connector ${slug} tool ${listed.name} has no input_schema, and no code runs it`);
  }
  return { ...fields, input_schema };
}

/** The manifest a `connector.json` loads as: each tool it lists with its input schema, `code` declaring the schemas of those it runs. */
function loadedManifest(source: ManifestSource, code: readonly AdapterTool[]): Manifest {
  const { tools, ...fields } = source;
  if (tools === undefined) {
    return fields;
  }
  return { ...fields, tools: tools.map((tool) => toolWithSchema(source.slug, tool, code)) };
}

/**
 * Checks a parsed `connector.json`, the JSON as it arrives, against the schema and, when `folder`
 * is given, its slug against the folder name. `code` is the tools the connector's adapter runs,
 * whose input schemas are their declared parameters. Returns the manifest; throws
 * `ManifestError` naming the first problem.
 */
export function loadManifest(raw: JsonValue, folder?: string, code: readonly AdapterTool[] = []): Manifest {
  if (!Value.Check(ManifestSchema, raw)) {
    const [first] = Value.Errors(ManifestSchema, raw);
    const where = first ? `${first.instancePath || "/"}: ${first.message}` : "invalid";
    throw new ManifestError(`connector manifest ${folder ?? ""} ${where}`.replace(/\s+/g, " ").trim());
  }
  if (folder !== undefined && raw.slug !== folder) {
    throw new ManifestError(`connector slug ${raw.slug} does not match its folder ${folder}`);
  }
  const manifest = loadedManifest(raw, code);
  for (const problemOf of MANIFEST_PROBLEMS) {
    const problem = problemOf(manifest);
    if (problem !== null) {
      throw new ManifestError(problem);
    }
  }
  return manifest;
}
