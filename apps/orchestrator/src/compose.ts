import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { ArtifactFiles, artifactStore } from "./artifacts/index.js";
import { AttachmentService } from "./attachments/index.js";
import { FileBlobStore, MemoryBlobStore } from "./lib/blob-store.js";
import { BuilderService } from "./builder/index.js";
import { CapabilityService } from "./capabilities/index.js";
import { decodeMasterKey, type AppConfig } from "./config/index.js";
import { connect } from "./seed/connect.js";
import { setOperatorEmail } from "./seed/operator.js";
import {
  extensionBlobStore,
  extensionConnectors,
  extensionModelCredentials,
  extensionPolicy,
  extensionSandboxes,
  type SandboxProvider,
  type ServerExtension,
} from "./extension.js";
import { AdmissionCoordinator } from "./generation/admission.js";
import { generationDatabase, GenerationLoop } from "./generation/index.js";
import { coreModelCredentials, modelProviderStore } from "./llm/credentials.js";
import { modelsDatabase, ModelsService } from "./llm/models.js";
import { layOutAgentHomes } from "./machines/layout.js";
import { mcpDatabase } from "./mcp/database.js";
import { McpPool, TOOLS_TTL_MS } from "./mcp/pool.js";
import { NotesStore } from "./notes/store.js";
import { startRuntimeMetrics } from "./observability/runtime.js";
import { OPEN_POLICY } from "./policy/index.js";
import { recipeApply } from "./recipes/apply.js";
import { RunSandboxes } from "./sandbox/index.js";
import { scheduleDatabase, Schedules } from "./schedules/service.js";
import { scriptDatabase, Scripts } from "./scripts/catalog.js";
import { StudioService } from "./studio/index.js";
import { installConnectors } from "./connectors/index.js";
import { syncCodeConnectors } from "./registry/code.js";
import { installIntegrations } from "./instance/integrations.js";
import { InstanceKeys } from "./instance/keys.js";
import { installHarnessesOff } from "./coding/harnesses.js";
import { refreshConnectorIntegrations, syncInstanceLogins } from "./connectors/instance.js";
import { listMachinePlacements } from "./db/machines.js";
import { attachmentDatabase } from "./attachments/store.js";
import { generationArtifacts } from "./generation/prepare.js";

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
  const db = database.pool;
  // Code on disk is loaded to match the registry rows. Their manifests are then listed as
  // integrations, which is what Platform keys offers.
  await syncCodeConnectors(db);
  await refreshConnectorIntegrations(db);
  const masterKey = decodeMasterKey(config.secretsMasterKey);
  const instanceKeys = new InstanceKeys(db, masterKey);
  // Filled before the login sync below, which reads this snapshot rather than the table.
  await instanceKeys.load();
  // A connector whose instance key is on gets a platform login. One whose integration is off
  // is disconnected.
  await syncInstanceLogins(db, masterKey);
  // Core caps nothing. An extension supplies the policy that does.
  const policy = extensionPolicy(extensions, { db }) ?? OPEN_POLICY;
  const artifacts = artifactStore(db, config.templatesRoot);
  const scripts = new Scripts(scriptDatabase(db));
  const schedules = new Schedules(scheduleDatabase(db));
  // Core reads the key stored for each organisation. An extension can answer with its own.
  const modelCredentials =
    extensionModelCredentials(extensions, { db }) ?? coreModelCredentials(modelProviderStore(db), masterKey);
  const models = new ModelsService({ db: modelsDatabase(db), credentials: modelCredentials, masterKey });
  // Tool lists stay cached for their ttl. Calls go through the forward proxy when one is set,
  // and the policy above caps the ones a platform login makes.
  const mcp = new McpPool(mcpDatabase(db), TOOLS_TTL_MS, process.env.ADAPTER_PROXY_URL ?? "");
  mcp.policy = policy;
  // An extension's manager, or one OpenSandbox manager for this box. Homes are laid out next,
  // and that step asks the manager to destroy sandboxes still running per agent.
  const sandboxes: SandboxProvider =
    extensionSandboxes(extensions, { db, config, masterKey }) ??
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
    placements: () => listMachinePlacements(db),
    workspaceRootFor: async (machineId) =>
      (await sandboxes.machineHost?.(machineId))?.workspaceRoot ?? config.workspaceRoot,
    destroyAgentSandboxes: sandboxes.destroyAgentSandboxes?.bind(sandboxes),
  });
  // Files when this box has a root for them, memory when it does not. An extension's store
  // replaces either.
  const blobs =
    extensionBlobStore(extensions, { config }) ??
    (config.attachmentsRoot ? new FileBlobStore(config.attachmentsRoot) : new MemoryBlobStore());
  const attachments = new AttachmentService(attachmentDatabase(db), blobs);
  const files = new ArtifactFiles(artifacts, blobs);
  // Agent runs, Studio sessions and Builder sessions share one cap on the generations in progress.
  const admission = new AdmissionCoordinator(config.maxConcurrentGenerations);
  const generation = new GenerationLoop({
    db: generationDatabase(db),
    notes,
    workspaceRoot: config.workspaceRoot,
    sandboxes,
    mcp,
    artifacts: generationArtifacts(artifacts),
    files,
    attachments,
    admission,
    policy,
    credentials: modelCredentials,
  });
  // Runs the restart cut off are settled before the scheduler can fire.
  await generation.reconcile();
  generation.runs.startScheduler();
  // An edit is published on the guild's group chat, and a session waits while its agent is
  // already generating.
  const studio = new StudioService({
    db,
    artifacts,
    scripts,
    schedules,
    notesSystemPath: notes.systemPath(),
    mcp,
    admission,
    policy,
    credentials: modelCredentials,
    publishFilesChanged: async (guildId) => {
      await generation.groupChat.publish(guildId, "guild.artifacts.changed", {
        scope: "agent",
        path: "task.md",
      });
    },
    publishRoutinesChanged: async (guildId, change) => {
      await generation.groupChat.publish(guildId, "agent.routines.changed", {
        agent_id: change.agentId,
        action: change.action,
        schedule_id: change.scheduleId,
      });
    },
    isAgentBusy: (agentId) => generation.isAgentBusy(agentId),
  });
  // A studio session left generating is continued by this process.
  await studio.reconcile();
  const capabilities = new CapabilityService(db, policy, models);
  const apply = recipeApply({
    db,
    artifacts,
    notes,
    scripts,
    schedules,
    policy,
    models,
  });
  const builder = new BuilderService({
    db,
    capabilities,
    apply,
    admission,
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
      db,
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
