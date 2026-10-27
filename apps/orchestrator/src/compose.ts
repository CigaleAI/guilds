import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { ArtifactFiles, ArtifactStore } from "./artifacts/index.js";
import { AttachmentService } from "./attachments/index.js";
import { FileBlobStore, MemoryBlobStore } from "./lib/blob-store.js";
import { BuilderService } from "./builder/index.js";
import { CapabilityService } from "./capabilities/index.js";
import { decodeMasterKey, type AppConfig } from "./config/index.js";
import { connect } from "./db/client.js";
import { setOperatorEmail } from "./db/seed/operator.js";
import { Repositories } from "./db/repositories.js";
import {
  extensionBlobStore,
  extensionConnectors,
  extensionModelCredentials,
  extensionOrgCreated,
  extensionPolicy,
  extensionSandboxes,
  type SandboxProvider,
  type ServerExtension,
} from "./extension.js";
import { AdmissionCoordinator } from "./generation/admission.js";
import { GenerationLoop } from "./generation/index.js";
import { coreModelCredentials } from "./llm/credentials.js";
import { ModelsService } from "./llm/models.js";
import { layOutAgentHomes } from "./machines/layout.js";
import { McpPool, TOOLS_TTL_MS } from "./mcp/index.js";
import { NotesStore } from "./notes/store.js";
import { startRuntimeMetrics } from "./observability/runtime.js";
import { OPEN_POLICY } from "./policy/index.js";
import { RecipeApplyService } from "./recipes/apply.js";
import { RecipeStore } from "./recipes/store.js";
import { RunSandboxes } from "./sandbox/index.js";
import { Schedules } from "./schedules/service.js";
import { Scripts } from "./scripts/catalog.js";
import { StudioService } from "./studio/index.js";
import { installConnectors } from "./connectors/index.js";
import { syncCodeConnectors } from "./registry/code.js";
import { installIntegrations } from "./instance/integrations.js";
import { refreshConnectorIntegrations } from "./instance/connectors.js";
import { InstanceKeys } from "./instance/keys.js";
import { installHarnessesOff } from "./coding/harnesses.js";
import { syncInstanceLogins } from "./connectors/instance.js";

export type Server = {
  app: FastifyInstance;
  /** Closes the app, running generations, sandbox managers, and the database, in that order. */
  close(): Promise<void>;
};

/**
 * The composition root: connects, wires every service, reconciles what the previous process
 * left running, and builds the app. A caller passes its extensions here.
 */
