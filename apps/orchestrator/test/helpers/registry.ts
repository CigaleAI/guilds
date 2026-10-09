import { createHash, generateKeyPairSync } from "node:crypto";
import { RegistryClient } from "../../src/registry/client.js";
import { registryPublicKey, signIndex, type RegistryIndex } from "../../src/registry/index.js";
import { packTarball } from "../../src/registry/tar.js";

/** A gzipped ustar archive of `files`, by path. */
export function tarball(files: Record<string, string | Buffer>): Buffer {
  return packTarball(
    Object.entries(files).map(([name, content]) => [name, Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8")] as const),
  );
}

/** An endpoint-only manifest under `slug`. */
export function endpointManifest(slug: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug,
    display_name: `Acme ${slug}`,
    endpoint: { url: `https://mcp.${slug}.example.com/mcp` },
    auth: { kind: "token" },
    description: `Acme's ${slug} records.`,
    ...extra,
  };
}

export type FakeRegistry = {
  client: RegistryClient;
  index: RegistryIndex;
  files: Map<string, Buffer>;
  /** Paths fetched, in order. */
  fetched: string[];
  /** Publishes a connector version, packaged from `files`. */
  connector(slug: string, version: string, files: Record<string, string | Buffer>, verified?: boolean): void;
  /** Publishes a recipe version. */
  recipe(name: string, version: string, document: unknown, verified?: boolean): void;
};

/** A fresh Ed25519 key pair: the public key as `REGISTRY_PUBLIC_KEY` holds it, the private as the signer does. */
export function registryKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}

/**
 * A registry served from memory at https://registry.test. With `signWith`, it serves its index
 * signed by that private key; with `verifyWith`, its client checks the signature.
 */
export function fakeRegistry(options: { signWith?: string; verifyWith?: string } = {}): FakeRegistry {
  const index: RegistryIndex = { generated_at: "2026-10-01T00:00:00Z", connectors: [], recipes: [] };
  const files = new Map<string, Buffer>();
  const fetched: string[] = [];
  const base = "https://registry.test";
  const client = new RegistryClient(base, async (url) => {
    const path = url.slice(base.length + 1);
    fetched.push(path);
    if (path === "index.json") {
      return new Response(JSON.stringify(options.signWith ? signIndex(index, options.signWith) : index), { status: 200 });
    }
    const body = files.get(path);
    return body ? new Response(new Uint8Array(body), { status: 200 }) : new Response("missing", { status: 404 });
  }, options.verifyWith ? registryPublicKey(options.verifyWith) : null);
  const entryOf = (path: string, body: Buffer) => ({
    path,
    sha256: createHash("sha256").update(body).digest("hex"),
    size: body.length,
  });
  return {
    client,
    index,
    files,
    fetched,
    connector(slug, version, packageFiles, verified = true) {
      const body = tarball(packageFiles);
      const path = `connectors/${slug}/${version}.tgz`;
      files.set(path, body);
      const manifest = JSON.parse(String(packageFiles["connector.json"] ?? packageFiles[`${slug}/connector.json`] ?? "{}")) as {
        display_name?: string;
        description?: string;
      };
      index.connectors.push({
        slug,
        version,
        ...entryOf(path, body),
        publisher: "acme",
        verified,
        display_name: manifest.display_name ?? slug,
        description: manifest.description ?? "",
      });
    },
    recipe(name, version, document, verified = true) {
      const body = Buffer.from(JSON.stringify(document), "utf8");
      const path = `recipes/${name}/${version}.json`;
      files.set(path, body);
      index.recipes.push({
        name,
        version,
        ...entryOf(path, body),
        publisher: "acme",
        verified,
        display_name: name,
        description: "",
      });
    },
  };
}
