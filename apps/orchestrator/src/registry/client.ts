import { createHash } from "node:crypto";
import { endpointOnlyProblem, loadManifest, ManifestError, type Manifest } from "../connectors/manifest.js";
import { integrationVariable, REGISTRY } from "../instance/integrations.js";
import { proxyFetch, type FetchFn } from "../net/http.js";
import { parseRecipe, type RecipeDocument } from "../recipes/schema.js";
import type { KeyObject } from "node:crypto";
import {
  assertSigned,
  parseIndex,
  registryPublicKey,
  RegistryError,
  type RegistryConnectorEntry,
  type RegistryIndex,
  type RegistryRecipeEntry,
} from "./index.js";
import { PACKAGE_MAX_BYTES, readTarball } from "./tar.js";

/** The registry this box reads: `REGISTRY_URL`, the registry integration's default while unset, none (offline) when empty. */
export function registryUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return integrationVariable(REGISTRY, "REGISTRY_URL", env).replace(/\/+$/, "") || null;
}

/** The files of a package, with a single top-level directory taken off. */
function packageFiles(bytes: Buffer): Map<string, Buffer> {
  let files: Map<string, Buffer>;
  try {
    files = readTarball(bytes);
  } catch (error) {
    throw new RegistryError(error instanceof Error ? error.message : "package is unreadable");
  }
  const tops = new Set([...files.keys()].map((name) => (name.includes("/") ? name.split("/")[0] : "")));
  const [top] = [...tops];
  if (tops.size === 1 && top) {
    return new Map([...files].map(([name, body]) => [name.slice(top.length + 1), body]));
  }
  return files;
}

/** A connector package: its manifest, and the bundled adapter and logo when it ships them. */
export type ConnectorPackage = { manifest: Manifest; adapter: Buffer | null; logo: Buffer | null };

/**
 * Why a manifest whose package carries code claims what a runtime install may not, or null. Its
 * adapter runs in this process, so the box's own wiring stays out of reach of its manifest: no
 * instance key, and OAuth only with a dynamically registered client.
 */
export function codeManifestProblem(manifest: Manifest): string | null {
  if (manifest.auth.instance) {
    return `connector ${manifest.slug} asks for an instance key, which only a connector the box ships may use`;
  }
  if (manifest.auth.oauth && manifest.auth.oauth.strategy !== "dynamic") {
    return `connector ${manifest.slug} signs in with the box's ${manifest.auth.oauth.strategy} client; it must register its own`;
  }
  return null;
}

/**
 * Reads one registry: its index, connector packages, and recipe documents, each checked against
 * its hash. Given a public key, it refuses an index that key does not verify.
 */
export class RegistryClient {
  constructor(
    readonly baseUrl: string,
    private readonly fetchFn: FetchFn = proxyFetch("", 30_000),
    private readonly publicKey: KeyObject | null = null,
  ) {}

  /** Whether every index this client reads carries a signature its key verified. */
  get verifiesSignatures(): boolean {
    return this.publicKey !== null;
  }

  private async bytes(path: string, limit: number): Promise<Buffer> {
    const url = `${this.baseUrl}/${path}`;
    let response: Response;
    try {
      response = await this.fetchFn(url);
    } catch (error) {
      throw new RegistryError(`registry unreachable at ${url}: ${error instanceof Error ? error.message : String(error)}`, 502);
    }
    if (!response.ok) {
      throw new RegistryError(`registry answered ${response.status} for ${path}`, 502);
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > limit) {
      throw new RegistryError(`registry ${path} exceeds ${limit} bytes`, 502);
    }
    return body;
  }

  private async checked(entry: { path: string; sha256: string; size: number }): Promise<Buffer> {
    const body = await this.bytes(entry.path, PACKAGE_MAX_BYTES);
    if (body.length !== entry.size) {
      throw new RegistryError(`${entry.path} is ${body.length} bytes; the index says ${entry.size}`);
    }
    const digest = createHash("sha256").update(body).digest("hex");
    if (digest !== entry.sha256) {
      throw new RegistryError(`${entry.path} does not match the index's hash`);
    }
    return body;
  }

  async index(): Promise<RegistryIndex> {
    const body = await this.bytes("index.json", PACKAGE_MAX_BYTES);
    let raw: unknown;
    try {
      raw = JSON.parse(body.toString("utf8"));
    } catch {
      throw new RegistryError("registry index is not JSON", 502);
    }
    const index = parseIndex(raw);
    if (this.publicKey) {
      assertSigned(index, this.publicKey);
    }
    return index;
  }

  /**
   * A connector package, its manifest checked by the loader: endpoint-only when it carries no
   * code, and within `codeManifestProblem` when it carries a bundled `adapter.js`.
   */
  async connectorPackage(entry: RegistryConnectorEntry): Promise<ConnectorPackage> {
    const files = packageFiles(await this.checked(entry));
    if (files.has("adapter.ts")) {
      throw new RegistryError(`connector ${entry.slug} ships adapter.ts; a package carries the bundled adapter.js`);
    }
    const raw = files.get("connector.json");
    if (!raw) {
      throw new RegistryError(`connector ${entry.slug} package has no connector.json`);
    }
    let manifest: Manifest;
    try {
      manifest = loadManifest(JSON.parse(raw.toString("utf8")), entry.slug);
    } catch (error) {
      if (error instanceof ManifestError || error instanceof SyntaxError) {
        throw new RegistryError(error.message);
      }
      throw error;
    }
    const adapter = files.get("adapter.js") ?? null;
    const problem = adapter === null ? endpointOnlyProblem(manifest) : codeManifestProblem(manifest);
    if (problem !== null) {
      throw new RegistryError(problem);
    }
    return { manifest, adapter, logo: files.get("logo.svg") ?? null };
  }

  async recipe(entry: RegistryRecipeEntry): Promise<RecipeDocument> {
    const body = await this.checked(entry);
    try {
      return parseRecipe(JSON.parse(body.toString("utf8")));
    } catch (error) {
      throw new RegistryError(`recipe ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** This box's registry client, verifying with `REGISTRY_PUBLIC_KEY` when set; null while offline. */
export function registryClient(env: NodeJS.ProcessEnv = process.env, fetchFn?: FetchFn): RegistryClient | null {
  const url = registryUrl(env);
  if (url === null) {
    return null;
  }
  const key = integrationVariable(REGISTRY, "REGISTRY_PUBLIC_KEY", env);
  return new RegistryClient(url, fetchFn, key ? registryPublicKey(key) : null);
}