export async function createServer(
  config: AppConfig,
  options: { extensions?: ServerExtension[] } = {},
): Promise<Server> {
  const extensions = options.extensions ?? [];
  // Process-wide, and read by code that has no handle on this server. An extension's connectors
  // and integrations join core's before anything looks them up.
  installConnectors(extensionConnectors(extensions));
  installIntegrations(extensions.flatMap((extension) => [...(extension.integrations ?? [])]));
  // A harness listed here stays in the image. It is neither offered nor run.
  installHarnessesOff(config.harnessesOff);
  // Core's migrations and seed, then each extension's, before a service reads the database.
  const database = await connect(config.databaseUrl, extensions);
  // Samples until close. The two paths are the disks it reports.
  const stopRuntimeMetrics = startRuntimeMetrics(database.pool, {
    root: "/",
    workspace: config.workspaceRoot,
  });
  // trusted-header auth identifies the box's first user by this address.
  if (config.operatorEmail) {
    await setOperatorEmail(database.pool, config.operatorEmail);
  }
  const notes = new NotesStore(config.notesRoot, config.templatesRoot);
  // The constructor does not touch the file. Boot refuses to start when the template is missing.
  await notes.ensureSystemPrompt();
  // An extension's hook runs in the transaction that inserts the organisation.
  const repo = new Repositories(database.pool, { orgCreated: extensionOrgCreated(extensions) });
  // Code on disk is loaded to match the registry rows. Their manifests are then listed as
  // integrations, which is what Platform keys offers.
  await syncCodeConnectors(repo);
  await refreshConnectorIntegrations(repo);
  const masterKey = decodeMasterKey(config.secretsMasterKey);
  const instanceKeys = new InstanceKeys(database.pool, masterKey);
  // Filled before the login sync below, which reads this snapshot rather than the table.
  await instanceKeys.load();
  // A connector whose instance key is on gets a platform login. One whose integration is off
  // is disconnected.
  await syncInstanceLogins(repo, masterKey);
  // Core caps nothing. An extension supplies the policy that does.
  const policy = extensionPolicy(extensions, { repo }) ?? OPEN_POLICY;
  const artifacts = new ArtifactStore(database.pool, config.templatesRoot);
  const scripts = new Scripts(repo);
  const schedules = new Schedules(repo);
  // Core reads the key stored for each organisation. An extension can answer with its own.
  const modelCredentials =
    extensionModelCredentials(extensions, { repo }) ?? coreModelCredentials(repo, masterKey);
  const models = new ModelsService({ repo, credentials: modelCredentials, masterKey });
  // Tool lists stay cached for their ttl. Calls go through the forward proxy when one is set,
  // and the policy above caps the ones a platform login makes.
  const mcp = new McpPool(TOOLS_TTL_MS, process.env.ADAPTER_PROXY_URL ?? "");
  mcp.policy = policy;
  // An extension's manager, or one OpenSandbox manager for this box. Homes are laid out next,
  // and that step asks the manager to destroy sandboxes still running per agent.
  const sandboxes: SandboxProvider =
    extensionSandboxes(extensions, { repo, config, masterKey }) ??
    new RunSandboxes({
      url: config.opensandboxUrl,
      apiKey: config.opensandboxApiKey,
      image: config.sandboxImage,
      workspaceRoot: config.workspaceRoot,
    });
  await sandboxes.start();
  // A home left at the workspace root moves into its machine's directory before a generation
  // can start.
  await layOutAgentHomes({
    placements: () => repo.listMachinePlacements(),
    workspaceRootFor: async (machineId) =>
      (await sandboxes.machineHost?.(machineId))?.workspaceRoot ?? config.workspaceRoot,
    destroyAgentSandboxes: sandboxes.destroyAgentSandboxes?.bind(sandboxes),
  });
  // Files when this box has a root for them, memory when it does not. An extension's store
  // replaces either.
  const blobs =
    extensionBlobStore(extensions, { config }) ??
    (config.attachmentsRoot ? new FileBlobStore(config.attachmentsRoot) : new MemoryBlobStore());
  const attachments = new AttachmentService(repo, blobs);
  const files = new ArtifactFiles(artifacts, blobs);
  const generation = new GenerationLoop(repo, notes, config.workspaceRoot, sandboxes, {
    mcp,
    artifacts,
    files,
    attachments,
    admission: new AdmissionCoordinator(config.maxConcurrentGenerations),
    policy,
    credentials: modelCredentials,
  });
  // Runs the restart cut off are settled before the scheduler can fire.
  await generation.reconcile();
  generation.startScheduler();
  // An edit is published on the guild's group chat, and a session waits while its agent is
  // already generating.
  const studio = new StudioService({
    repo,
    artifacts,
    scripts,
    schedules,
    notesSystemPath: notes.systemPath(),
    mcp,
    admission: generation.admission,
    policy,
    credentials: modelCredentials,
    publishFilesChanged: async (guildId) => {
      await generation.group_chat.publish(guildId, "guild.artifacts.changed", {
        scope: "agent",
        path: "task.md",
      });
    },
    publishRoutinesChanged: async (guildId, change) => {
      await generation.group_chat.publish(guildId, "agent.routines.changed", {
        agent_id: change.agentId,
        action: change.action,
        schedule_id: change.scheduleId,
      });
    },
    isAgentBusy: (agentId) => generation.agent_is_busy(agentId),
  });
  // A studio session left generating is continued by this process.
  await studio.reconcile();
  const recipes = new RecipeStore(repo.pool);
  const capabilities = new CapabilityService(repo, policy, models);
  const apply = new RecipeApplyService({
    repo,
    recipes,
    artifacts,
    notes,
    scripts,
    schedules,
    policy,
    models,
  });
  const builder = new BuilderService({
    repo,
    recipes,
    capabilities,
    apply,
    admission: generation.admission,
    policy,
    credentials: modelCredentials,
    mcp,
    guidelinesPath: notes.systemPath(),
  });
  // A builder session left generating is continued by this process.
  await builder.reconcile();
  const app = await buildApp(
    database,
    {
      repo,
      notes,
      artifacts,
      files,
      scripts,
      schedules,
      config,
      masterKey,
      instanceKeys,
      mcp,
      generation,
      attachments,
      sandboxes,
      studio,
      capabilities,
      recipes,
      apply,
      builder,
      policy,
      modelCredentials,
      models,
    },
    extensions,
  );
  return {
    app,
    async close() {
      await app.close();
      await generation.close();
      await sandboxes.close();
      stopRuntimeMetrics();
      await database.close();
    },
  };
}
