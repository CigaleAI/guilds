import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { BlobStore } from "./lib/blob-store.js";
import type { AppConfig } from "./config/index.js";
import type { OrgCreatedHook } from "./db/orgs.js";
import type { Repositories } from "./db/repositories.js";
import type { GenerationSandboxes } from "./generation/index.js";
import type { AppDeps } from "./http/deps.js";
import type { IdentityProvider } from "./http/identity.js";
import type { InstanceAdmin } from "./http/instance-admin.js";
import type { ConnectorEntry } from "./connectors/registry.js";
import type { Integration } from "./instance/integrations.js";
import type { ModelCredentialsProvider } from "./llm/credentials.js";
import type { OrgPolicy } from "./policy/index.js";

/** The sandboxes agents run in, with the lifecycle the composition root drives. */
export type SandboxProvider = GenerationSandboxes & {
  start(): Promise<void>;
  close(): Promise<void>;
  /** Destroys every sandbox that runs one agent alone, labelled with `agent_id`; returns how many. */
  destroyAgentSandboxes?(): Promise<number>;
};

/** What an extension adds on top of core (docs/architecture/extension-points.md). Core runs with none. */
export type ServerExtension = {
  name: string;
  /** Applies the extension's own migrations, on every boot, after core's. */
  migrate?(pool: pg.Pool): Promise<void>;
  /** Runs on every boot, after core's seeds. */
  seed?(pool: pg.Pool): Promise<void>;
  /** Registers routes and hooks on the app, before core's routes. */
  routes?(app: FastifyInstance, deps: AppDeps): Promise<void>;
  /** The instance keys the extension reads, listed with core's. */
  integrations?: readonly Integration[];
  /** The connectors the extension ships, installed after core's; a slug core has fails boot. */
  connectors?: readonly ConnectorEntry[];
  /** Runs for every new organisation, inside the transaction that creates it. */
  orgCreated?: OrgCreatedHook;
  /** The organisation policy that replaces core's open one. */
  policy?(services: { repo: Repositories }): OrgPolicy;
  /** The credentials a model provider is called with for an organisation, in place of core's own rows. */
  modelCredentials?(services: { repo: Repositories }): ModelCredentialsProvider;
  /** The identity provider for this configuration, when the extension identifies requests itself. */
  identity?(deps: Pick<AppDeps, "repo" | "config">): IdentityProvider | undefined;
  /** Who may administer the instance, in place of core's rule. */
  instanceAdmin?(services: { repo: Repositories }): InstanceAdmin;
  /** The sandbox provider that replaces core's one OpenSandbox from the configuration. */
  sandboxes?(services: { repo: Repositories; config: AppConfig; masterKey: Buffer }): SandboxProvider;
  /** Where attachment bytes are kept, when the extension keeps them somewhere of its own. */
  blobStore?(services: { config: AppConfig }): BlobStore | undefined;
  /** The directory of the operator app's build this extension serves, in place of core's. */
  webApp?: string;
};

/** The connectors the extensions ship, in order. */
export function extensionConnectors(extensions: readonly ServerExtension[]): ConnectorEntry[] {
  return extensions.flatMap((extension) => [...(extension.connectors ?? [])]);
}

/** The operator app's build the extensions serve, if one names its own. */
export function extensionWebApp(extensions: readonly ServerExtension[]): string | undefined {
  return extensions.find((extension) => extension.webApp)?.webApp;
}

/** The attachment store the extensions supply, if one does. */
export function extensionBlobStore(
  extensions: readonly ServerExtension[],
  services: { config: AppConfig },
): BlobStore | undefined {
  for (const extension of extensions) {
    const store = extension.blobStore?.(services);
    if (store) {
      return store;
    }
  }
  return undefined;
}

/** The instance-admin rule the extensions supply, if one does. */
export function extensionInstanceAdmin(
  extensions: readonly ServerExtension[],
  services: { repo: Repositories },
): InstanceAdmin | undefined {
  for (const extension of extensions) {
    const instanceAdmin = extension.instanceAdmin?.(services);
    if (instanceAdmin) {
      return instanceAdmin;
    }
  }
  return undefined;
}

/** The sandbox provider the extensions supply, if one does. */
export function extensionSandboxes(
  extensions: readonly ServerExtension[],
  services: { repo: Repositories; config: AppConfig; masterKey: Buffer },
): SandboxProvider | undefined {
  for (const extension of extensions) {
    const sandboxes = extension.sandboxes?.(services);
    if (sandboxes) {
      return sandboxes;
    }
  }
  return undefined;
}

/** The identity provider the extensions supply, if one does. */
export function extensionIdentity(
  extensions: readonly ServerExtension[],
  deps: Pick<AppDeps, "repo" | "config">,
): IdentityProvider | undefined {
  for (const extension of extensions) {
    const identity = extension.identity?.(deps);
    if (identity) {
      return identity;
    }
  }
  return undefined;
}

/** The extensions' hooks for a new organisation as one, run in order; undefined when none has one. */
export function extensionOrgCreated(extensions: readonly ServerExtension[]): OrgCreatedHook | undefined {
  const hooks = extensions.flatMap((extension) => (extension.orgCreated ? [extension.orgCreated] : []));
  if (!hooks.length) {
    return undefined;
  }
  return async (client, org, now) => {
    for (const hook of hooks) {
      await hook(client, org, now);
    }
  };
}

/** The model credentials provider the extensions supply, if one does. */
export function extensionModelCredentials(
  extensions: readonly ServerExtension[],
  services: { repo: Repositories },
): ModelCredentialsProvider | undefined {
  for (const extension of extensions) {
    const credentials = extension.modelCredentials?.(services);
    if (credentials) {
      return credentials;
    }
  }
  return undefined;
}

/** The organisation policy the extensions supply, if one does. */
export function extensionPolicy(
  extensions: readonly ServerExtension[],
  services: { repo: Repositories },
): OrgPolicy | undefined {
  for (const extension of extensions) {
    const policy = extension.policy?.(services);
    if (policy) {
      return policy;
    }
  }
  return undefined;
}
