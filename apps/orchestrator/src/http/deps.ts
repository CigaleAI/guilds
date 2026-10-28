import type { ArtifactFiles } from "../artifacts/files.js";
import type { ArtifactStore } from "../artifacts/store.js";
import type { Database } from "../db/client.js";
import type { OrgCreatedHook } from "../db/orgs.js";
import type { NotesStore } from "../notes/store.js";
import type { Scripts } from "../scripts/catalog.js";
import type { Schedules } from "../schedules/service.js";
import type { AppConfig } from "../config/index.js";
import type { McpPool } from "../mcp/pool.js";
import type { GenerationLoop } from "../generation/index.js";
import type { GenerationSandboxes } from "../generation/machines.js";
import type { StudioService } from "../studio/index.js";
import type { BuilderService } from "../builder/index.js";
import type { RecipeApply } from "../recipes/apply.js";
import type { CapabilityService } from "../capabilities/index.js";
import type { AttachmentService } from "../attachments/index.js";
import type { Integration } from "../instance/integrations.js";
import type { InstanceKeys } from "../instance/keys.js";
import type { ModelCredentialsProvider } from "../llm/credentials.js";
import type { ModelsService } from "../llm/models.js";
import type { IdentityProvider } from "./identity.js";
import type { InstanceAdmin } from "./instance-admin.js";
import type { OrgPolicy } from "../policy/index.js";
import type { RegistryClient } from "../registry/client.js";
import type { Queryable } from "../db/pg.js";

/** The services the routes run with: the app's, with the ones `buildApp` fills in when its caller leaves them out. */
export type RouteDeps = AppDeps & {
  artifacts: ArtifactStore;
  instanceKeys: InstanceKeys;
  modelCredentials: ModelCredentialsProvider;
  models: ModelsService;
};

export type AppDeps = {
  database: Database;
  db: Queryable;
  notes: NotesStore;
  artifacts?: ArtifactStore;
  /** The shared files over `artifacts` and the blob store. */
  files?: ArtifactFiles;
  scripts: Scripts;
  schedules: Schedules;
  config?: AppConfig;
  masterKey?: Buffer;
  mcp?: McpPool;
  generation?: GenerationLoop;
  attachments?: AttachmentService;
  sandboxes?: GenerationSandboxes;
  studio?: StudioService;
  capabilities?: CapabilityService;
  apply?: RecipeApply;
  builder?: BuilderService;
  /** Identifies a request's user in place of core's modes. */
  identity?: IdentityProvider;
  /** Who may administer the instance, in place of core's rule. */
  instanceAdmin?: InstanceAdmin;
  /** The registry connectors and recipes install from: the box's `REGISTRY_URL` when absent, offline when null. */
  registry?: RegistryClient | null;
  /** The caps organisations work under and whether they may work; core's open policy when absent. */
  policy?: OrgPolicy;
  /** The integrations this box may switch on; core's when absent. */
  integrations?: readonly Integration[];
  /** The store integrations' encrypted values; built over the database and `masterKey` when absent. */
  instanceKeys?: InstanceKeys;
  /** The credentials a model provider is called with for an organisation; core's own rows when absent. */
  modelCredentials?: ModelCredentialsProvider;
  /** The organisation's providers, chosen models, and default; built over `modelCredentials` when absent. */
  models?: ModelsService;
  /** Runs for every new organisation, inside the transaction that creates it; the extensions' hooks when absent. */
  orgCreated?: OrgCreatedHook;
};
