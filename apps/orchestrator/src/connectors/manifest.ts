import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { assertPublicHttpsUrl, EndpointError } from "../net/endpoints.js";

/** A connector slug: also the folder name, the server id after `mcp_`, and a folder connector's tool prefix. */
export const SLUG_PATTERN = "^[a-z][a-z0-9_]{0,62}$";
export const SLUG_RE = new RegExp(SLUG_PATTERN);

const JsonObject = Type.Record(Type.String(), Type.Unknown());

const ManifestTool = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    description: Type.String(),
    input_schema: JsonObject,
    mutating: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const AuthField = Type.Object(
  {
    name: Type.String({ pattern: "^[a-z][a-z0-9_]*$" }),
    label: Type.String({ minLength: 1 }),
    secret: Type.Optional(Type.Boolean()),
    optional: Type.Optional(Type.Boolean()),
    multiline: Type.Optional(Type.Boolean()),
    placeholder: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const Auth = Type.Object(
  {
    kind: Type.Union([Type.Literal("token"), Type.Literal("oauth"), Type.Literal("none")]),
    fields: Type.Optional(Type.Array(AuthField, { minItems: 1 })),
    header: Type.Optional(Type.Object({ name: Type.String({ minLength: 1 }), prefix: Type.String() }, { additionalProperties: false })),
    oauth: Type.Optional(
      Type.Object(
        {
          strategy: Type.Union([Type.Literal("dynamic"), Type.Literal("configured"), Type.Literal("github_app")]),
          provider: Type.Optional(Type.String({ minLength: 1 })),
          scopes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        },
        { additionalProperties: false },
      ),
    ),
    instance: Type.Optional(
      Type.Union([
        Type.Object(
          { integration: Type.String({ minLength: 1 }), field: Type.String({ pattern: "^[a-z][a-z0-9_]*$" }) },
          { additionalProperties: false },
        ),
        Type.Object({ own: Type.Literal(true) }, { additionalProperties: false }),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const ManifestSchema = Type.Object(
  {
    slug: Type.String({ pattern: SLUG_PATTERN }),
    display_name: Type.String({ minLength: 1 }),
    endpoint: Type.Optional(Type.Object({ url: Type.String({ minLength: 1 }) }, { additionalProperties: false })),
    auth: Auth,
    requires: Type.Optional(Type.Object({ integration: Type.String({ minLength: 1 }) }, { additionalProperties: false })),
    description: Type.String(),
    limitations: Type.Optional(Type.String()),
    setup_hint: Type.Optional(Type.String()),
    tools: Type.Optional(Type.Array(ManifestTool)),
    policy: Type.Optional(Type.Object({ default_off: Type.Array(Type.String({ minLength: 1 })) }, { additionalProperties: false })),
    settings_schema: Type.Optional(JsonObject),
    state: Type.Optional(
      Type.Object({ key: Type.String({ pattern: "^[a-z][a-z0-9_]*$" }), intro: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    ),
    builder: Type.Optional(
      Type.Object(
        {
          searchable: Type.Optional(Type.Boolean()),
          role: Type.Optional(Type.String({ minLength: 1 })),
          guidance: Type.Optional(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
    prompt: Type.Optional(Type.Object({ guidance: Type.String({ minLength: 1 }) }, { additionalProperties: false })),
  },
  { additionalProperties: false },
);

export type Manifest = Static<typeof ManifestSchema>;
export type ManifestTool = Static<typeof ManifestTool>;
export type AuthField = Static<typeof AuthField>;

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
 * Checks a parsed `connector.json` against the schema and, when `folder` is given, its slug against
 * the folder name. Returns the manifest; throws `ManifestError` naming the first problem.
 */
export function loadManifest(raw: unknown, folder?: string): Manifest {
  if (!Value.Check(ManifestSchema, raw)) {
    const first = Value.Errors(ManifestSchema, raw).First();
    const where = first ? `${first.path || "/"}: ${first.message}` : "invalid";
    throw new ManifestError(`connector manifest ${folder ?? ""} ${where}`.replace(/\s+/g, " ").trim());
  }
  const manifest = raw;
  if (folder !== undefined && manifest.slug !== folder) {
    throw new ManifestError(`connector slug ${manifest.slug} does not match its folder ${folder}`);
  }
  if (manifest.endpoint) {
    try {
      assertPublicHttpsUrl(manifest.endpoint.url);
    } catch (error) {
      if (error instanceof EndpointError) {
        throw new ManifestError(`connector ${manifest.slug} endpoint: ${error.message}`);
      }
      throw error;
    }
  }
  if (manifest.auth.kind === "oauth" && !manifest.auth.oauth) {
    throw new ManifestError(`connector ${manifest.slug} uses oauth with no oauth block`);
  }
  if (manifest.auth.kind !== "token" && manifest.auth.fields) {
    throw new ManifestError(`connector ${manifest.slug} lists credential fields without token auth`);
  }
  if (manifest.auth.instance && "own" in manifest.auth.instance && manifest.auth.kind !== "token") {
    throw new ManifestError(`connector ${manifest.slug} declares a platform key of its own without token auth`);
  }
  if (manifest.auth.oauth?.strategy === "configured" && !manifest.auth.oauth.provider && !manifest.endpoint) {
    throw new ManifestError(
      `connector ${manifest.slug} signs in with a configured client of its own and needs an endpoint to discover its authorization server`,
    );
  }
  const names = new Set<string>();
  for (const tool of manifest.tools ?? []) {
    if (names.has(tool.name)) {
      throw new ManifestError(`connector ${manifest.slug} lists tool ${tool.name} twice`);
    }
    names.add(tool.name);
    if (tool.input_schema.type !== "object") {
      throw new ManifestError(`connector ${manifest.slug} tool ${tool.name} input schema must be an object`);
    }
  }
  if (manifest.settings_schema && manifest.settings_schema.type !== "object") {
    throw new ManifestError(`connector ${manifest.slug} settings schema must be an object`);
  }
  return manifest;
}
