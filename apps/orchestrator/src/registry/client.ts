import { createHash } from "node:crypto";
import { ManifestError, boxWiringProblem, endpointOnlyProblem, loadManifest } from "../connectors/manifest.js";
import type { Manifest } from "../db/schema/index.js";
import { integrationValue, REGISTRY } from "../instance/integrations.js";
import { proxyFetch, type FetchFn } from "../net/http.js";
import type { KeyObject } from "node:crypto";
import {
  assertSigned,
  parseIndex,
  registryPublicKey,
  RegistryError,
  RegistryFetchError,
  RegistryIndexError,
  RegistryPackageError,
  type RegistryConnectorEntry,
  type RegistryIndex,
  type RegistryRecipeEntry,
} from "./index.js";
import { PACKAGE_MAX_BYTES, readTarball } from "./tar.js";

/** The registry this box reads: `REGISTRY_URL`, the registry integration's default while unset, none (offline) when empty. */
export function registryUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return integrationValue(REGISTRY, "REGISTRY_URL", { env }).replace(/\/+$/, "") || null;
}

/** The files of a package, with a single top-level directory taken off. */
function packageFiles(bytes: Buffer): Map<string, Buffer> {
  const files = readTarball(bytes);
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
 * adapter runs in this process, so the box's own wiring stays out of reach of its manifest: a
 * shipped integration's key, the box's OAuth client, the GitHub App. A key or client it declares
 * of its own is the instance admin's to fill.
 */
export function codeManifestProblem(manifest: Manifest): string | null {
  return boxWiringProblem(manifest);
}

/**
 * Reads one registry: its index, connector packages, and recipe files, each checked against
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
      throw new RegistryFetchError(`registry unreachable at ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      throw new RegistryFetchError(`registry answered ${response.status} for ${path}`);
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > limit) {
      throw new RegistryFetchError(`registry ${path} exceeds ${limit} bytes`);
    }
    return body;
  }

  private async checked(entry: { path: string; sha256: string; size: number }): Promise<Buffer> {
    const body = await this.bytes(entry.path, PACKAGE_MAX_BYTES);
    if (body.length !== entry.size) {
      throw new RegistryPackageError(`${entry.path} is ${body.length} bytes; the index says ${entry.size}`);
    }
    const digest = createHash("sha256").update(body).digest("hex");
    if (digest !== entry.sha256) {
      throw new RegistryPackageError(`${entry.path} does not match the index's hash`);
    }
    return body;
  }

  async index(): Promise<RegistryIndex> {
    const body = await this.bytes("index.json", PACKAGE_MAX_BYTES);
    let raw: unknown;
    try {
      raw = JSON.parse(body.toString("utf8"));
    } catch {
      throw new RegistryIndexError("registry index is not JSON");
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
      throw new RegistryPackageError(`connector ${entry.slug} ships adapter.ts; a package carries the bundled adapter.js`);
    }
    const raw = files.get("connector.json");
    if (!raw) {
      throw new RegistryPackageError(`connector ${entry.slug} package has no connector.json`);
    }
    let manifest: Manifest;
    try {
      manifest = loadManifest(JSON.parse(raw.toString("utf8")), entry.slug);
    } catch (error) {
      if (error instanceof ManifestError || error instanceof SyntaxError) {
        throw new RegistryPackageError(error.message);
      }
      throw error;
    }
    const adapter = files.get("adapter.js") ?? null;
    const problem = adapter === null ? endpointOnlyProblem(manifest) : codeManifestProblem(manifest);
    if (problem !== null) {
      throw new RegistryPackageError(problem);
    }
    return { manifest, adapter, logo: files.get("logo.svg") ?? null };
  }

  /** A recipe's file as the registry serves it, checked against the index's size and hash. */
  recipeFile(entry: RegistryRecipeEntry): Promise<Buffer> {
    return this.checked(entry);
  }
}

/** The registry a change reads from; refused with a 409 while the box is offline. */
export function onlineRegistry(client: RegistryClient | null): RegistryClient {
  if (client === null) {
    throw new RegistryError("the box is offline: REGISTRY_URL is set empty", 409);
  }
  return client;
}

/** This box's registry client, verifying with `REGISTRY_PUBLIC_KEY` when set; null while offline. */
export function registryClient(env: NodeJS.ProcessEnv = process.env, fetchFn?: FetchFn): RegistryClient | null {
  const url = registryUrl(env);
  if (url === null) {
    return null;
  }
  const key = integrationValue(REGISTRY, "REGISTRY_PUBLIC_KEY", { env });
  return new RegistryClient(url, fetchFn, key ? registryPublicKey(key) : null);
}
