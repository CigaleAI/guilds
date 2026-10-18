import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { ArtifactStore } from "./artifacts/index.js";
import { AttachmentService, FileBlobStore, MemoryBlobStore } from "./attachments/index.js";
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
 * left running, and builds the app. An edition starts from here with its extensions.
 */
export async function createServer(
  config: AppConfig,
  options: { extensions?: ServerExtension[] } = {},
): Promise<Server> {
  const extensions = options.extensions ?? [];
  installConnectors(extensionConnectors(extensions));
  installIntegrations(extensions.flatMap((extension) => [...(extension.integrations ?? [])]));
  installHarnessesOff(config.harnessesOff);
  const database = await connect(config.databaseUrl, extensions);
  const stopRuntimeMetrics = startRuntimeMetrics(database.pool, {
    root: "/",
    workspace: config.workspaceRoot,
  });
  if (config.operatorEmail) {
    await setOperatorEmail(database.pool, config.operatorEmail);
  }
  const notes = new NotesStore(config.notesRoot, config.templatesRoot, config.obsidianVaultName);
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool, { orgCreated: extensionOrgCreated(extensions) });
  await syncCodeConnectors(repo);
  await refreshConnectorIntegrations(repo);
  const masterKey = decodeMasterKey(config.secretsMasterKey);
  const instanceKeys = new InstanceKeys(database.pool, masterKey);
  await instanceKeys.load();
  await syncInstanceLogins(repo, masterKey);
  const policy = extensionPolicy(extensions, { repo }) ?? OPEN_POLICY;
  const artifacts = new ArtifactStore(database.pool, config.templatesRoot);
  const scripts = new Scripts(repo);
  const schedules = new Schedules(repo, notes);
  const modelCredentials = extensionModelCredentials(extensions, { repo }) ?? coreModelCredentials(repo, masterKey);
  const models = new ModelsService({ repo, credentials: modelCredentials, masterKey });
  const mcp = new McpPool(TOOLS_TTL_MS, process.env.ADAPTER_PROXY_URL ?? "");
  mcp.policy = policy;
  const sandboxes: SandboxProvider =
    extensionSandboxes(extensions, { repo, config, masterKey }) ??
    new RunSandboxes({
      url: config.opensandboxUrl,
      apiKey: config.opensandboxApiKey,
      image: config.sandboxImage,
      workspaceRoot: config.workspaceRoot,
    });
  await sandboxes.start();
  await layOutAgentHomes({
    placements: () => repo.listMachinePlacements(),
    workspaceRootFor: async (machineId) =>
      (await sandboxes.machineHost?.(machineId))?.workspaceRoot ?? config.workspaceRoot,
    destroyAgentSandboxes: sandboxes.destroyAgentSandboxes?.bind(sandboxes),
  });
  const attachments = new AttachmentService(
    repo,
    extensionBlobStore(extensions, { config }) ??
      (config.attachmentsRoot ? new FileBlobStore(config.attachmentsRoot) : new MemoryBlobStore()),
  );
  const generation = new GenerationLoop(repo, notes, config.workspaceRoot, sandboxes, {
    mcp,
    artifacts,
    attachments,
    admission: new AdmissionCoordinator(config.maxConcurrentGenerations),
    policy,
    credentials: modelCredentials,
  });
  await generation.reconcile();
  generation.startScheduler();
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
      await generation.group_chat.publish(guildId, "guild.files.changed", {
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
  });
  await builder.reconcile();
  const app = await buildApp(
    database,
    {
      repo,
      notes,
      artifacts,
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
