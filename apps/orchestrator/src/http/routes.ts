import { existsSync, renameSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { persistAgent } from "../agents/persist.js";
import {
  AgentValidationError,
  browserLanguageOf,
  maxScriptsOf,
  maxWorkspaceMibOf,
  validateAvatarColor,
  validateAvatarShape,
  assertCodingAgent,
  validateConfig,
  withCodingLimits,
  validateFocus,
  validateAgentName,
  validateWakeTriggers,
} from "../agents/validation.js";
import { asBuffer, decryptPayload, encryptPayload } from "../credentials/crypto.js";
import {
  bindingItem,
  connectionMetadata,
  serverItem,
} from "../credentials/items.js";
import {
  CredentialError,
  secretPayload,
  validateOwner,
  validateSecretDescription,
  validateSecretName,
} from "../credentials/validate.js";
import {
  AttachmentError,
  MAX_ATTACHMENT_BYTES,
  attachmentDisposition,
  attachmentPayload,
  inlineDisposition,
} from "../attachments/index.js";
import type { AttachmentRef } from "../attachments/index.js";
import { jsonObj } from "../db/json.js";
import { userActor } from "../db/config-changes.js";
import { newId } from "../lib/ids.js";
import { EventQueue } from "../lib/event.js";
import { awaitingSettings, markDisconnected } from "../mcp/index.js";
import { connect, ConnectError, connectFailure, tokenCredentials } from "../connectors/connect.js";
import { settingsComplete, SettingsError, validateSettings } from "../connectors/settings.js";
import type { Manifest } from "../connectors/manifest.js";
import { DESCRIPTION_MAX } from "../mcp/catalog.js";
import { installedConnectors } from "../connectors/index.js";
import { logoPath } from "../connectors/view.js";
import { callOwnedConnectionTool, OperatorCallError } from "../mcp/operator-call.js";
import {
  OAuthError,
  OAuthUnsupportedError,
  accountHint,
  authorizationUrl,
  ensureClient,
  exchangeCode,
  githubInstallationPickerHtml,
  oauthCallbackHtml,
  oauthCallbackUrl,
  pendingOauth,
  pendingOauthPayload,
  pendingReplaces,
  pkcePair,
  newState,
  isGithubApp,
  startsBrowserOauth,
  tokenPayload,
} from "../oauth/index.js";
import {
  BindingError,
  validateBinding,
  validateCatalog,
  validateScope,
} from "../access/index.js";
import { RunRequestError, type GenerationLoop } from "../generation/index.js";
import { GroupChatError } from "../groupchat/index.js";
import {
  canManageMembers,
  canManageOwners,
  canManageSettings,
  memberItem,
  OrgValidationError,
  orgItem,
  validateOrgName,
  validateRole,
  validateSlug,
} from "../organisations/index.js";
import { persistGuild } from "../guilds/persist.js";
import {
  GuildAgentLimitError,
  GuildValidationError,
  assertGuildAgentRoom,
  canSeeGuild,
  guildOperators,
  validateAbout,
  validateGuildDescription,
  validateGitAuthorEmail,
  validateGuildName,
  validateGuildOperatorRole,
  validateMaxAgents,
  validateRoutinesEnabled,
  validateVisibility,
} from "../guilds/validation.js";
import {
  ArtifactError,
  displayPathFor,
  inspectTaskEmbeds,
  listFileChanges,
  taskEmbedActor,
} from "../artifacts/index.js";
import { NotesError } from "../notes/store.js";
import { scriptItem } from "../scripts/catalog.js";
import { ScriptError } from "../scripts/validation.js";
import { scheduleItem } from "../schedules/item.js";
import { ScheduleError } from "../schedules/cron.js";
import { scheduleChanges, type ScheduleChanges } from "../schedules/service.js";
import { installedIntegrations, integrationStatuses } from "../instance/integrations.js";
import { registerAdminInstanceRoutes } from "./admin-instance-routes.js";
import { Issues, IssueError } from "../issues/index.js";
import { Notifications } from "../notifications/index.js";
import { usageFields } from "../usage.js";
import { usageForOrg } from "./usage-view.js";
import { registerStudioRoutes } from "./studio-routes.js";
import { registerFileRoutes } from "./file-routes.js";
import { publishGroup } from "./publish.js";
import {
  SEED_USER_IDS,
  userItem,
  UserValidationError,
  validateUserEmail,
  validateUserName,
} from "../users/index.js";
import { messageItem } from "../db/views.js";
import { memoryHistory } from "../memory/history.js";
import { isUniqueViolation } from "../db/pg.js";
import { GuildNameTaken, LastGuildAdmin, LastOrgOwner, SecretNameTaken } from "../db/errors.js";
import { assertCanPlaceOn } from "../machines/access.js";
import type { AgentNeeds, MachineRow } from "../machines/index.js";
import {
  SecretAccessError,
  accessOf,
  canCreateSecret,
  canManageSecret,
  managesOrgSecrets,
  secretGrants,
  secretMetadata,
  validateSecretAccess,
  type SecretAccess,
  type SecretViewer,
} from "../secrets/access.js";
import { ModelNotConnectedError, assertModelConnected, coreModelCredentials } from "../llm/credentials.js";
import {
  LimitError,
  OPEN_POLICY,
  PolicyError,
  assertCanCreateAgent,
  assertCanCreateGuild,
  assertCanEnableBrowser,
  assertCanEnableCoding,
  assertCanPlaceAgents,
} from "../policy/index.js";
import type { AppDeps } from "./deps.js";
import { httpAccess } from "./access.js";
import { proxyHttp, startSandboxWsProxy } from "./sandbox-proxy.js";
import { HttpError, missingBodyFields, notesReadHttp, notesWriteHttp } from "./errors.js";
import {
  addRecord,
  catchArtifact,
  clearRecords,
  createCollection,
  deleteCollection,
  deleteHostFile,
  ensureAgentArtifacts,
  exportCollection,
  getCollection,
  getRecord,
  listCollections,
  listHostFiles,
  listRecords,
  latestFileChanges,
  operatorFor,
  readHostFile,
  removeRecord,
  requireArtifacts,
  updateCollection,
  updateRecord,
  writeHostFile,
} from "./artifact-notes.js";
import { registerCodingRoutes } from "./coding-routes.js";
import { registerMeRoutes } from "./me-routes.js";
import { registerModelProviderRoutes } from "./model-provider-routes.js";
import {
  clearGithubOauthStateCookie,
  exchangeUserCode,
  GITHUB_OAUTH_STATE_COOKIE,
  GITHUB_SERVER_ID,
  GITHUB_SLUG,
  githubAppConfig,
  githubOauthStateCookie,
  GithubError,
  installUrl,
  requireGithubApp,
  resolveGithubInstallation,
  userAuthorizationUrl,
  type GithubInstallation,
} from "../github/index.js";
import { registerAdminMcpRoutes } from "./admin-mcp-routes.js";
import { registerAdminRegistryRoutes } from "./admin-registry-routes.js";
import { registerOrgConnectorRoutes } from "./org-connector-routes.js";
import { machineIdOf, registerMachineRoutes } from "./machine-routes.js";
import { registerBuilderCapabilityRoutes } from "./builder-capability-routes.js";
import { registerBuilderSessionRoutes } from "./builder-routes.js";
import { registerRecipeRoutes } from "./recipe-routes.js";
import { cookieSecure, requestCookies } from "./cookies.js";
import { currentOrg, currentUser, type IdentityRequest } from "./identity.js";
import { isInstanceAdmin } from "./instance-admin.js";
import {
  administeredGuild,
  agentConfigObject,
  agentItem,
  agentWithAccess,
  ownedAgent,
  ownedGuild,
  ownedRun,
  guildItem,
} from "./items.js";
import { frameSse, SSE_HEADERS } from "./sse.js";
import { bodyOf, param } from "./request.js";

type Params = Record<string, string>;

/** Answers a connector's failure as HTTP: a rejected credential or a bad setting is a 422, anything else upstream a 502. */
function failure(error: unknown, server: Record<string, unknown>): never {
  try {
    connectFailure(error, server);
  } catch (mapped) {
    if (mapped instanceof ConnectError) {
      throw new HttpError(mapped.status, mapped.message);
    }
    throw mapped;
  }
}

/** Whether an organisation sees a server: the platform's, or one of its own. */
function serverVisible(server: Record<string, unknown>, orgId: string | null): boolean {
  return !server.owner_org_id || server.owner_org_id === orgId;
}

function attachmentIdsOf(body: Record<string, unknown>): string[] {
  const raw = body.attachment_ids;
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new HttpError(422, "attachment_ids must be an array");
  }
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) {
      throw new HttpError(422, "attachment_ids must be attachment ids");
    }
    ids.push(item.trim());
  }
  return ids;
}

function attachmentsOf(deps: AppDeps) {
  if (!deps.attachments) {
    throw new HttpError(503, "attachments are not configured");
  }
  return deps.attachments;
}

function agentModelOf(row: Record<string, unknown>): string {
  const config = jsonObj(row.config);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return "";
  }
  const model = (config as Record<string, unknown>).model;
  return typeof model === "string" ? model : "";
}

async function resolveChatAttachments(
  deps: AppDeps,
  orgId: string,
  model: string,
  ids: string[],
): Promise<AttachmentRef[]> {
  if (!ids.length) {
    return [];
  }
  try {
    return await attachmentsOf(deps).resolveForMessage({ orgId, model, ids });
  } catch (error) {
    if (error instanceof AttachmentError) {
      throw new HttpError(error.status, error.message);
    }
    throw error;
  }
}

function expectedVersionOf(body: Record<string, unknown>): number | undefined {
  const value = body.expected_version;
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new HttpError(422, "expected_version must be an integer");
  }
  return n;
}

/** How often operator input on a proxied sandbox view restarts its idle timer. */
const SANDBOX_TOUCH_INTERVAL_MS = 30_000;

function filePathParam(request: FastifyRequest): string {
  const raw = (request.raw.url ?? request.url).split("?")[0] ?? "";
  let pathname = raw;
  try {
    pathname = decodeURIComponent(raw);
  } catch {
    /* keep the undecoded path */
  }
  if (pathname.split("/").includes("..")) {
    throw new HttpError(404, "Not Found");
  }
  const params = request.params as Params;
  const fromParams = params["*"] ?? params.file_path;
  if (typeof fromParams === "string" && fromParams) {
    return fromParams;
  }
  const marker = "/notes/";
  const index = pathname.lastIndexOf(marker);
  if (index >= 0) {
    return pathname.slice(index + marker.length);
  }
  return "";
}

async function send(reply: FastifyReply, status: number, payload?: unknown): Promise<FastifyReply> {
  if (status === 204) {
    return reply.code(204).send();
  }
  return reply.code(status).send(payload);
}

function queryOf(request: FastifyRequest): Record<string, string> {
  const query = request.query;
  if (query && typeof query === "object" && !Array.isArray(query)) {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
      if (value === undefined || value === null) {
        continue;
      }
      out[key] = String(value);
    }
    return out;
  }
  return {};
}

function generationOf(deps: AppDeps): GenerationLoop {
  if (!deps.generation) {
    throw new HttpError(503, "generation is unavailable");
  }
  return deps.generation;
}

function groupHttp(error: GroupChatError): HttpError {
  return new HttpError(error.status, error.detail);
}

/** How a routine change reads on the guild's stream: a pause or resume alone, or an edit. */
function routineAction(changes: ScheduleChanges): string {
  const fields = Object.keys(changes).filter((key) => key !== "paused");
  if (fields.length || changes.paused === undefined) {
    return "edit";
  }
  return changes.paused ? "pause" : "resume";
}

async function scopeGuild(
  repo: AppDeps["repo"],
  scope: string,
  scopeId: string | null,
  user: Record<string, unknown>,
): Promise<string | null> {
  if (scope === "platform") {
    throw new HttpError(400, "platform bindings cannot be changed here");
  }
  if (scope === "org") {
    const membership = await repo.getMembership(scopeId || "", String(user.id));
    if (membership === null) {
      throw new HttpError(404, "organisation not found");
    }
    return null;
  }
  if (scope === "guild") {
    const row = await ownedGuild(repo, scopeId || "", user);
    return String(row.id);
  }
  const row = await ownedAgent(repo, scopeId || "", user);
  return String(row.guild_id);
}

function busy(deps: AppDeps, agentId: string): boolean {
  return deps.generation?.agent_is_busy(agentId) ?? false;
}

async function agentPayload(
  deps: AppDeps,
  row: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const access = await httpAccess(deps.repo, {
    orgId: String(row.org_id),
    guildId: String(row.guild_id),
    agentId: String(row.id),
    viewScope: "agent",
    mcp: deps.mcp ?? null,
  });
  return agentWithAccess(deps.repo, row, {
    generating: busy(deps, String(row.id)),
    access,
  });
}

async function pipeSse(
  request: FastifyRequest,
  reply: FastifyReply,
  subscribe: () => EventQueue<[string, Record<string, unknown>]>,
  unsubscribe: (queue: EventQueue<[string, Record<string, unknown>]>) => void,
): Promise<void> {
  const queue = subscribe();
  reply.hijack();
  reply.raw.writeHead(200, SSE_HEADERS);
  reply.raw.write(": connected\n\n");
  const abort = new AbortController();
  const onClose = () => {
    abort.abort();
  };
  request.raw.on("close", onClose);
  try {
    while (!abort.signal.aborted) {
      const [event, data] = await queue.get(abort.signal);
      reply.raw.write(frameSse(event, data));
    }
  } catch {
    /* client disconnected or aborted */
  } finally {
    request.raw.off("close", onClose);
    unsubscribe(queue);
  }
}

async function setOperator(
  repo: AppDeps["repo"],
  guildId: string,
  userId: string,
  role: "admin" | "operator" | null,
): Promise<Record<string, unknown>> {
  try {
    const row = await repo.setGuildOperator(guildId, userId, role, new Date());
    if (row === null) {
      throw new HttpError(404, "guild not found");
    }
    return row;
  } catch (error) {
    if (error instanceof LastGuildAdmin || error instanceof GuildNameTaken) {
      throw new HttpError(409, error.message);
    }
    throw error;
  }
}

/** Runs an owner change, answering 409 when it would leave the organisation without an owner. */
async function refuseLastOrgOwner<T>(change: () => Promise<T>): Promise<T> {
  try {
    return await change();
  } catch (error) {
    if (error instanceof LastOrgOwner) {
      throw new HttpError(409, error.message);
    }
    throw error;
  }
}

// Leaving a guild without an admin would strand it, so removing the user
// waits until another admin is named.
async function refuseSoleGuildAdmin(
  repo: AppDeps["repo"],
  userId: string,
  orgId: string | null,
): Promise<void> {
  const guilds = await repo.soleAdminGuilds(userId, orgId);
  if (guilds.length) {
    const names = guilds.map((guild) => String(guild.name)).join(", ");
    throw new HttpError(409, `user is the only admin of ${names}; name another admin first`);
  }
}

export async function registerDomainRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { repo, notes, scripts, schedules, artifacts } = deps;
  const policy = deps.policy ?? OPEN_POLICY;
  const modelCredentials = deps.modelCredentials ?? coreModelCredentials(repo, deps.masterKey);
  const issues = new Issues(repo);
  const notifications = new Notifications(repo);

  /**
   * The machine an agent goes on, with the policy's per-machine cap: the one named, else the
   * agent's current one, else the organisation's only one. A machine other than the current one
   * must take one more agent and host no agent of a guild the user cannot see.
   */
  async function placement(
    orgId: string,
    user: Record<string, unknown>,
    requested: unknown,
    agent: { needs: AgentNeeds; machineId?: string },
  ): Promise<{ machine: MachineRow; maxAgentsPerMachine: number | null; moves: boolean }> {
    const machine = await repo.placementMachine(orgId, machineIdOf(requested) ?? agent.machineId, agent.needs);
    if (machine.id === agent.machineId) {
      return { machine, maxAgentsPerMachine: null, moves: false };
    }
    await assertCanPlaceOn(repo, orgId, machine.id, String(user.id));
    const maxAgentsPerMachine = await assertCanPlaceAgents(policy, repo, orgId, machine.id, 1);
    return { machine, maxAgentsPerMachine, moves: true };
  }
  deps.generation?.group_chat.observe((guildId, event, data) => notifications.observe(guildId, event, data));
  await registerMeRoutes(app, deps);
  await registerCodingRoutes(app, deps);
  await registerModelProviderRoutes(app, deps);
  await registerStudioRoutes(app, deps);
  await registerFileRoutes(app, deps);
  await registerAdminMcpRoutes(app, deps);
  await registerAdminRegistryRoutes(app, deps);
  await registerAdminInstanceRoutes(app, deps);
  await registerOrgConnectorRoutes(app, deps);
  await registerMachineRoutes(app, deps);
  await registerBuilderCapabilityRoutes(app, deps);
  await registerBuilderSessionRoutes(app, deps);
  await registerRecipeRoutes(app, deps);

  app.addHook("onSend", async (request, reply, payload) => {
    deps.identity?.onSend?.(request, reply);
    return payload;
  });

  /**
   * What this box is: how it identifies a request and which integrations it has, never a key.
   * An instance admin also sees when and by whom each store integration was written.
   */
  app.get("/api/instance", async (request) => {
    const user = await currentUser(repo, request, deps);
    const audit = await isInstanceAdmin(deps, String(user.id));
    return {
      auth_mode: deps.config?.authMode ?? "compat-cookie",
      integrations: integrationStatuses(deps.integrations ?? installedIntegrations(), undefined, undefined, { audit }),
    };
  });

  app.post(
    "/api/attachments",
    { bodyLimit: MAX_ATTACHMENT_BYTES + 4096 },
    async (request, reply) => {
      const user = await currentUser(repo, request, deps);
      const org = await currentOrg(repo, request, user);
      const bytes = Buffer.isBuffer(request.body) ? request.body : null;
      if (!bytes) {
        throw new HttpError(422, "body must be the file bytes");
      }
      const filename = String(request.headers["x-filename"] ?? "");
      try {
        const row = await attachmentsOf(deps).upload({
          orgId: String(org.id),
          userId: String(user.id),
          filename,
          bytes,
        });
        await send(reply, 201, attachmentPayload(row));
      } catch (error) {
        if (error instanceof AttachmentError) {
          throw new HttpError(error.status, error.message);
        }
        throw error;
      }
    },
  );

  app.get("/api/attachments/:attachment_id", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const { row, bytes } = await attachmentsOf(deps).getForOrg(
        String(org.id),
        param(request, "attachment_id"),
      );
      return reply
        .header("content-type", row.mime)
        .header("x-content-type-options", "nosniff")
        .header("content-disposition", row.kind === "image" ? inlineDisposition(row.filename) : attachmentDisposition(row.filename))
        .header("cache-control", "private, max-age=3600")
        .send(bytes);
    } catch (error) {
      if (error instanceof AttachmentError) {
        throw new HttpError(error.status, error.message);
      }
      throw error;
    }
  });

  /**
   * The user directory. On a compat-cookie box whoever reaches it may act as any user, so it is
   * open; behind an authenticating proxy it is the instance administrator's; a mode an edition
   * adds has none.
   */
  async function requireUserDirectory(request: IdentityRequest): Promise<void> {
    const mode = deps.config?.authMode ?? "compat-cookie";
    if (mode === "compat-cookie") {
      return;
    }
    if (mode === "trusted-header" && !deps.identity) {
      const user = await currentUser(repo, request, deps);
      if (await isInstanceAdmin(deps, String(user.id))) {
        return;
      }
    }
    throw new HttpError(404, "Not Found");
  }

  /** The 409 for a user insert or update that broke a unique index. */
  function userConflict(error: unknown): HttpError {
    const index = (error as { constraint?: string }).constraint;
    return new HttpError(409, index === "users_email_lower_unique" ? "email already belongs to a user" : "user name already exists");
  }

  async function requireInstanceAdminUnlessCompat(user: Record<string, unknown>): Promise<void> {
    if ((deps.config?.authMode ?? "compat-cookie") === "compat-cookie") {
      return;
    }
    if (!(await isInstanceAdmin(deps, String(user.id)))) {
      throw new HttpError(404, "Not Found");
    }
  }

  app.get("/api/users", async (request) => {
    await requireUserDirectory(request);
    return (await repo.listUsers()).map((row) => userItem(row));
  });

  app.post("/api/users", async (request, reply) => {
    await requireUserDirectory(request);
    const missing = missingBodyFields(request.body, ["name"]);
    if (missing) {
      throw missing;
    }
    const body = bodyOf(request);
    try {
      const name = validateUserName(String(body.name ?? ""));
      const email = validateUserEmail(body.email ?? null);
      const row = await repo.insertUser(
        { userId: newId("user"), name, image: null, email },
        new Date(),
      );
      await send(reply, 201, userItem(row));
    } catch (error) {
      if (error instanceof UserValidationError) {
        throw new HttpError(422, error.message);
      }
      if (isUniqueViolation(error)) {
        throw userConflict(error);
      }
      throw error;
    }
  });

  /** Sets the email a user is identified by behind an authenticating proxy; null clears it. */
  app.patch("/api/users/:user_id", async (request) => {
    await requireUserDirectory(request);
    const body = bodyOf(request);
    if (!("email" in body)) {
      throw new HttpError(422, "email is required");
    }
    let row;
    try {
      row = await repo.setUserEmail(param(request, "user_id"), validateUserEmail(body.email), new Date());
    } catch (error) {
      if (error instanceof UserValidationError) {
        throw new HttpError(422, error.message);
      }
      if (isUniqueViolation(error)) {
        throw userConflict(error);
      }
      throw error;
    }
    if (row === null) {
      throw new HttpError(404, "user not found");
    }
    return userItem(row);
  });

  app.delete("/api/users/:user_id", async (request, reply) => {
    await requireUserDirectory(request);
    const userId = param(request, "user_id");
    const row = await repo.getUser(userId);
    if (row === null) {
      throw new HttpError(404, "user not found");
    }
    if (SEED_USER_IDS.has(userId)) {
      throw new HttpError(400, "seed user cannot be deleted");
    }
    await refuseSoleGuildAdmin(repo, userId, null);
    const deleted = await refuseLastOrgOwner(() => repo.deleteUser(userId));
    if (deleted === null) {
      throw new HttpError(404, "user not found");
    }
    await send(reply, 204);
  });

  app.get("/api/orgs", async (request) => {
    const user = await currentUser(repo, request, deps);
    return (await repo.listOrgsForUser(String(user.id))).map((row) => orgItem(row));
  });

  app.post("/api/orgs", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    await requireInstanceAdminUnlessCompat(user);
    const missing = missingBodyFields(request.body, ["name", "slug"]);
    if (missing) {
      throw missing;
    }
    const body = bodyOf(request);
    try {
      const name = validateOrgName(String(body.name ?? ""));
      const slug = validateSlug(String(body.slug ?? ""));
      const row = await repo.insertOrg(
        { orgId: newId("org"), name, slug, userId: String(user.id) },
        new Date(),
      );
      const item = orgItem(row);
      item.role = "owner";
      await send(reply, 201, item);
    } catch (error) {
      if (error instanceof OrgValidationError) {
        throw new HttpError(422, error.message);
      }
      if (isUniqueViolation(error)) {
        throw new HttpError(409, "organisation slug already exists");
      }
      throw error;
    }
  });

  app.get("/api/orgs/:org_id", async (request) => {
    const user = await currentUser(repo, request, deps);
    const orgId = param(request, "org_id");
    const membership = await repo.getMembership(orgId, String(user.id));
    if (membership === null) {
      throw new HttpError(404, "organisation not found");
    }
    return orgItem(membership);
  });

  app.patch("/api/orgs/:org_id", async (request) => {
    const user = await currentUser(repo, request, deps);
    const orgId = param(request, "org_id");
    const membership = await repo.getMembership(orgId, String(user.id));
    if (membership === null) {
      throw new HttpError(404, "organisation not found");
    }
    if (!canManageSettings(String(membership.role))) {
      throw new HttpError(404, "organisation not found");
    }
    const body = bodyOf(request);
    let name: string | null = null;
    let slug: string | null = null;
    try {
      if (body.name !== undefined) {
        name = validateOrgName(String(body.name ?? ""));
      }
      if (body.slug !== undefined) {
        slug = validateSlug(String(body.slug ?? ""));
      }
    } catch (error) {
      if (error instanceof OrgValidationError) {
        throw new HttpError(422, error.message);
      }
      throw error;
    }
    const previousSlug = String(membership.slug);
    let row;
    try {
      row = await repo.updateOrg(orgId, new Date(), { name, slug });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(409, "organisation slug already exists");
      }
      throw error;
    }
    if (row === null) {
      throw new HttpError(404, "organisation not found");
    }
    if (slug && slug !== previousSlug) {
      const src = path.join(notes.root, "orgs", previousSlug);
      const dest = path.join(notes.root, "orgs", slug);
      if (existsSync(src) && !existsSync(dest)) {
        renameSync(src, dest);
      }
    }
    const item = orgItem(row);
    item.role = membership.role;
    return item;
  });

  app.get("/api/orgs/:org_id/members", async (request) => {
    const user = await currentUser(repo, request, deps);
    const orgId = param(request, "org_id");
    const membership = await repo.getMembership(orgId, String(user.id));
    if (membership === null) {
      throw new HttpError(404, "organisation not found");
    }
    return (await repo.listMembers(orgId)).map((row) => memberItem(row));
  });

  app.post("/api/orgs/:org_id/members", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const orgId = param(request, "org_id");
    const membership = await repo.getMembership(orgId, String(user.id));
    if (membership === null) {
      throw new HttpError(404, "organisation not found");
    }
    const body = bodyOf(request);
    if (!("name" in body)) {
      const missing = missingBodyFields(request.body, ["user_id"]);
      if (missing) {
        throw missing;
      }
    }
    let role;
    try {
      role = validateRole(String(body.role ?? "member"));
    } catch (error) {
      if (error instanceof OrgValidationError) {
        throw new HttpError(422, error.message);
      }
      throw error;
    }
    if (role === "owner") {
      if (!canManageOwners(String(membership.role))) {
        throw new HttpError(404, "organisation not found");
      }
    } else if (!canManageMembers(String(membership.role))) {
      throw new HttpError(404, "organisation not found");
    }
    const target =
      "name" in body
        ? await repo.getUserByName(String(body.name ?? "").trim().replace(/^@/, "").toLowerCase())
        : await repo.getUser(String(body.user_id));
    if (target === null) {
      throw new HttpError(404, "user not found");
    }
    const userId = String(target.id);
    try {
      await repo.insertMember(orgId, userId, role, new Date());
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(409, "member already exists");
      }
      throw error;
    }
    const rows = await repo.listMembers(orgId);
    const added = rows.find((row) => row.user_id === userId);
    await send(reply, 201, memberItem(added ?? {}));
  });

  app.patch("/api/orgs/:org_id/members/:user_id", async (request) => {
    const user = await currentUser(repo, request, deps);
    const orgId = param(request, "org_id");
    const userId = param(request, "user_id");
    const membership = await repo.getMembership(orgId, String(user.id));
    if (membership === null) {
      throw new HttpError(404, "organisation not found");
    }
    const body = bodyOf(request);
    let role;
    try {
      role = validateRole(String(body.role ?? ""));
    } catch (error) {
      if (error instanceof OrgValidationError) {
        throw new HttpError(422, error.message);
      }
      throw error;
    }
    const existing = await repo.getMembership(orgId, userId);
    if (existing === null) {
      throw new HttpError(404, "member not found");
    }
    if (existing.role === "owner" || role === "owner") {
      if (!canManageOwners(String(membership.role))) {
        throw new HttpError(404, "organisation not found");
      }
    } else if (!canManageMembers(String(membership.role))) {
      throw new HttpError(404, "organisation not found");
    }
    const updated = await refuseLastOrgOwner(() => repo.updateMemberRole(orgId, userId, role));
    if (updated === null) {
      throw new HttpError(404, "member not found");
    }
    const rows = await repo.listMembers(orgId);
    const row = rows.find((item) => item.user_id === userId);
    return memberItem(row ?? {});
  });

  app.delete("/api/orgs/:org_id/members/:user_id", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const orgId = param(request, "org_id");
    const userId = param(request, "user_id");
    const membership = await repo.getMembership(orgId, String(user.id));
    if (membership === null) {
      throw new HttpError(404, "organisation not found");
    }
    const existing = await repo.getMembership(orgId, userId);
    if (existing === null) {
      throw new HttpError(404, "member not found");
    }
    const manages = existing.role === "owner" ? canManageOwners : canManageMembers;
    if (userId !== String(user.id) && !manages(String(membership.role))) {
      throw new HttpError(404, "organisation not found");
    }
    await refuseSoleGuildAdmin(repo, userId, orgId);
    await refuseLastOrgOwner(() => repo.deleteMember(orgId, userId));
    await send(reply, 204);
  });

  app.get("/api/guilds", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    return (await repo.listGuildsForUser(String(org.id), String(user.id))).map(guildItem);
  });

  app.post("/api/guilds", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const missing = missingBodyFields(request.body, ["name"]);
    if (missing) {
      throw missing;
    }
    const body = bodyOf(request);
    try {
      const name = validateGuildName(String(body.name ?? ""));
      const about = validateAbout(body.about === undefined ? "" : String(body.about));
      const description = validateGuildDescription(body.description === undefined ? "" : String(body.description));
      const visibility = validateVisibility(body.visibility);
      await assertCanCreateGuild(policy, repo, String(org.id));
      const guildId = newId("guild");
      await persistGuild(repo, notes, {
        guildId,
        name,
        now: new Date(),
        orgId: String(org.id),
        orgSlug: String(org.slug),
        about,
        description,
        visibility,
        creatorUserId: String(user.id),
      });
      const created = await repo.getGuild(guildId);
      if (created === null) {
        throw new HttpError(500, "guild not found after create");
      }
      await send(reply, 201, guildItem(created));
    } catch (error) {
      if (error instanceof GuildValidationError) {
        throw new HttpError(422, error.message);
      }
      if (error instanceof LimitError) {
        throw new HttpError(409, error.message);
      }
      if (isUniqueViolation(error)) {
        throw new HttpError(409, "guild name already exists");
      }
      if (error instanceof ArtifactError) {
        throw catchArtifact(error);
      }
      if (error instanceof NotesError) {
        throw notesWriteHttp(error);
      }
      throw error;
    }
  });

  app.get("/api/guilds/:guild_id", async (request) => {
    const user = await currentUser(repo, request, deps);
    return guildItem(await ownedGuild(repo, param(request, "guild_id"), user));
  });

  app.put("/api/guilds/:guild_id", async (request) => {
    const user = await currentUser(repo, request, deps);
    const guildId = param(request, "guild_id");
    const existing = await ownedGuild(repo, guildId, user);
    const body = bodyOf(request);
    try {
      const name = body.name !== undefined ? validateGuildName(String(body.name ?? "")) : null;
      const about = body.about !== undefined ? validateAbout(String(body.about ?? "")) : null;
      const description =
        body.description !== undefined ? validateGuildDescription(String(body.description ?? "")) : null;
      const maxAgents = body.max_agents !== undefined ? validateMaxAgents(body.max_agents) : null;
      const gitAuthorEmail =
        body.git_author_email !== undefined ? validateGitAuthorEmail(body.git_author_email) : null;
      let visibility: string | null = null;
      const routinesEnabled =
        body.routines_enabled !== undefined ? validateRoutinesEnabled(body.routines_enabled) : undefined;
      const patch: {
        name: string | null;
        about: string | null;
        description: string | null;
        maxAgents: number | null;
        gitAuthorEmail: string | null;
        visibility: string | null;
        routinesEnabled?: boolean;
      } = {
        name,
        about,
        description,
        maxAgents,
        gitAuthorEmail,
        visibility,
        ...(routinesEnabled !== undefined ? { routinesEnabled } : {}),
      };
      if (body.visibility !== undefined) {
        visibility = validateVisibility(body.visibility);
        patch.visibility = visibility;
        if (visibility !== String(existing.visibility ?? "org")) {
          await administeredGuild(repo, guildId, user);
        }
      }
      const previousName = String(existing.name);
      if (name && name !== previousName) {
        if (deps.generation?.deleting_guild(guildId)) {
          throw new HttpError(409, "guild is being deleted");
        }
        const members = await repo.listAgents(guildId);
        if (members.some((row) => busy(deps, String(row.id)))) {
          throw new HttpError(409, "a member agent is already generating");
        }
      }
      const turningOn = routinesEnabled === true && existing.routines_enabled === false;
      const row = await repo.updateGuild(guildId, new Date(), patch, userActor(user));
      if (row === null) {
        throw new HttpError(404, "guild not found");
      }
      if (name && name !== previousName) {
        try {
          await notes.renameGuild(String(existing.org_slug), previousName, name);
        } catch (error) {
          await repo.updateGuild(guildId, new Date(), { name: previousName }, userActor(user));
          throw error;
        }
      }
      if (turningOn) {
        await schedules.releaseGuild(guildId);
      }
      return guildItem(row);
    } catch (error) {
      if (error instanceof GuildValidationError) {
        throw new HttpError(422, error.message);
      }
      if (isUniqueViolation(error)) {
        throw new HttpError(409, "guild name already exists");
      }
      if (error instanceof NotesError) {
        throw notesWriteHttp(error);
      }
      throw error;
    }
  });

  app.delete("/api/guilds/:guild_id", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const guildId = param(request, "guild_id");
    await administeredGuild(repo, guildId, user);
    try {
      await generationOf(deps).delete_guild(guildId);
      await send(reply, 204);
    } catch (error) {
      if (error instanceof RunRequestError) {
        throw new HttpError(error.status, error.detail);
      }
      if (error instanceof NotesError) {
        throw notesWriteHttp(error);
      }
      throw error;
    }
  });

  app.put("/api/guilds/:guild_id/operators/:user_id", async (request) => {
    const user = await currentUser(repo, request, deps);
    const guild = await administeredGuild(repo, param(request, "guild_id"), user);
    const userId = param(request, "user_id");
    let role;
    try {
      role = validateGuildOperatorRole(bodyOf(request).role);
    } catch (error) {
      if (error instanceof GuildValidationError) {
        throw new HttpError(422, error.message);
      }
      throw error;
    }
    if ((await repo.getMembership(String(guild.org_id), userId)) === null) {
      throw new HttpError(422, "operators must be members of the organisation");
    }
    return guildItem(await setOperator(repo, String(guild.id), userId, role));
  });

  app.delete("/api/guilds/:guild_id/operators/:user_id", async (request) => {
    const user = await currentUser(repo, request, deps);
    const guild = await administeredGuild(repo, param(request, "guild_id"), user);
    const userId = param(request, "user_id");
    if (!guildOperators(guild).some((operator) => operator.user_id === userId)) {
      throw new HttpError(404, "operator not found");
    }
    return guildItem(await setOperator(repo, String(guild.id), userId, null));
  });

  app.get("/api/guilds/:guild_id/group-chat", async (request) => {
    const user = await currentUser(repo, request, deps);
    const guildId = param(request, "guild_id");
    await ownedGuild(repo, guildId, user);
    try {
      const chat = await generationOf(deps).group_chat.state(guildId);
      return {
        ...chat,
        seen_through_seq: await repo.getGroupChatSeenThrough(guildId, String(user.id)),
      };
    } catch (error) {
      if (error instanceof GroupChatError) {
        throw groupHttp(error);
      }
      throw error;
    }
  });

  app.put("/api/guilds/:guild_id/group-chat/read", async (request) => {
    const user = await currentUser(repo, request, deps);
    const guildId = param(request, "guild_id");
    await ownedGuild(repo, guildId, user);
    const value = bodyOf(request).seen_through_seq;
    const seq = typeof value === "number" ? value : Number.NaN;
    if (!Number.isInteger(seq) || seq < 0) {
      throw new HttpError(422, "seen_through_seq must be a non-negative integer");
    }
    const seen = await repo.markGroupChatSeen(guildId, String(user.id), seq, new Date());
    await notifications.ping([String(user.id)]);
    return { seen_through_seq: seen };
  });

  app.put("/api/guilds/:guild_id/group-chat", async (request) => {
    const user = await currentUser(repo, request, deps);
    await ownedGuild(repo, param(request, "guild_id"), user);
    const body = bodyOf(request);
    try {
      return await generationOf(deps).group_chat.set_limit(
        param(request, "guild_id"),
        Number(body.agent_message_limit),
      );
    } catch (error) {
      if (error instanceof GroupChatError) {
        throw groupHttp(error);
      }
      throw error;
    }
  });

  app.get("/api/guilds/:guild_id/group-chat/messages", async (request) => {
    const user = await currentUser(repo, request, deps);
    await ownedGuild(repo, param(request, "guild_id"), user);
    try {
      return await generationOf(deps).group_chat.list_messages(param(request, "guild_id"));
    } catch (error) {
      if (error instanceof GroupChatError) {
        throw groupHttp(error);
      }
      throw error;
    }
  });

  app.delete("/api/guilds/:guild_id/group-chat/messages", async (request) => {
    const user = await currentUser(repo, request, deps);
    await administeredGuild(repo, param(request, "guild_id"), user);
    try {
      return await generationOf(deps).group_chat.clear(param(request, "guild_id"));
    } catch (error) {
      if (error instanceof GroupChatError) {
        throw groupHttp(error);
      }
      throw error;
    }
  });

  app.post("/api/guilds/:guild_id/group-chat/messages", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    await ownedGuild(repo, param(request, "guild_id"), user);
    const missing = missingBodyFields(request.body, ["content"]);
    if (missing) {
      throw missing;
    }
    const body = bodyOf(request);
    const guildId = param(request, "guild_id");
    if (body.interrupt !== undefined && typeof body.interrupt !== "boolean") {
      throw new HttpError(422, "interrupt must be a boolean");
    }
    try {
      const message = await generationOf(deps).group_chat.post_user(guildId, String(body.content ?? ""), {
        author_name: String(user.name),
        author_user_id: String(user.id),
        interrupt: body.interrupt === true,
      });
      await repo.markGroupChatSeen(guildId, String(user.id), Number(message.seq), new Date());
      await notifications.ping([String(user.id)]);
      await send(reply, 202, message);
    } catch (error) {
      if (error instanceof GroupChatError) {
        throw groupHttp(error);
      }
      throw error;
    }
  });

  app.get("/api/guilds/:guild_id/group-chat/stream", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    await ownedGuild(repo, param(request, "guild_id"), user);
    const chat = generationOf(deps).group_chat;
    await pipeSse(
      request,
      reply,
      () => chat.subscribe(param(request, "guild_id")),
      (queue) => chat.unsubscribe(param(request, "guild_id"), queue),
    );
  });

  app.get("/api/notifications", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    return notifications.list(String(org.id), String(user.id));
  });

  app.post("/api/notifications/read", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    return notifications.markMentionsRead(String(org.id), String(user.id));
  });

  app.get("/api/notifications/stream", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const userId = String(user.id);
    await pipeSse(
      request,
      reply,
      () => notifications.subscribe(userId, String(org.id)),
      (queue) => notifications.unsubscribe(userId, queue),
    );
  });

  app.get("/api/guilds/:guild_id/agents", async (request) => {
    const user = await currentUser(repo, request, deps);
    const guild = await ownedGuild(repo, param(request, "guild_id"), user);
    return (await repo.listAgents(String(guild.id))).map((row) => agentItem(row, busy(deps, String(row.id))));
  });

  app.get("/api/guilds/:guild_id/embed-status", async (request) => {
    const user = await currentUser(repo, request, deps);
    const guild = await ownedGuild(repo, param(request, "guild_id"), user);
    const agents = await repo.listAgents(String(guild.id));
    if (!artifacts) {
      return { agents: agents.map((row) => ({ id: row.id, broken_embeds: [] as string[] })) };
    }
    const items = [];
    for (const row of agents) {
      const actor = taskEmbedActor(String(guild.org_id), row);
      const inspected = await inspectTaskEmbeds(artifacts, actor, String(row.task ?? ""));
      items.push({
        id: row.id,
        broken_embeds: inspected.filter((item) => !item.ok).map((item) => item.href),
      });
    }
    return { agents: items };
  });

  app.post("/api/guilds/:guild_id/agents", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const guild = await ownedGuild(repo, param(request, "guild_id"), user);
    if (deps.generation?.deleting_guild(String(guild.id))) {
      throw new HttpError(409, "guild is being deleted");
    }
    const missing = missingBodyFields(request.body, ["name", "config"]);
    if (missing) {
      throw missing;
    }
    const body = bodyOf(request);
    try {
      const name = validateAgentName(String(body.name ?? ""));
      const focus = validateFocus(body.focus === undefined ? "" : String(body.focus));
      const wakeTriggers = validateWakeTriggers(
        body.wake_triggers === undefined ? "" : String(body.wake_triggers),
      );
      const avatarShape = validateAvatarShape(
        body.avatar_shape === undefined ? undefined : String(body.avatar_shape),
      );
      const avatarColor = validateAvatarColor(
        body.avatar_color === undefined ? undefined : String(body.avatar_color),
      );
      const config = validateConfig(withCodingLimits((body.config ?? {}) as Record<string, unknown>));
      assertCodingAgent(config);
      await assertModelConnected(modelCredentials, String(guild.org_id), config.model);
      await assertCanCreateAgent(policy, repo, String(guild.org_id), {
        browser: config.browser,
        coding: config.coding,
      });
      await assertGuildAgentRoom(repo, String(guild.id), 1);
      const { machine, maxAgentsPerMachine } = await placement(String(guild.org_id), user, body.machine_id, {
        needs: { browser: config.browser, coding: config.coding },
      });
      const agentId = newId("a");
      await persistAgent(repo, notes, {
        agentId,
        guildId: String(guild.id),
        guildName: String(guild.name),
        orgSlug: String(guild.org_slug),
        name,
        config,
        now: new Date(),
        focus,
        wakeTriggers,
        avatarShape,
        avatarColor,
        orgId: String(guild.org_id),
        artifacts: artifacts ?? null,
        actor: await operatorFor(repo, user, {
          orgId: String(guild.org_id),
          guildId: String(guild.id),
          agentId,
        }),
        machineId: machine.id,
        maxAgentsPerMachine,
      });
      const created = await repo.getAgent(agentId);
      if (created === null) {
        throw new HttpError(500, "agent not found after create");
      }
      await send(reply, 201, await agentPayload(deps, created));
    } catch (error) {
      if (error instanceof AgentValidationError) {
        throw new HttpError(422, error.message);
      }
      if (error instanceof PolicyError || error instanceof ModelNotConnectedError) {
        throw new HttpError(error.status, error.message);
      }
      if (error instanceof GuildAgentLimitError || error instanceof GuildNameTaken) {
        throw new HttpError(409, error.message);
      }
      if (isUniqueViolation(error)) {
        throw new HttpError(409, "agent name already exists");
      }
      if (error instanceof ArtifactError) {
        throw catchArtifact(error);
      }
      if (error instanceof NotesError) {
        throw notesWriteHttp(error);
      }
      throw error;
    }
  });

  app.get("/api/guilds/:guild_id/notes", async (request) => {
    const user = await currentUser(repo, request, deps);
    const row = await ownedGuild(repo, param(request, "guild_id"), user);
    if (!artifacts) {
      try {
        return notes.listSharedFiles(String(row.org_slug), String(row.name));
      } catch (error) {
        if (error instanceof NotesError) {
          throw notesReadHttp(error);
        }
        throw error;
      }
    }
    try {
      return await listHostFiles(
        artifacts,
        await operatorFor(repo, user, { orgId: String(row.org_id), guildId: String(row.id) }),
        "guild",
        String(row.id),
      );
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.get("/api/guilds/:guild_id/notes/*", async (request) => {
    const user = await currentUser(repo, request, deps);
    const row = await ownedGuild(repo, param(request, "guild_id"), user);
    const filePath = filePathParam(request);
    if (!artifacts) {
      try {
        return {
          path: filePath,
          content: notes.readSharedFile(String(row.org_slug), String(row.name), filePath),
        };
      } catch (error) {
        if (error instanceof NotesError) {
          throw notesReadHttp(error);
        }
        throw error;
      }
    }
    try {
      return await readHostFile(
        artifacts,
        await operatorFor(repo, user, { orgId: String(row.org_id), guildId: String(row.id) }),
        "guild",
        String(row.id),
        filePath,
      );
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.put("/api/guilds/:guild_id/notes/*", async (request) => {
    const user = await currentUser(repo, request, deps);
    const row = await ownedGuild(repo, param(request, "guild_id"), user);
    const filePath = filePathParam(request);
    const body = bodyOf(request);
    if (!artifacts) {
      try {
        await notes.writeSharedFile(
          String(row.org_slug),
          String(row.name),
          filePath,
          String(body.content ?? ""),
        );
        await publishGroup(deps, String(row.id), "guild.artifacts.changed", {
          scope: "shared",
          path: filePath,
        });
        return {
          path: filePath,
          content: notes.readSharedFile(String(row.org_slug), String(row.name), filePath),
        };
      } catch (error) {
        if (error instanceof NotesError) {
          throw notesWriteHttp(error);
        }
        throw error;
      }
    }
    try {
      const written = await writeHostFile(
        artifacts,
        await operatorFor(repo, user, { orgId: String(row.org_id), guildId: String(row.id) }),
        "guild",
        String(row.id),
        filePath,
        String(body.content ?? ""),
      );
      await publishGroup(deps, String(row.id), "guild.artifacts.changed", {
        scope: "guild",
        path: filePath,
      });
      return written;
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.delete("/api/guilds/:guild_id/notes/*", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const row = await ownedGuild(repo, param(request, "guild_id"), user);
    const filePath = filePathParam(request);
    if (!artifacts) {
      try {
        await notes.deleteSharedFile(String(row.org_slug), String(row.name), filePath);
        await publishGroup(deps, String(row.id), "guild.artifacts.changed", {
          scope: "shared",
          path: filePath,
        });
        await send(reply, 204);
        return;
      } catch (error) {
        if (error instanceof NotesError) {
          throw notesWriteHttp(error);
        }
        throw error;
      }
    }
    try {
      await deleteHostFile(
        artifacts,
        await operatorFor(repo, user, { orgId: String(row.org_id), guildId: String(row.id) }),
        "guild",
        String(row.id),
        filePath,
      );
      await publishGroup(deps, String(row.id), "guild.artifacts.changed", {
        scope: "guild",
        path: filePath,
      });
      await send(reply, 204);
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.get("/api/org/notes", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    if (!artifacts) {
      return [];
    }
    try {
      return await listHostFiles(artifacts, await operatorFor(repo, user, { orgId: String(org.id) }), "org", String(org.id));
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.get("/api/file-changes", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const displayPath = String(
      (request.query as { display_path?: unknown }).display_path ?? "",
    ).trim();
    if (!displayPath) {
      throw new HttpError(422, "display_path is required");
    }
    const store = requireArtifacts(artifacts);
    const actor = await operatorFor(repo, user, { orgId: String(org.id) });
    if (!(await store.canReadDisplayPath(actor, displayPath))) {
      return [];
    }
    return listFileChanges(repo.pool, String(org.id), displayPath);
  });

  // Newest change per display path. `display_paths` is comma-separated in
  // the query, or a JSON array in a POST body when the list is long.
  app.get("/api/file-changes/latest", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const raw = String((request.query as { display_paths?: unknown }).display_paths ?? "");
    const paths = raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const store = requireArtifacts(artifacts);
    return latestFileChanges(store, repo, await operatorFor(repo, user, { orgId: String(org.id) }), paths);
  });

  app.post("/api/file-changes/latest", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const body = bodyOf(request);
    const paths = Array.isArray(body.display_paths)
      ? body.display_paths.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [];
    const store = requireArtifacts(artifacts);
    return latestFileChanges(store, repo, await operatorFor(repo, user, { orgId: String(org.id) }), paths);
  });

  app.get("/api/org/notes/*", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const filePath = filePathParam(request);
    if (!artifacts) {
      throw new HttpError(404, "artifact not found");
    }
    try {
      return await readHostFile(artifacts, await operatorFor(repo, user, { orgId: String(org.id) }), "org", String(org.id), filePath);
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.put("/api/org/notes/*", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const filePath = filePathParam(request);
    const body = bodyOf(request);
    if (!artifacts) {
      throw new HttpError(422, "artifact store is not available");
    }
    try {
      return await writeHostFile(
        artifacts,
        await operatorFor(repo, user, { orgId: String(org.id) }),
        "org",
        String(org.id),
        filePath,
        String(body.content ?? ""),
      );
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.delete("/api/org/notes/*", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const filePath = filePathParam(request);
    if (!artifacts) {
      throw new HttpError(422, "artifact store is not available");
    }
    try {
      await deleteHostFile(artifacts, await operatorFor(repo, user, { orgId: String(org.id) }), "org", String(org.id), filePath);
      await send(reply, 204);
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.get("/api/org/embeddable-notes", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const displayPath = String((request.query as { display_path?: string }).display_path ?? "").trim();
    if (!artifacts) {
      if (displayPath) {
        throw new HttpError(404, "note not found");
      }
      return [];
    }
    const actor = await operatorFor(repo, user, { orgId: String(org.id) });
    try {
      if (!displayPath) {
        return await artifacts.listEmbeddableNotes(actor);
      }
      const loaded = await artifacts.getByDisplayPath(actor, displayPath);
      if (loaded.tombstone || loaded.revision || !loaded.row || loaded.row.kind !== "note") {
        throw new HttpError(404, "note not found");
      }
      return {
        display_path: displayPath,
        title: loaded.row.title || loaded.row.key.replace(/\.md$/, ""),
        level: loaded.row.level,
        content: loaded.row.content_text ?? "",
      };
    } catch (error) {
      catchArtifact(error);
    }
  });

  // Collections live at the organisation: the Tables page builds them and
  // browses their records and edits their access lists.
  app.get("/api/collections", async (request) => {
    const store = requireArtifacts(artifacts);
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      return await listCollections(store, await operatorFor(repo, user, { orgId: String(org.id) }));
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.post("/api/collections", async (request, reply) => {
    const store = requireArtifacts(artifacts);
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const missing = missingBodyFields(request.body, ["name", "purpose"]);
    if (missing) {
      throw missing;
    }
    try {
      const created = await createCollection(store, await operatorFor(repo, user, { orgId: String(org.id) }), bodyOf(request));
      return await send(reply, 201, created);
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.get("/api/collections/:collection_id", async (request) => {
    const store = requireArtifacts(artifacts);
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      return await getCollection(store, await operatorFor(repo, user, { orgId: String(org.id) }), param(request, "collection_id"));
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.patch("/api/collections/:collection_id", async (request) => {
    const store = requireArtifacts(artifacts);
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      return await updateCollection(store, await operatorFor(repo, user, { orgId: String(org.id) }), param(request, "collection_id"), bodyOf(request));
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.delete("/api/collections/:collection_id", async (request, reply) => {
    const store = requireArtifacts(artifacts);
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      await deleteCollection(store, await operatorFor(repo, user, { orgId: String(org.id) }), param(request, "collection_id"));
      await send(reply, 204);
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.get("/api/collections/:collection_id/export", async (request, reply) => {
    const store = requireArtifacts(artifacts);
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const exported = await exportCollection(store, await operatorFor(repo, user, { orgId: String(org.id) }), param(request, "collection_id"));
      reply
        .header("content-disposition", `attachment; filename="${exported.name}.jsonl"`)
        .type("application/jsonl")
        .send(exported.body);
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.get("/api/collections/:collection_id/records", async (request) => {
    const store = requireArtifacts(artifacts);
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      return await listRecords(store, await operatorFor(repo, user, { orgId: String(org.id) }), param(request, "collection_id"), queryOf(request));
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.post("/api/collections/:collection_id/records", async (request, reply) => {
    const store = requireArtifacts(artifacts);
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const missing = missingBodyFields(request.body, ["body"]);
    if (missing) {
      throw missing;
    }
    try {
      const added = await addRecord(store, await operatorFor(repo, user, { orgId: String(org.id) }), param(request, "collection_id"), bodyOf(request).body);
      return await send(reply, 201, added);
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.delete("/api/collections/:collection_id/records", async (request, reply) => {
    const store = requireArtifacts(artifacts);
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      await clearRecords(store, await operatorFor(repo, user, { orgId: String(org.id) }), param(request, "collection_id"));
      await send(reply, 204);
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.get("/api/collections/:collection_id/records/:record_id", async (request) => {
    const store = requireArtifacts(artifacts);
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      return await getRecord(store, await operatorFor(repo, user, { orgId: String(org.id) }), param(request, "collection_id"), param(request, "record_id"));
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.patch("/api/collections/:collection_id/records/:record_id", async (request) => {
    const store = requireArtifacts(artifacts);
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const missing = missingBodyFields(request.body, ["body"]);
    if (missing) {
      throw missing;
    }
    try {
      return await updateRecord(
        store,
        await operatorFor(repo, user, { orgId: String(org.id) }),
        param(request, "collection_id"),
        param(request, "record_id"),
        bodyOf(request).body,
      );
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.delete("/api/collections/:collection_id/records/:record_id", async (request, reply) => {
    const store = requireArtifacts(artifacts);
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      await removeRecord(store, await operatorFor(repo, user, { orgId: String(org.id) }), param(request, "collection_id"), param(request, "record_id"));
      await send(reply, 204);
    } catch (error) {
      catchArtifact(error);
    }
  });

  // An item's access list: notes, tables, and files take the same routes.
  const accessTargets = [
    { path: "/api/notes/:note_id/access", kind: "note", param: "note_id" },
    { path: "/api/collections/:collection_id/access", kind: "collection", param: "collection_id" },
    { path: "/api/files/:file_id/access", kind: "file", param: "file_id" },
  ] as const;
  for (const target of accessTargets) {
    app.get(target.path, async (request) => {
      const store = requireArtifacts(artifacts);
      const user = await currentUser(repo, request, deps);
      const org = await currentOrg(repo, request, user);
      try {
        const actor = await operatorFor(repo, user, { orgId: String(org.id) });
        return await store.accessList(actor, { kind: target.kind, id: param(request, target.param) });
      } catch (error) {
        catchArtifact(error);
      }
    });

    app.put(target.path, async (request) => {
      const store = requireArtifacts(artifacts);
      const user = await currentUser(repo, request, deps);
      const org = await currentOrg(repo, request, user);
      const missing = missingBodyFields(request.body, ["subjects"]);
      if (missing) {
        throw missing;
      }
      try {
        const actor = await operatorFor(repo, user, { orgId: String(org.id) });
        return await store.replaceAccess(actor, { kind: target.kind, id: param(request, target.param) }, bodyOf(request).subjects);
      } catch (error) {
        catchArtifact(error);
      }
    });
  }

  app.get("/api/guilds/:guild_id/reach", async (request) => {
    const store = requireArtifacts(artifacts);
    const user = await currentUser(repo, request, deps);
    const row = await ownedGuild(repo, param(request, "guild_id"), user);
    try {
      const actor = await operatorFor(repo, user, { orgId: String(row.org_id) });
      return await store.reachOf(actor, { type: "guild", id: String(row.id), guildId: String(row.id) });
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.get("/api/agents/:agent_id/reach", async (request) => {
    const store = requireArtifacts(artifacts);
    const user = await currentUser(repo, request, deps);
    const row = await ownedAgent(repo, param(request, "agent_id"), user);
    try {
      const actor = await operatorFor(repo, user, { orgId: String(row.org_id) });
      return await store.reachOf(actor, { type: "agent", id: String(row.id), guildId: String(row.guild_id) });
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.get("/api/guilds/:guild_id/schedules", async (request) => {
    const user = await currentUser(repo, request, deps);
    await ownedGuild(repo, param(request, "guild_id"), user);
    return schedules.listForGuild(param(request, "guild_id"));
  });

  app.get("/api/guilds/:guild_id/issues", async (request) => {
    const user = await currentUser(repo, request, deps);
    await ownedGuild(repo, param(request, "guild_id"), user);
    try {
      return await issues.listForGuild(param(request, "guild_id"), queryOf(request).status);
    } catch (error) {
      if (error instanceof IssueError) {
        throw new HttpError(422, error.message);
      }
      throw error;
    }
  });

  app.post("/api/guilds/:guild_id/issues/resolve", async (request) => {
    const user = await currentUser(repo, request, deps);
    const guild = await ownedGuild(repo, param(request, "guild_id"), user);
    try {
      const resolved = await issues.resolveOpen(
        String(guild.id),
        typeof user.name === "string" ? user.name : "user",
      );
      if (resolved > 0) {
        await publishGroup(deps, String(guild.id), "guild.issues.changed", {
          action: "resolved",
        });
      }
      return { resolved };
    } catch (error) {
      if (error instanceof IssueError) {
        throw new HttpError(422, error.message);
      }
      throw error;
    }
  });

  app.patch("/api/guilds/:guild_id/issues/:issue_id", async (request) => {
    const user = await currentUser(repo, request, deps);
    const guild = await ownedGuild(repo, param(request, "guild_id"), user);
    const body = bodyOf(request);
    if (body.status === undefined) {
      throw new HttpError(422, "status is required");
    }
    try {
      const row = await issues.setStatus(
        String(guild.id),
        param(request, "issue_id"),
        body.status,
        typeof user.name === "string" ? user.name : "user",
      );
      await publishGroup(deps, String(guild.id), "guild.issues.changed", {
        action: String(body.status),
        issue_id: row.id,
      });
      return row;
    } catch (error) {
      if (error instanceof IssueError) {
        throw new HttpError(error.message === "issue not found" ? 404 : 422, error.message);
      }
      throw error;
    }
  });

  app.get("/api/agents/:agent_id", async (request) => {
    const user = await currentUser(repo, request, deps);
    const row = await ownedAgent(repo, param(request, "agent_id"), user);
    return agentPayload(deps, row);
  });

  app.delete("/api/agents/:agent_id", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const agentId = param(request, "agent_id");
    await ownedAgent(repo, agentId, user);
    try {
      await generationOf(deps).delete_agent(agentId);
      await send(reply, 204);
    } catch (error) {
      if (error instanceof RunRequestError) {
        throw new HttpError(error.status, error.detail);
      }
      if (error instanceof NotesError) {
        throw notesWriteHttp(error);
      }
      throw error;
    }
  });

  app.put("/api/agents/:agent_id/config", async (request) => {
    const user = await currentUser(repo, request, deps);
    const agentId = param(request, "agent_id");
    const existing = await ownedAgent(repo, agentId, user);
    const body = bodyOf(request);
    try {
      const config = validateConfig((body.config ?? {}) as Record<string, unknown>);
      const previous = agentConfigObject(existing);
      assertCodingAgent(config, previous);
      await assertModelConnected(modelCredentials, String(existing.org_id), config.model);
      const needs = { browser: config.browser, coding: config.coding };
      const { machine, maxAgentsPerMachine, moves } = await placement(String(existing.org_id), user, body.machine_id, {
        needs,
        machineId: String(existing.machine_id),
      });
      if (config.browser && !previous.browser) {
        await assertCanEnableBrowser(policy, repo, String(existing.org_id), false);
      }
      if (config.coding && !previous.coding) {
        await assertCanEnableCoding(policy, repo, String(existing.org_id));
      }
      const avatarShape =
        body.avatar_shape !== undefined ? validateAvatarShape(String(body.avatar_shape)) : null;
      const avatarColor =
        body.avatar_color !== undefined ? validateAvatarColor(String(body.avatar_color)) : null;
      const focus = body.focus !== undefined ? validateFocus(String(body.focus ?? "")) : null;
      const wakeTriggers =
        body.wake_triggers !== undefined ? validateWakeTriggers(String(body.wake_triggers ?? "")) : null;
      const name = body.name !== undefined ? validateAgentName(String(body.name ?? "")) : null;
      const previousName = String(existing.name);
      if (name && name !== previousName) {
        if (deps.generation?.deleting_guild(String(existing.guild_id))) {
          throw new HttpError(409, "guild is being deleted");
        }
        if (busy(deps, agentId)) {
          throw new HttpError(409, "agent is already generating");
        }
      }
      if (moves) {
        await generationOf(deps).moveAgent(agentId, machine.id, { maxAgentsPerMachine, needs });
      }
      let row: Record<string, unknown> | null;
      try {
        row = await repo.updateAgentConfig(agentId, config, new Date(), {
            name,
            avatarShape,
            avatarColor,
            focus,
            wakeTriggers,
          });
      } catch (error) {
        if (moves) {
          await generationOf(deps).moveAgent(agentId, String(existing.machine_id), {
            needs: { browser: Boolean(previous.browser), coding: Boolean(previous.coding) },
          });
        }
        throw error;
      }
      if (row === null) {
        throw new HttpError(404, "agent not found");
      }
      if (name && name !== previousName) {
        try {
          await notes.renameAgent(
            String(existing.org_slug),
            String(existing.guild_name),
            previousName,
            name,
          );
        } catch (error) {
          await repo.updateAgentConfig(agentId, config, new Date(), { name: previousName });
          throw error;
        }
      }
      const browserChanged =
        (Boolean(previous.browser) && !config.browser) ||
        (config.browser && browserLanguageOf(previous) !== config.browser_language);
      if (browserChanged && deps.generation) {
        await deps.generation.agentBrowserChanged(agentId);
      }
      const detail = await repo.getAgent(agentId);
      if (detail === null) {
        throw new HttpError(404, "agent not found");
      }
      return agentPayload(deps, detail);
    } catch (error) {
      if (error instanceof AgentValidationError) {
        throw new HttpError(422, error.message);
      }
      if (error instanceof GuildNameTaken) {
        throw new HttpError(409, error.message);
      }
      if (error instanceof RunRequestError) {
        throw new HttpError(error.status, error.detail);
      }
      if (isUniqueViolation(error)) {
        throw new HttpError(409, "agent name already exists");
      }
      if (error instanceof NotesError) {
        throw notesWriteHttp(error);
      }
      if (error instanceof PolicyError || error instanceof ModelNotConnectedError) {
        throw new HttpError(error.status, error.message);
      }
      throw error;
    }
  });

  app.put("/api/agents/:agent_id/machine", async (request) => {
    const user = await currentUser(repo, request, deps);
    const agentId = param(request, "agent_id");
    const existing = await ownedAgent(repo, agentId, user);
    const body = bodyOf(request);
    if (machineIdOf(body.machine_id) === null) {
      throw new HttpError(422, "machine_id is required");
    }
    try {
      const { machine, maxAgentsPerMachine, moves } = await placement(String(existing.org_id), user, body.machine_id, {
        needs: {
          browser: agentConfigObject(existing).browser === true,
          coding: agentConfigObject(existing).coding === true,
        },
        machineId: String(existing.machine_id),
      });
      if (moves) {
        await generationOf(deps).moveAgent(agentId, machine.id, { maxAgentsPerMachine });
      }
    } catch (error) {
      if (error instanceof RunRequestError) {
        throw new HttpError(error.status, error.detail);
      }
      throw error;
    }
    const detail = await repo.getAgent(agentId);
    if (detail === null) {
      throw new HttpError(404, "agent not found");
    }
    return agentPayload(deps, detail);
  });

  app.get("/api/agents/:agent_id/schedules", async (request) => {
    const user = await currentUser(repo, request, deps);
    const agentId = param(request, "agent_id");
    await ownedAgent(repo, agentId, user);
    const items = [];
    for (const row of await repo.listSchedules(agentId)) {
      items.push(await schedules.view(row));
    }
    return items;
  });

  app.post("/api/agents/:agent_id/schedules", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const agentId = param(request, "agent_id");
    const agent = await ownedAgent(repo, agentId, user);
    const missing = missingBodyFields(request.body, ["description", "instruction"]);
    if (missing) {
      throw missing;
    }
    const body = bodyOf(request);
    try {
      const row = await schedules.create(
        userActor(user),
        agentId,
        { cron: body.cron, window: body.window },
        body.description,
        body.instruction,
      );
      await publishGroup(deps, String(agent.guild_id), "agent.routines.changed", {
        agent_id: agentId,
        action: "create",
        schedule_id: row.id,
      });
      await send(reply, 201, scheduleItem(row));
    } catch (error) {
      if (error instanceof ScheduleError) {
        throw new HttpError(422, error.message);
      }
      throw error;
    }
  });

  app.patch("/api/agents/:agent_id/schedules/:schedule_id", async (request) => {
    const user = await currentUser(repo, request, deps);
    const agentId = param(request, "agent_id");
    const scheduleId = param(request, "schedule_id");
    const agent = await ownedAgent(repo, agentId, user);
    if ((await repo.getSchedule(agentId, scheduleId)) === null) {
      throw new HttpError(404, "schedule not found");
    }
    const changes = scheduleChanges(bodyOf(request));
    try {
      const row = await schedules.update(userActor(user), agentId, scheduleId, changes);
      await publishGroup(deps, String(agent.guild_id), "agent.routines.changed", {
        agent_id: agentId,
        action: routineAction(changes),
        schedule_id: row.id,
      });
      return scheduleItem(row);
    } catch (error) {
      if (error instanceof ScheduleError) {
        throw new HttpError(422, error.message);
      }
      throw error;
    }
  });

  app.delete("/api/agents/:agent_id/schedules/:schedule_id", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const agentId = param(request, "agent_id");
    const scheduleId = param(request, "schedule_id");
    const agent = await ownedAgent(repo, agentId, user);
    try {
      await schedules.delete(userActor(user), agentId, scheduleId);
      await publishGroup(deps, String(agent.guild_id), "agent.routines.changed", {
        agent_id: agentId,
        action: "delete",
        schedule_id: scheduleId,
      });
      await send(reply, 204);
    } catch (error) {
      if (error instanceof ScheduleError) {
        throw new HttpError(404, error.message);
      }
      throw error;
    }
  });

  app.get("/api/agents/:agent_id/scripts", async (request) => {
    const user = await currentUser(repo, request, deps);
    const agentId = param(request, "agent_id");
    const agent = await ownedAgent(repo, agentId, user);
    try {
      const rows = await scripts.listForAgent(agentId);
      return rows.map((row) => ({
        ...scriptItem(row, { source: true }),
        display_path: displayPathFor({
          orgId: String(agent.org_id),
          level: "agent",
          ownerId: agentId,
          kind: "script",
          path: "scripts",
          key: String(row.name),
        }),
      }));
    } catch (error) {
      if (error instanceof ScriptError) {
        throw new HttpError(422, error.message);
      }
      throw error;
    }
  });

  app.post("/api/agents/:agent_id/scripts", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const agentId = param(request, "agent_id");
    const agent = await ownedAgent(repo, agentId, user);
    const missing = missingBodyFields(request.body, ["name", "description", "source"]);
    if (missing) {
      throw missing;
    }
    const body = bodyOf(request);
    try {
      const row = await scripts.create(
        await operatorFor(repo, user, {
          orgId: String(agent.org_id),
          guildId: String(agent.guild_id),
          agentId,
        }),
        agentId,
        body.name,
        body.description,
        body.source,
        body.parameters ?? null,
        { maxScripts: maxScriptsOf(agentConfigObject(agent)) },
      );
      await publishGroup(deps, String(agent.guild_id), "agent.scripts.changed", {
        agent_id: agentId,
        action: "create",
        name: row.name,
      });
      await send(reply, 201, scriptItem(row, { source: true }));
    } catch (error) {
      if (error instanceof ScriptError) {
        throw new HttpError(422, error.message);
      }
      throw error;
    }
  });

  app.delete("/api/agents/:agent_id/scripts", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const agentId = param(request, "agent_id");
    const agent = await ownedAgent(repo, agentId, user);
    try {
      await scripts.deleteAll(
        await operatorFor(repo, user, {
          orgId: String(agent.org_id),
          guildId: String(agent.guild_id),
          agentId,
        }),
        agentId,
      );
      await publishGroup(deps, String(agent.guild_id), "agent.scripts.changed", {
        agent_id: agentId,
        action: "clear",
      });
      await send(reply, 204);
    } catch (error) {
      if (error instanceof ScriptError) {
        throw new HttpError(422, error.message);
      }
      throw error;
    }
  });

  app.get("/api/agents/:agent_id/scripts/:name", async (request) => {
    const user = await currentUser(repo, request, deps);
    const agentId = param(request, "agent_id");
    const name = param(request, "name");
    await ownedAgent(repo, agentId, user);
    try {
      const row = await scripts.get(agentId, name);
      return scriptItem(row, { source: true });
    } catch (error) {
      if (error instanceof ScriptError) {
        throw new HttpError(404, error.message);
      }
      throw error;
    }
  });

  app.delete("/api/agents/:agent_id/scripts/:name", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const agentId = param(request, "agent_id");
    const name = param(request, "name");
    const agent = await ownedAgent(repo, agentId, user);
    try {
      await scripts.delete(
        await operatorFor(repo, user, {
          orgId: String(agent.org_id),
          guildId: String(agent.guild_id),
          agentId,
        }),
        agentId,
        name,
      );
      await publishGroup(deps, String(agent.guild_id), "agent.scripts.changed", {
        agent_id: agentId,
        action: "delete",
        name,
      });
      await send(reply, 204);
    } catch (error) {
      if (error instanceof ScriptError) {
        throw new HttpError(404, error.message);
      }
      throw error;
    }
  });

  app.get("/api/agents/:agent_id/notes", async (request) => {
    const user = await currentUser(repo, request, deps);
    const row = await ownedAgent(repo, param(request, "agent_id"), user);
    if (!artifacts) {
      try {
        return notes.listAgentFiles(String(row.org_slug), String(row.guild_name), String(row.name));
      } catch (error) {
        if (error instanceof NotesError) {
          throw notesReadHttp(error);
        }
        throw error;
      }
    }
    try {
      const actor = await operatorFor(repo, user, {
        orgId: String(row.org_id),
        guildId: String(row.guild_id),
        agentId: String(row.id),
      });
      await ensureAgentArtifacts(artifacts, actor, {
        id: row.id,
        guild_id: row.guild_id,
        org_id: row.org_id,
      });
      return await listHostFiles(artifacts, actor, "agent", String(row.id));
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.get("/api/agents/:agent_id/memory", async (request) => {
    const user = await currentUser(repo, request, deps);
    const row = await ownedAgent(repo, param(request, "agent_id"), user);
    try {
      const store = requireArtifacts(artifacts);
      const actor = await operatorFor(repo, user, {
        orgId: String(row.org_id),
        guildId: String(row.guild_id),
        agentId: String(row.id),
      });
      await ensureAgentArtifacts(store, actor, {
        id: row.id,
        guild_id: row.guild_id,
        org_id: row.org_id,
      });
      return await memoryHistory({ artifacts: store, repo }, actor, { id: String(row.id), name: String(row.name) });
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.get("/api/agents/:agent_id/notes/*", async (request) => {
    const user = await currentUser(repo, request, deps);
    const row = await ownedAgent(repo, param(request, "agent_id"), user);
    const filePath = filePathParam(request);
    if (!artifacts) {
      try {
        return {
          path: filePath,
          content: notes.readAgentFile(
            String(row.org_slug),
            String(row.guild_name),
            String(row.name),
            filePath,
          ),
        };
      } catch (error) {
        if (error instanceof NotesError) {
          throw notesReadHttp(error);
        }
        throw error;
      }
    }
    try {
      const actor = await operatorFor(repo, user, {
        orgId: String(row.org_id),
        guildId: String(row.guild_id),
        agentId: String(row.id),
      });
      await ensureAgentArtifacts(artifacts, actor, {
        id: row.id,
        guild_id: row.guild_id,
        org_id: row.org_id,
      });
      return await readHostFile(artifacts, actor, "agent", String(row.id), filePath, repo);
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.put("/api/agents/:agent_id/notes/*", async (request) => {
    const user = await currentUser(repo, request, deps);
    const row = await ownedAgent(repo, param(request, "agent_id"), user);
    const filePath = filePathParam(request);
    const body = bodyOf(request);
    if (!artifacts) {
      try {
        await notes.writeAgentFile(
          String(row.org_slug),
          String(row.guild_name),
          String(row.name),
          filePath,
          String(body.content ?? ""),
          { actor: String(user.name) },
        );
        await publishGroup(deps, String(row.guild_id), "guild.artifacts.changed", {
          scope: "agent",
          agent_id: String(row.id),
          path: filePath,
        });
        return {
          path: filePath,
          content: notes.readAgentFile(
            String(row.org_slug),
            String(row.guild_name),
            String(row.name),
            filePath,
          ),
        };
      } catch (error) {
        if (error instanceof NotesError) {
          throw notesWriteHttp(error);
        }
        throw error;
      }
    }
    try {
      const actor = await operatorFor(repo, user, {
        orgId: String(row.org_id),
        guildId: String(row.guild_id),
        agentId: String(row.id),
      });
      await ensureAgentArtifacts(artifacts, actor, {
        id: row.id,
        guild_id: row.guild_id,
        org_id: row.org_id,
      });
      const written = await writeHostFile(
        artifacts,
        actor,
        "agent",
        String(row.id),
        filePath,
        String(body.content ?? ""),
        expectedVersionOf(body),
        repo,
      );
      await publishGroup(deps, String(row.guild_id), "guild.artifacts.changed", {
        scope: "agent",
        agent_id: String(row.id),
        path: filePath,
      });
      return written;
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.delete("/api/agents/:agent_id/notes/*", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const row = await ownedAgent(repo, param(request, "agent_id"), user);
    const filePath = filePathParam(request);
    if (!artifacts) {
      try {
        await notes.deleteAgentFile(
          String(row.org_slug),
          String(row.guild_name),
          String(row.name),
          filePath,
        );
        await publishGroup(deps, String(row.guild_id), "guild.artifacts.changed", {
          scope: "agent",
          agent_id: String(row.id),
          path: filePath,
        });
        await send(reply, 204);
        return;
      } catch (error) {
        if (error instanceof NotesError) {
          throw notesWriteHttp(error);
        }
        throw error;
      }
    }
    try {
      await deleteHostFile(
        artifacts,
        await operatorFor(repo, user, { orgId: String(row.org_id), guildId: String(row.guild_id), agentId: String(row.id) }),
        "agent",
        String(row.id),
        filePath,
      );
      await publishGroup(deps, String(row.guild_id), "guild.artifacts.changed", {
        scope: "agent",
        agent_id: String(row.id),
        path: filePath,
      });
      await send(reply, 204);
    } catch (error) {
      catchArtifact(error);
    }
  });

  /** Where a sandbox daemon answers for this agent: its base URL and the headers the proxy adds. */
  type SandboxTarget = (agentId: string) => Promise<[string, Record<string, string>]>;

  async function proxySandbox(
    request: FastifyRequest,
    reply: FastifyReply,
    target: SandboxTarget,
    pathPart: string,
  ): Promise<void> {
    const user = await currentUser(repo, request, deps);
    await ownedAgent(repo, param(request, "agent_id"), user);
    try {
      const [base, headers] = await target(param(request, "agent_id"));
      await proxyHttp(request, reply, base, headers, pathPart);
    } catch (error) {
      if (error instanceof RunRequestError) {
        throw new HttpError(error.status, error.detail);
      }
      throw error;
    }
  }

  function proxySandboxWs(
    socket: import("ws").WebSocket,
    request: FastifyRequest,
    target: SandboxTarget,
  ): void {
    const agentId = param(request, "agent_id");
    let touchedAt = 0;
    startSandboxWsProxy(
      socket,
      request,
      async () => {
        const user = await currentUser(repo, request, deps);
        await ownedAgent(repo, agentId, user);
        const [base, extraHeaders] = await target(agentId);
        return { base, extraHeaders, pathPart: filePathParam(request) };
      },
      (error) => {
        if (error instanceof HttpError) {
          return 1008;
        }
        if (error instanceof RunRequestError) {
          return 1013;
        }
        return 1008;
      },
      () => {
        const now = Date.now();
        if (now - touchedAt < SANDBOX_TOUCH_INTERVAL_MS) {
          return;
        }
        touchedAt = now;
        generationOf(deps).touch_sandbox(agentId);
      },
    );
  }

  /** Proxies `prefix` and `prefix/*`, HTTP and WebSocket, to the daemon `target` resolves. */
  function registerSandboxProxy(prefix: string, target: SandboxTarget): void {
    const methods = ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
    for (const url of [prefix, `${prefix}/*`]) {
      const pathOf = url === prefix ? () => "" : filePathParam;
      app.route({
        method: "GET",
        url,
        exposeHeadRoute: false,
        handler: async (request, reply) => {
          await proxySandbox(request, reply, target, pathOf(request));
        },
        wsHandler: (socket, request) => {
          proxySandboxWs(socket, request, target);
        },
      });
      app.route({
        method: [...methods],
        url,
        handler: async (request, reply) => {
          await proxySandbox(request, reply, target, pathOf(request));
        },
      });
    }
  }

  app.get("/api/agents/:agent_id/browser", async (request) => {
    const user = await currentUser(repo, request, deps);
    await ownedAgent(repo, param(request, "agent_id"), user);
    try {
      await generationOf(deps).ensure_browser(param(request, "agent_id"));
    } catch (error) {
      if (error instanceof RunRequestError) {
        throw new HttpError(error.status, error.detail);
      }
      throw error;
    }
    return { status: "ready" };
  });

  registerSandboxProxy("/api/agents/:agent_id/browser/vnc", (agentId) =>
    generationOf(deps).browser_proxy_target(agentId),
  );

  app.post("/api/agents/:agent_id/cli", async (request) => {
    const user = await currentUser(repo, request, deps);
    await ownedAgent(repo, param(request, "agent_id"), user);
    try {
      await generationOf(deps).ensure_cli(param(request, "agent_id"));
    } catch (error) {
      if (error instanceof RunRequestError) {
        throw new HttpError(error.status, error.detail);
      }
      throw error;
    }
    return { status: "ready" };
  });

  registerSandboxProxy("/api/agents/:agent_id/cli/tty", (agentId) =>
    generationOf(deps).cli_proxy_target(agentId),
  );

  app.get("/api/agents/:agent_id/runs", async (request) => {
    const user = await currentUser(repo, request, deps);
    await ownedAgent(repo, param(request, "agent_id"), user);
    return generationOf(deps).list_run_payloads(param(request, "agent_id"));
  });

  app.post("/api/agents/:agent_id/runs", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const agent = await ownedAgent(repo, param(request, "agent_id"), user);
    const body = bodyOf(request);
    const ids = attachmentIdsOf(body);
    const raw = body.message;
    const message = raw === undefined || raw === null ? (ids.length ? "" : null) : String(raw);
    if (message !== null && !message.trim() && !ids.length) {
      throw new HttpError(422, "message must not be empty");
    }
    const attachments = await resolveChatAttachments(
      deps,
      String(agent.org_id),
      agentModelOf(agent),
      ids,
    );
    try {
      const run = await generationOf(deps).create_run(param(request, "agent_id"), message, {
        attachments,
        startedByUserId: String(user.id),
      });
      await send(reply, message !== null ? 202 : 201, run);
    } catch (error) {
      if (error instanceof RunRequestError) {
        throw new HttpError(error.status, error.detail);
      }
      throw error;
    }
  });

  app.get("/api/runs/:run_id", async (request) => {
    const user = await currentUser(repo, request, deps);
    const row = await ownedRun(repo, param(request, "run_id"), user);
    return generationOf(deps).run_payload(row);
  });

  app.get("/api/runs/:run_id/messages", async (request) => {
    const user = await currentUser(repo, request, deps);
    await ownedRun(repo, param(request, "run_id"), user);
    return (await repo.listMessages(param(request, "run_id"))).map((row) => messageItem(row));
  });

  app.post("/api/runs/:run_id/resume", async (request) => {
    const user = await currentUser(repo, request, deps);
    await ownedRun(repo, param(request, "run_id"), user);
    try {
      return await generationOf(deps).resume_run(param(request, "run_id"));
    } catch (error) {
      if (error instanceof RunRequestError) {
        throw new HttpError(error.status, error.detail);
      }
      throw error;
    }
  });

  app.post("/api/runs/:run_id/messages", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const run = await ownedRun(repo, param(request, "run_id"), user);
    const agent = await repo.getAgent(String(run.agent_id));
    if (agent === null) {
      throw new HttpError(404, "run not found");
    }
    const body = bodyOf(request);
    const ids = attachmentIdsOf(body);
    if (!ids.length) {
      const missing = missingBodyFields(request.body, ["content"]);
      if (missing) {
        throw missing;
      }
    }
    const content = body.content === undefined || body.content === null ? "" : String(body.content);
    if (!content.trim() && !ids.length) {
      throw new HttpError(422, "content must not be empty");
    }
    const attachments = await resolveChatAttachments(
      deps,
      String(agent.org_id),
      agentModelOf(agent),
      ids,
    );
    try {
      const run = await generationOf(deps).add_message(param(request, "run_id"), content, attachments);
      await send(reply, 202, run);
    } catch (error) {
      if (error instanceof RunRequestError) {
        throw new HttpError(error.status, error.detail);
      }
      throw error;
    }
  });

  app.post("/api/runs/:run_id/cancel", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    await ownedRun(repo, param(request, "run_id"), user);
    try {
      const run = await generationOf(deps).cancel(param(request, "run_id"));
      if (run === null) {
        await send(reply, 204);
        return;
      }
      await send(reply, 202, run);
    } catch (error) {
      if (error instanceof RunRequestError) {
        throw new HttpError(error.status, error.detail);
      }
      throw error;
    }
  });

  app.get("/api/runs/:run_id/stream", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    await ownedRun(repo, param(request, "run_id"), user);
    const loop = generationOf(deps);
    const runId = param(request, "run_id");
    await pipeSse(
      request,
      reply,
      () => loop.subscribe(runId),
      (queue) => loop.unsubscribe(runId, queue),
    );
  });

  app.get("/api/usage", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    return { organisation: await usageForOrg(deps, org, String(user.id)) };
  });

  app.get("/api/guilds/:guild_id/usage", async (request) => {
    const user = await currentUser(repo, request, deps);
    const guild = await ownedGuild(repo, param(request, "guild_id"), user);
    const agents = await repo.listAgents(String(guild.id));
    return {
      id: guild.id,
      name: guild.name,
      ...usageFields(await repo.getUsage("guild", String(guild.id))),
      agents: await Promise.all(
        agents.map(async (agent) => ({
          id: agent.id,
          name: agent.name,
          avatar_shape: agent.avatar_shape || "teardrop",
          avatar_color: agent.avatar_color || "#7c5cff",
          ...usageFields(await repo.getUsage("agent", String(agent.id))),
        })),
      ),
    };
  });

  app.get("/api/agents/:agent_id/usage", async (request) => {
    const user = await currentUser(repo, request, deps);
    const agent = await ownedAgent(repo, param(request, "agent_id"), user);
    return {
      id: agent.id,
      name: agent.name,
      guild_id: agent.guild_id,
      guild_name: agent.guild_name,
      workspace_mib:
        agent.workspace_mib === null || agent.workspace_mib === undefined
          ? null
          : Number(agent.workspace_mib),
      max_workspace_mib: maxWorkspaceMibOf(agentConfigObject(agent)),
      machine: {
        id: agent.machine_id,
        name: agent.machine_name,
        workspace_mib:
          agent.machine_workspace_mib === null || agent.machine_workspace_mib === undefined
            ? null
            : Number(agent.machine_workspace_mib),
        max_workspace_mib: Number(agent.machine_max_workspace_mib),
      },
      ...usageFields(await repo.getUsage("agent", String(agent.id))),
    };
  });

  app.get("/api/platform", async (request) => {
    const user = await currentUser(repo, request, deps);
    if (!(await isInstanceAdmin(deps, String(user.id)))) {
      throw new HttpError(404, "Not Found");
    }
    return httpAccess(repo, { viewScope: "platform", mcp: deps.mcp ?? null });
  });

  app.get("/api/access", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    return httpAccess(repo, { orgId: String(org.id), viewScope: "org", mcp: deps.mcp ?? null });
  });

  app.get("/api/guilds/:guild_id/access", async (request) => {
    const user = await currentUser(repo, request, deps);
    const guild = await ownedGuild(repo, param(request, "guild_id"), user);
    return httpAccess(repo, {
      orgId: String(guild.org_id),
      guildId: String(guild.id),
      viewScope: "guild",
      mcp: deps.mcp ?? null,
    });
  });

  app.get("/api/agents/:agent_id/access", async (request) => {
    const user = await currentUser(repo, request, deps);
    const row = await ownedAgent(repo, param(request, "agent_id"), user);
    return httpAccess(repo, {
      orgId: String(row.org_id),
      guildId: String(row.guild_id),
      agentId: String(row.id),
      viewScope: "agent",
      mcp: deps.mcp ?? null,
    });
  });

  async function visibleCredential(row: Record<string, unknown>, user: Record<string, unknown>): Promise<boolean> {
    const ownerScope = row.owner_scope;
    const ownerId = row.owner_id;
    if (ownerScope === "platform") {
      return true;
    }
    if (ownerScope === "org") {
      const membership = await repo.getMembership(String(ownerId || ""), String(user.id));
      return membership !== null;
    }
    if (ownerScope === "guild") {
      const guild = await repo.getGuild(String(ownerId || ""));
      if (guild === null || !canSeeGuild(guild, String(user.id))) {
        return false;
      }
      const membership = await repo.getMembership(String(guild.org_id), String(user.id));
      return membership !== null;
    }
    const agent = await repo.getAgent(String(ownerId || ""));
    if (agent === null) {
      return false;
    }
    const membership = await repo.getMembership(String(agent.org_id), String(user.id));
    if (membership === null) {
      return false;
    }
    const guild = await repo.getGuild(String(agent.guild_id));
    return guild !== null && canSeeGuild(guild, String(user.id));
  }

  /** The organisation a login's owner belongs to; null for the platform. */
  async function ownerOrgId(ownerScope: string, ownerId: string | null): Promise<string | null> {
    if (ownerScope === "org") {
      return ownerId;
    }
    if (ownerScope === "guild") {
      const guild = await repo.getGuild(ownerId ?? "");
      return guild === null ? null : String(guild.org_id);
    }
    if (ownerScope === "agent") {
      const agent = await repo.getAgent(ownerId ?? "");
      return agent === null ? null : String(agent.org_id);
    }
    return null;
  }

  async function assertOwner(
    ownerScope: string,
    ownerId: string | null,
    user: Record<string, unknown>,
  ): Promise<string | null> {
    if (ownerScope === "platform") {
      throw new HttpError(400, "platform-owned credentials cannot be created here");
    }
    if (ownerScope === "org") {
      const membership = await repo.getMembership(ownerId || "", String(user.id));
      if (membership === null) {
        throw new HttpError(404, "organisation not found");
      }
      return null;
    }
    if (ownerScope === "guild") {
      const row = await ownedGuild(repo, ownerId || "", user);
      return String(row.id);
    }
    const row = await ownedAgent(repo, ownerId || "", user);
    return String(row.guild_id);
  }

  function encrypt(payload: Record<string, unknown>): [Buffer, Buffer] {
    return deps.masterKey ? encryptPayload(payload, deps.masterKey) : encryptPayload(payload);
  }

  function decrypt(ciphertext: unknown, nonce: unknown): Record<string, unknown> {
    return decryptPayload(asBuffer(ciphertext), asBuffer(nonce), deps.masterKey);
  }

  async function sendHtml(
    reply: FastifyReply,
    status: number,
    options: { success: boolean; title: string; message: string },
  ): Promise<FastifyReply> {
    return reply
      .code(status)
      .type("text/html; charset=utf-8")
      .header("content-type", "text/html; charset=utf-8")
      .send(oauthCallbackHtml(options));
  }

  async function discardAttempt(
    row: Record<string, unknown>,
    replaces?: boolean | undefined,
  ): Promise<void> {
    let keep = replaces;
    if (keep === undefined) {
      try {
        keep = pendingReplaces(decrypt(row.ciphertext, row.nonce));
      } catch {
        keep = false;
      }
    }
    if (keep) {
      await markDisconnected(repo, row);
    } else {
      await repo.deleteMcpConnection(String(row.id));
    }
    deps.mcp?.forget(String(row.id));
  }

  async function abandonOauthAttempt(state: string | undefined): Promise<void> {
    if (!state) {
      return;
    }
    const row = await repo.getMcpConnectionByOauthState(state);
    if (row !== null) {
      await discardAttempt(row);
    }
  }

  async function finishOauthConnection(
    row: Record<string, unknown>,
    server: Record<string, unknown>,
    stored: Record<string, unknown>,
    now: Date,
  ): Promise<Record<string, unknown> | null> {
    const [ciphertext, nonce] = encrypt(stored);
    const connected = await repo.saveMcpConnection(
      String(row.id),
      {
        ciphertext,
        nonce,
        status: "connected",
        accountHint: accountHint(stored),
        oauthState: null,
      },
      now,
    );
    if (connected !== null) {
      await repo.bindMcpConnection(
        {
          bindingId: newId("bind"),
          serverId: connected.mcp_server_id,
          ownerScope: connected.owner_scope,
          ownerId: connected.owner_id,
          connectionId: connected.id,
        },
        now,
      );
      try {
        await deps.mcp?.syncTools(repo, connected, server, { force: true });
      } catch {
        // Remote catalog sync is best-effort after OAuth, matching Python.
      }
      await fillFromEndpoint(connected, server);
    }
    return connected;
  }

  /**
   * Fills an organisation server's blank display name (its slug) and blank description from
   * what its endpoint says at `initialize`, once a login to it connects. A server that says
   * nothing keeps what it has.
   */
  async function fillFromEndpoint(connection: Record<string, unknown>, server: Record<string, unknown>): Promise<void> {
    if (!server.owner_org_id || !deps.mcp || connection.status !== "connected") {
      return;
    }
    const manifest = server.manifest as Manifest;
    const blankName = manifest.display_name === manifest.slug;
    const blankDescription = !manifest.description.trim();
    if (!blankName && !blankDescription) {
      return;
    }
    try {
      const info = await deps.mcp.describeEndpoint(repo, connection, server);
      const next: Manifest = {
        ...manifest,
        ...(blankName && info.name ? { display_name: info.name.slice(0, 120) } : {}),
        ...(blankDescription && info.instructions ? { description: info.instructions.slice(0, DESCRIPTION_MAX) } : {}),
      };
      if (next.display_name !== manifest.display_name || next.description !== manifest.description) {
        await repo.updateConnector(String(server.id), { manifest: next }, new Date());
      }
    } catch {
      // The server keeps the name and description it was added with.
    }
  }

  /** Stores a signed-in login that still needs its settings: pending, bound, with no sign-in under way. */
  async function awaitSettings(row: Record<string, unknown>, stored: Record<string, unknown>, now: Date): Promise<void> {
    const [ciphertext, nonce] = encrypt(stored);
    const saved = await repo.saveMcpConnection(
      String(row.id),
      { ciphertext, nonce, status: "pending", accountHint: accountHint(stored), oauthState: null },
      now,
    );
    if (saved !== null) {
      await repo.bindMcpConnection(
        {
          bindingId: newId("bind"),
          serverId: saved.mcp_server_id,
          ownerScope: saved.owner_scope,
          ownerId: saved.owner_id,
          connectionId: saved.id,
        },
        now,
      );
    }
  }

  function githubOauthCookieSecure(): boolean {
    return cookieSecure(deps.config?.publicBaseUrl ?? "");
  }

  function appendSetCookie(reply: FastifyReply, value: string): void {
    const existing = reply.getHeader("set-cookie");
    if (!existing) {
      reply.header("set-cookie", value);
      return;
    }
    const list = (Array.isArray(existing) ? existing : [existing]).map(String);
    reply.header("set-cookie", [...list, value]);
  }

  /**
   * The GitHub App callback: the code proves which user installed. The installation id
   * counts only when that user can reach it. With no id, one installation of this App is
   * kept, several open a picker, and none sends the operator to install. The user token
   * is discarded; the connection keeps the installation id.
   */
  async function applyGithubInstallation(
    row: Record<string, unknown>,
    installation: GithubInstallation,
  ): Promise<void> {
    const [ciphertext, nonce] = encrypt({ installation_id: installation.id, account: installation.account });
    const connected = await repo.saveMcpConnection(
      String(row.id),
      {
        ciphertext,
        nonce,
        status: "connected",
        accountHint: installation.account,
        oauthState: null,
      },
      new Date(),
    );
    if (connected === null) {
      throw new OAuthError("the pending connection was removed");
    }
    await repo.bindMcpConnection(
      {
        bindingId: newId("bind"),
        serverId: connected.mcp_server_id,
        ownerScope: connected.owner_scope,
        ownerId: connected.owner_id,
        connectionId: connected.id,
      },
      new Date(),
    );
  }

  function githubPendingFields(row: Record<string, unknown>): {
    storedId?: string;
    redirectUri?: string;
    pending: Record<string, unknown>;
  } {
    try {
      const pending = decrypt(row.ciphertext, row.nonce);
      const stored =
        pending.installation_id !== undefined && pending.installation_id !== null
          ? String(pending.installation_id)
          : undefined;
      const oauth = pending.oauth;
      let redirectUri: string | undefined;
      if (oauth && typeof oauth === "object" && !Array.isArray(oauth)) {
        const uri = (oauth as { redirect_uri?: unknown }).redirect_uri;
        if (typeof uri === "string" && uri) {
          redirectUri = uri;
        }
      }
      return { ...(stored ? { storedId: stored } : {}), ...(redirectUri ? { redirectUri } : {}), pending };
    } catch {
      return { pending: {} };
    }
  }

  async function completeGithubAuth(
    row: Record<string, unknown>,
    code: string,
    rawInstallationId: string | undefined,
  ): Promise<{ status: "connected" } | { status: "install" } | { status: "pick"; state: string }> {
    const fields = githubPendingFields(row);
    const storedId = rawInstallationId || fields.storedId;
    const github = requireGithubApp();
    const proxyUrl = process.env.ADAPTER_PROXY_URL ?? "";
    const userToken = await exchangeUserCode(github, code, {
      proxyUrl,
      ...(fields.redirectUri ? { redirectUri: fields.redirectUri } : {}),
    });
    let choice;
    try {
      choice = await resolveGithubInstallation(github, userToken, storedId, { proxyUrl });
    } catch (error) {
      if (error instanceof GithubError) {
        throw new OAuthError(error.message);
      }
      throw error;
    }
    if (choice.action === "use") {
      await applyGithubInstallation(row, choice.installation);
      return { status: "connected" };
    }
    if (choice.action === "install") {
      // The install page's own authorization hop returns to the App's first callback URL with no
      // `redirect_uri`, so its code is traded without one.
      const { redirect_uri: _redirect, ...oauth } =
        fields.pending.oauth && typeof fields.pending.oauth === "object" && !Array.isArray(fields.pending.oauth)
          ? (fields.pending.oauth as Record<string, unknown>)
          : {};
      const [ciphertext, nonce] = encrypt({ ...fields.pending, oauth });
      await repo.saveMcpConnection(
        String(row.id),
        {
          ciphertext,
          nonce,
          status: "pending",
          accountHint: "",
          oauthState: String(row.oauth_state ?? ""),
        },
        new Date(),
      );
      return { status: "install" };
    }
    const pickerState = newState();
    const [ciphertext, nonce] = encrypt({
      ...fields.pending,
      github_user_token: userToken,
      oauth: {
        ...(fields.pending.oauth && typeof fields.pending.oauth === "object" && !Array.isArray(fields.pending.oauth)
          ? fields.pending.oauth
          : {}),
        replaces: pendingReplaces(fields.pending),
      },
    });
    await repo.saveMcpConnection(
      String(row.id),
      { ciphertext, nonce, status: "pending", accountHint: "", oauthState: pickerState },
      new Date(),
    );
    return { status: "pick", state: pickerState };
  }

  async function pendingGithubRow(
    state: string | undefined,
    request: FastifyRequest,
    githubCallback: boolean,
  ): Promise<Record<string, unknown> | null> {
    if (state) {
      const row = await repo.getMcpConnectionByOauthState(state);
      if (row !== null) {
        return row;
      }
    }
    if (!githubCallback) {
      return null;
    }
    try {
      const user = await currentUser(repo, request, deps);
      return await repo.getPendingGithubConnectionForUser(String(user.id), GITHUB_SERVER_ID);
    } catch {
      return null;
    }
  }

  async function githubPickerSession(state: string | undefined): Promise<{
    row: Record<string, unknown>;
    payload: Record<string, unknown>;
    userToken: string;
  } | null> {
    if (!state) {
      return null;
    }
    const row = await repo.getMcpConnectionByOauthState(state);
    if (row === null || row.status !== "pending") {
      return null;
    }
    const server = await repo.getMcpServer(String(row.mcp_server_id));
    if (server === null || server.slug !== GITHUB_SLUG) {
      return null;
    }
    let payload: Record<string, unknown>;
    try {
      payload = decrypt(row.ciphertext, row.nonce);
    } catch {
      return null;
    }
    const token = payload.github_user_token;
    if (typeof token !== "string" || !token) {
      return null;
    }
    return { row, payload, userToken: token };
  }

  /** The caller's role in the organisation and the guilds they can see there; null for a non-member. */
  async function secretViewer(orgId: string, user: Record<string, unknown>): Promise<SecretViewer | null> {
    const membership = await repo.getMembership(orgId, String(user.id));
    if (membership === null) {
      return null;
    }
    const guilds = await repo.listGuildsForUser(orgId, String(user.id));
    return {
      role: String(membership.role),
      visibleGuildIds: new Set(guilds.map((guild) => String(guild.id))),
    };
  }

  /** A secret of an organisation the caller belongs to, with the caller as viewer. */
  async function memberSecret(
    secretId: string,
    user: Record<string, unknown>,
  ): Promise<[Record<string, unknown>, SecretViewer]> {
    const row = await repo.getSecret(secretId);
    const viewer = row === null ? null : await secretViewer(String(row.org_id), user);
    if (row === null || viewer === null) {
      throw new HttpError(404, "secret not found");
    }
    return [row, viewer];
  }

  /** Each granted agent's guild; refuses a guild or agent outside the organisation. */
  async function grantTargets(orgId: string, access: SecretAccess): Promise<Map<string, string>> {
    const found = await repo.secretGrantTargets(orgId, access.guild_ids, access.agent_ids);
    for (const id of access.guild_ids) {
      if (!found.guildIds.has(id)) {
        throw new HttpError(422, `unknown guild ${id}`);
      }
    }
    for (const id of access.agent_ids) {
      if (!found.agentGuilds.has(id)) {
        throw new HttpError(422, `unknown agent ${id}`);
      }
    }
    return found.agentGuilds;
  }

  function secretHttp(error: unknown): unknown {
    if (error instanceof CredentialError || error instanceof SecretAccessError) {
      return new HttpError(422, error.message);
    }
    if (error instanceof SecretNameTaken) {
      return new HttpError(409, error.message);
    }
    return error;
  }

  app.get("/api/secrets", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const orgId = String(org.id);
    const query = request.query as { guild_id?: string; agent_id?: string };
    if (query.guild_id && String((await ownedGuild(repo, query.guild_id, user)).org_id) !== orgId) {
      throw new HttpError(404, "guild not found");
    }
    if (query.agent_id && String((await ownedAgent(repo, query.agent_id, user)).org_id) !== orgId) {
      throw new HttpError(404, "agent not found");
    }
    const viewer = await secretViewer(orgId, user);
    if (viewer === null) {
      throw new HttpError(404, "organisation not found");
    }
    const rows = await repo.listSecrets(orgId, {
      guildId: query.guild_id ?? null,
      agentId: query.agent_id ?? null,
    });
    return { secrets: rows.map((row) => secretMetadata(row, viewer)) };
  });

  app.post("/api/secrets", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const orgId = String(org.id);
    const missing = missingBodyFields(request.body, ["name", "description", "value"]);
    if (missing) {
      throw missing;
    }
    const body = bodyOf(request);
    try {
      const name = validateSecretName(body.name);
      const description = validateSecretDescription(body.description);
      const payload = secretPayload(body.value);
      const access = validateSecretAccess(body);
      const viewer = await secretViewer(orgId, user);
      if (viewer === null) {
        throw new HttpError(404, "organisation not found");
      }
      const agentGuilds = await grantTargets(orgId, access);
      if (!canCreateSecret(access, viewer, agentGuilds)) {
        throw new HttpError(
          403,
          "only an org owner or admin can create an organisation-wide or unassigned secret, or grant one outside your guilds",
        );
      }
      const [ciphertext, nonce] = encrypt(payload);
      const row = await repo.insertSecret(
        {
          secretId: newId("sec"),
          orgId,
          name,
          description,
          access,
          ciphertext,
          nonce,
          createdByUserId: String(user.id),
        },
        new Date(),
      );
      await deps.generation?.secretAccessChanged(await repo.listAgentIdsReached(orgId, access));
      await send(reply, 201, secretMetadata(row, viewer));
    } catch (error) {
      throw secretHttp(error);
    }
  });

  app.get("/api/secrets/:secret_id", async (request) => {
    const user = await currentUser(repo, request, deps);
    const [row, viewer] = await memberSecret(param(request, "secret_id"), user);
    return secretMetadata(row, viewer);
  });

  app.patch("/api/secrets/:secret_id", async (request) => {
    const user = await currentUser(repo, request, deps);
    const secretId = param(request, "secret_id");
    const [row, viewer] = await memberSecret(secretId, user);
    if (!canManageSecret(row, viewer)) {
      throw new HttpError(403, "only an org owner or admin can change this secret");
    }
    const body = bodyOf(request);
    const given = (field: string) => body[field] !== undefined && body[field] !== null;
    if (!given("name") && !given("description") && !given("value")) {
      throw new HttpError(422, "name, description, or value is required");
    }
    try {
      let ciphertext: Buffer | null = null;
      let nonce: Buffer | null = null;
      if (given("value")) {
        [ciphertext, nonce] = encrypt(secretPayload(body.value));
      }
      const updated = await repo.updateSecret(
        secretId,
        {
          name: given("name") ? validateSecretName(body.name) : null,
          description: given("description") ? validateSecretDescription(body.description) : null,
          ciphertext,
          nonce,
        },
        new Date(),
      );
      if (updated === null) {
        throw new HttpError(404, "secret not found");
      }
      await deps.generation?.secretChanged(secretId);
      return secretMetadata(updated, viewer);
    } catch (error) {
      throw secretHttp(error);
    }
  });

  app.put("/api/secrets/:secret_id/access", async (request) => {
    const user = await currentUser(repo, request, deps);
    const secretId = param(request, "secret_id");
    const [row, viewer] = await memberSecret(secretId, user);
    if (!managesOrgSecrets(viewer.role)) {
      throw new HttpError(403, "only an org owner or admin can change who gets a secret");
    }
    const missing = missingBodyFields(request.body, ["org_wide"]);
    if (missing) {
      throw missing;
    }
    try {
      const access = validateSecretAccess(bodyOf(request));
      if (!access.org_wide) {
        // Grants in guilds the caller cannot see stay: the caller cannot name them.
        for (const grant of secretGrants(row)) {
          if (viewer.visibleGuildIds.has(grant.in_guild_id)) {
            continue;
          }
          if (grant.guild_id && !access.guild_ids.includes(grant.guild_id)) {
            access.guild_ids.push(grant.guild_id);
          }
          if (grant.agent_id && !access.agent_ids.includes(grant.agent_id)) {
            access.agent_ids.push(grant.agent_id);
          }
        }
      }
      const orgId = String(row.org_id);
      await grantTargets(orgId, access);
      const before = await repo.listAgentIdsReached(orgId, accessOf(row));
      const updated = await repo.setSecretAccess(secretId, access, new Date());
      if (updated === null) {
        throw new HttpError(404, "secret not found");
      }
      const after = await repo.listAgentIdsReached(orgId, access);
      const reached = new Set(after);
      const left = new Set(before);
      await deps.generation?.secretAccessChanged([
        ...before.filter((id) => !reached.has(id)),
        ...after.filter((id) => !left.has(id)),
      ]);
      return secretMetadata(updated, viewer);
    } catch (error) {
      throw secretHttp(error);
    }
  });

  app.delete("/api/secrets/:secret_id", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const secretId = param(request, "secret_id");
    const [row, viewer] = await memberSecret(secretId, user);
    if (!canManageSecret(row, viewer)) {
      throw new HttpError(403, "only an org owner or admin can delete this secret");
    }
    const reached = await repo.listAgentIdsReached(String(row.org_id), accessOf(row));
    if ((await repo.deleteSecret(secretId)) === null) {
      throw new HttpError(404, "secret not found");
    }
    await deps.generation?.secretAccessChanged(reached);
    await send(reply, 204);
  });

  app.put("/api/bindings", async (request) => {
    const user = await currentUser(repo, request, deps);
    const missing = missingBodyFields(request.body, ["catalog_kind", "catalog_id", "scope", "enabled"]);
    if (missing) {
      throw missing;
    }
    const body = bodyOf(request);
    try {
      const [catalogKind, catalogId] = validateCatalog(String(body.catalog_kind ?? ""), String(body.catalog_id ?? ""));
      const [scope, scopeId] = validateScope(
        String(body.scope ?? ""),
        body.scope_id === undefined || body.scope_id === null ? null : String(body.scope_id),
      );
      const guildId = await scopeGuild(repo, scope, scopeId, user);
      let orgId: string | null = null;
      if (scope === "org") {
        orgId = scopeId;
      } else if (scope === "guild") {
        const guild = await repo.getGuild(scopeId || "");
        orgId = guild === null ? null : String(guild.org_id);
      } else if (scope === "agent") {
        const agent = await repo.getAgent(scopeId || "");
        orgId = agent === null ? null : String(agent.org_id);
      }
      const replaceConnection = Object.prototype.hasOwnProperty.call(body, "connection_id");
      const connectionId = replaceConnection
        ? body.connection_id === null || body.connection_id === undefined
          ? null
          : String(body.connection_id)
        : null;
      if (catalogKind === "mcp_tool" && !(await repo.isListedMcpTool(catalogId, orgId))) {
        throw new HttpError(404, "mcp tool not found");
      }
      let server: Record<string, unknown> | null = null;
      let connection: Record<string, unknown> | null = null;
      if (catalogKind === "mcp") {
        server = await repo.getMcpServer(catalogId);
        if (server === null || !serverVisible(server, orgId)) {
          throw new HttpError(404, "mcp server not found");
        }
        if (connectionId !== null) {
          connection = await repo.getMcpConnection(connectionId);
          if (connection === null) {
            throw new HttpError(404, "connection not found");
          }
        }
      }
      const overlay = validateBinding({
        catalogKind,
        catalogId,
        scope,
        scopeId,
        enabled: Boolean(body.enabled),
        guildId,
        orgId,
        server,
        connection,
        connectionId,
      });
      let writeConnectionId = overlay.connection_id;
      if (catalogKind === "mcp" && !replaceConnection) {
        const existing = await repo.getBinding({ catalogKind, catalogId, scope, scopeId });
        if (existing !== null) {
          writeConnectionId =
            existing.connection_id === null || existing.connection_id === undefined
              ? null
              : String(existing.connection_id);
        }
      }
      const now = new Date();
      const row =
        scope === "platform"
          ? await repo.upsertPlatformBinding(
              {
                bindingId: newId("bind"),
                catalogKind: overlay.catalog_kind,
                catalogId: overlay.catalog_id,
                enabled: overlay.enabled,
                connectionId: writeConnectionId,
              },
              now,
            )
          : await repo.upsertBinding(
              {
                bindingId: newId("bind"),
                catalogKind: overlay.catalog_kind,
                catalogId: overlay.catalog_id,
                scope: overlay.scope,
                scopeId: overlay.scope_id,
                enabled: overlay.enabled,
                connectionId: writeConnectionId,
              },
              now,
              userActor(user),
            );
      return bindingItem(row);
    } catch (error) {
      if (error instanceof BindingError) {
        throw new HttpError(422, error.message);
      }
      throw error;
    }
  });

  app.delete("/api/bindings", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const query = queryOf(request);
    try {
      const [catalogKind, catalogId] = validateCatalog(query.catalog_kind ?? "", query.catalog_id ?? "");
      const [scope, scopeId] = validateScope(query.scope ?? "", query.scope_id ?? null);
      await scopeGuild(repo, scope, scopeId, user);
      const row = await repo.deleteBinding(
        { catalogKind, catalogId, scope, scopeId },
        userActor(user),
      );
      if (row === null) {
        throw new HttpError(404, "binding not found");
      }
      await send(reply, 204);
    } catch (error) {
      if (error instanceof BindingError) {
        throw new HttpError(422, error.message);
      }
      throw error;
    }
  });

  app.get("/api/mcp/servers", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const rows = await repo.listMcpServers(String(org.id));
    return { servers: rows.map((row) => serverItem(row)) };
  });

  app.get("/api/mcp/servers/:server_id/logo", async (request, reply) => {
    await currentUser(repo, request, deps);
    const file = logoPath(installedConnectors().byId(param(request, "server_id")));
    if (file === null) {
      throw new HttpError(404, "logo not found");
    }
    return reply
      .code(200)
      .header("content-type", "image/svg+xml")
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, max-age=3600")
      .send(await readFile(file));
  });

  app.get("/api/mcp/connections", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const query = request.query as { guild_id?: string; agent_id?: string };
    const guildId = query.guild_id;
    const agentId = query.agent_id;
    if (guildId) {
      await ownedGuild(repo, guildId, user);
    }
    if (agentId) {
      await ownedAgent(repo, agentId, user);
    }
    const rows = await repo.listMcpConnections({
      orgId: String(org.id),
      guildId: guildId ?? null,
      agentId: agentId ?? null,
    });
    return { connections: rows.map((row) => connectionMetadata(row)) };
  });

  app.post("/api/mcp/connections", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const missing = missingBodyFields(request.body, ["mcp_server_id", "owner_scope"]);
    if (missing) {
      throw missing;
    }
    const body = bodyOf(request);
    let ownerScope: string;
    let ownerId: string | null;
    try {
      [ownerScope, ownerId] = validateOwner(String(body.owner_scope ?? ""), body.owner_id as string | null);
    } catch (error) {
      if (error instanceof CredentialError) {
        throw new HttpError(422, error.message);
      }
      throw error;
    }
    await assertOwner(ownerScope, ownerId, user);
    const server = await repo.getMcpServer(String(body.mcp_server_id ?? ""));
    if (server === null || !serverVisible(server, await ownerOrgId(ownerScope, ownerId))) {
      throw new HttpError(404, "mcp server not found");
    }
    if (server.enabled === false) {
      throw new HttpError(422, "connector is disabled");
    }
    const now = new Date();
    if (server.auth === "token") {
      const settings = body.settings;
      if (settings !== undefined && (typeof settings !== "object" || settings === null || Array.isArray(settings))) {
        throw new HttpError(422, "settings must be an object");
      }
      let connected: Record<string, unknown>;
      try {
        ({ connection: connected } = await connect(
          repo,
          deps.mcp ?? null,
          {
            server,
            ownerScope,
            ownerId,
            credentials: body,
            ...(settings ? { settings: settings as Record<string, unknown> } : {}),
          },
          now,
          { masterKey: deps.masterKey },
        ));
      } catch (error) {
        if (error instanceof ConnectError) {
          throw new HttpError(error.status, error.message);
        }
        throw error;
      }
      await fillFromEndpoint(connected, server);
      return send(reply, 201, connectionMetadata(connected));
    }
    const existing = await repo.getMcpConnectionForOwner(String(server.id), ownerScope, ownerId);
    if (existing !== null && existing.status === "connected") {
      throw new HttpError(409, "already connected; disconnect first");
    }
    const replaces = existing !== null;
    let oauthState: string | null = null;
    let authorize: string | undefined;
    let bind = true;
    let ciphertext: Buffer;
    let nonce: Buffer;
    if (isGithubApp(server)) {
      if (ownerScope !== "org" && ownerScope !== "guild" && ownerScope !== "agent") {
        throw new HttpError(422, "GitHub connects at the organisation, a guild, or an agent");
      }
      const github = githubAppConfig();
      if (github === null) {
        throw new HttpError(422, { message: "the GitHub App is not configured", setup_state: "unsupported" });
      }
      oauthState = newState();
      const redirect = oauthCallbackUrl(deps.config?.publicBaseUrl ?? "", request);
      // User authorization first: the callback then uses an installation the user already
      // reaches, or sends them on to install the App. GitHub sends nobody back from editing an
      // existing installation, so Connect never starts on the install page.
      [ciphertext, nonce] = encrypt(pendingOauthPayload("", redirect, replaces));
      authorize = userAuthorizationUrl(github, oauthState, redirect);
      bind = false;
      appendSetCookie(reply, githubOauthStateCookie(oauthState, githubOauthCookieSecure()));
    } else if (startsBrowserOauth(server)) {
      const redirect = oauthCallbackUrl(deps.config?.publicBaseUrl ?? "", request);
      try {
        const [discovery, client] = await ensureClient(repo, server, redirect);
        const [verifier, challenge] = pkcePair();
        oauthState = newState();
        [ciphertext, nonce] = encrypt(pendingOauthPayload(verifier, redirect, replaces));
        authorize = authorizationUrl(discovery, {
          clientId: String(client.client_id),
          redirectUri: redirect,
          codeChallenge: challenge,
          state: oauthState,
        });
        bind = false;
      } catch (error) {
        if (error instanceof OAuthUnsupportedError) {
          throw new HttpError(422, { message: error.message, setup_state: "unsupported" });
        }
        if (error instanceof OAuthError) {
          throw new HttpError(502, error.message);
        }
        throw error;
      }
    } else {
      [ciphertext, nonce] = encrypt({});
    }
    const row = await repo.connectMcp(
      {
        connectionId: newId("conn"),
        bindingId: newId("bind"),
        serverId: String(server.id),
        ownerScope,
        ownerId,
        ciphertext,
        nonce,
        oauthState,
        bind,
        status: "pending",
        accountHint: "",
      },
      now,
    );
    const payload: Record<string, unknown> = connectionMetadata(row);
    if (authorize !== undefined) {
      payload.authorization_url = authorize;
      // Where the consent step sends the operator, shown before they go.
      payload.authorization_host = new URL(authorize).host;
    }
    await send(reply, 201, payload);
  });

  app.get("/api/mcp/oauth/callback", async (request, reply) => {
    const query = request.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
      installation_id?: string;
      setup_action?: string;
    };
    const code = query.code;
    const state = query.state || requestCookies(request)[GITHUB_OAUTH_STATE_COOKIE] || undefined;
    const error = query.error;
    const errorDescription = query.error_description;
    const installationId = query.installation_id;
    const setupAction = query.setup_action;
    if (error) {
      await abandonOauthAttempt(state);
      return sendHtml(reply, 400, {
        success: false,
        title: "Authorization Cancelled",
        message: errorDescription || error || "The authorization request was cancelled or incomplete.",
      });
    }
    if (setupAction === "request") {
      await abandonOauthAttempt(state);
      return sendHtml(reply, 400, {
        success: false,
        title: "Approval Required",
        message:
          "An organisation admin needs to approve the GitHub App. Connect again after they approve.",
      });
    }
    const githubCallback = Boolean(
      installationId || setupAction === "install" || setupAction === "update" || (code && !query.state),
    );
    const row = await pendingGithubRow(state, request, githubCallback);
    if (row === null) {
      if (code && !query.state && !requestCookies(request)[GITHUB_OAUTH_STATE_COOKIE]) {
        return sendHtml(reply, 404, {
          success: false,
          title: "Session Expired",
          message:
            "This GitHub authorization could not be matched to a pending connection. Please try connecting again.",
        });
      }
      if (!code || !state) {
        await abandonOauthAttempt(state);
        return sendHtml(reply, 400, {
          success: false,
          title: "Authorization Cancelled",
          message: errorDescription || error || "The authorization request was cancelled or incomplete.",
        });
      }
      return sendHtml(reply, 404, {
        success: false,
        title: "Session Expired",
        message: "This authorization request has expired or was already completed. Please try connecting again.",
      });
    }
    const server = await repo.getMcpServer(String(row.mcp_server_id));
    if (server === null) {
      await discardAttempt(row);
      return sendHtml(reply, 404, {
        success: false,
        title: "Server Not Found",
        message: "The requested tool service could not be found.",
      });
    }
    if (isGithubApp(server)) {
      appendSetCookie(reply, clearGithubOauthStateCookie(githubOauthCookieSecure()));
      if (!code) {
        const parsedId = Number(installationId);
        if (!Number.isInteger(parsedId) || parsedId <= 0) {
          await discardAttempt(row);
          return sendHtml(reply, 400, {
            success: false,
            title: "Authorization Failed",
            message: "Could not complete the GitHub installation: the callback has no installation",
          });
        }
        try {
          const pending = decrypt(row.ciphertext, row.nonce);
          const redirectUri = oauthCallbackUrl(deps.config?.publicBaseUrl ?? "", request);
          const oauthState = String(row.oauth_state ?? state ?? "");
          const [ciphertext, nonce] = encrypt({
            ...pending,
            installation_id: parsedId,
            oauth: {
              ...(pending.oauth && typeof pending.oauth === "object" && !Array.isArray(pending.oauth)
                ? pending.oauth
                : {}),
              redirect_uri: redirectUri,
              replaces: pendingReplaces(pending),
            },
          });
          await repo.saveMcpConnection(
            String(row.id),
            { ciphertext, nonce, status: "pending", accountHint: "", oauthState },
            new Date(),
          );
          return reply.redirect(userAuthorizationUrl(requireGithubApp(), oauthState, redirectUri));
        } catch (caught) {
          await discardAttempt(row);
          const message = caught instanceof Error ? caught.message : String(caught);
          return sendHtml(reply, 400, {
            success: false,
            title: "Authorization Failed",
            message: `Could not complete the GitHub installation: ${message}`,
          });
        }
      }
      try {
        const result = await completeGithubAuth(row, code, installationId);
        if (result.status === "install") {
          return reply.redirect(installUrl(requireGithubApp(), String(row.oauth_state ?? state ?? "")));
        }
        if (result.status === "pick") {
          return reply.redirect(`/api/mcp/oauth/github-installation?state=${encodeURIComponent(result.state)}`);
        }
      } catch (caught) {
        await discardAttempt(row);
        const message = caught instanceof Error ? caught.message : String(caught);
        return sendHtml(reply, 400, {
          success: false,
          title: "Authorization Failed",
          message: `Could not complete the GitHub installation: ${message}`,
        });
      }
      return sendHtml(reply, 200, {
        success: true,
        title: "Connected to GitHub!",
        message:
          "The GitHub App is installed on the account you chose. Each guild picks its own repositories in Settings. You can close this window now.",
      });
    }
    if (!code || !state) {
      await discardAttempt(row);
      return sendHtml(reply, 400, {
        success: false,
        title: "Authorization Cancelled",
        message: errorDescription || error || "The authorization request was cancelled or incomplete.",
      });
    }
    try {
      const pending = decrypt(row.ciphertext, row.nonce);
      const [verifier, redirectUri] = pendingOauth(pending);
      const [discovery, client] = await ensureClient(repo, server, redirectUri);
      const tokens = await exchangeCode(discovery, {
        code,
        codeVerifier: verifier,
        clientId: String(client.client_id),
        clientSecret: typeof client.client_secret === "string" ? client.client_secret : null,
        redirectUri,
      });
      const now = new Date();
      const stored = tokenPayload(tokens, { now });
      const schema = installedConnectors().forServer(server)?.manifest.settings_schema;
      if (!settingsComplete(schema, row.settings)) {
        await awaitSettings(row, stored, now);
        return sendHtml(reply, 200, {
          success: true,
          title: `Signed in to ${String(server.display_name || server.slug)}`,
          message: "Finish its setup in guilds.run: the login connects once its settings are saved. You can close this window now.",
        });
      }
      await finishOauthConnection(row, server, stored, now);
    } catch (caught) {
      await discardAttempt(row);
      const message = caught instanceof Error ? caught.message : String(caught);
      return sendHtml(reply, 400, {
        success: false,
        title: "Authorization Failed",
        message: `Could not complete authorization: ${message}`,
      });
    }
    const serverSlug = String(server.slug ?? "service");
    const serverTitle = String(server.display_name || serverSlug.charAt(0).toUpperCase() + serverSlug.slice(1));
    return sendHtml(reply, 200, {
      success: true,
      title: `Connected to ${serverTitle}!`,
      message: `Your ${serverTitle} account has been connected successfully. You can close this window now and return to guilds.run.`,
    });
  });

  app.get("/api/mcp/oauth/github-installation", async (request, reply) => {
    const session = await githubPickerSession(queryOf(request).state);
    if (session === null) {
      return sendHtml(reply, 404, {
        success: false,
        title: "Session Expired",
        message: "This authorization request has expired or was already completed. Please try connecting again.",
      });
    }
    return reply
      .code(200)
      .type("text/html; charset=utf-8")
      .header("content-type", "text/html; charset=utf-8")
      .send(githubInstallationPickerHtml());
  });

  app.get("/api/mcp/oauth/github-installations", async (request) => {
    const session = await githubPickerSession(queryOf(request).state);
    if (session === null) {
      throw new HttpError(404, "session expired");
    }
    try {
      const choice = await resolveGithubInstallation(requireGithubApp(), session.userToken, undefined, {
        proxyUrl: process.env.ADAPTER_PROXY_URL ?? "",
        retryDelayMs: 0,
      });
      const installations = choice.action === "pick" ? choice.installations : choice.action === "use" ? [choice.installation] : [];
      const oauthState = String(session.row.oauth_state ?? "");
      return {
        installations: installations.map((item) => ({ id: item.id, account: item.account })),
        install_url: installUrl(requireGithubApp(), oauthState),
      };
    } catch (caught) {
      const message = caught instanceof GithubError || caught instanceof Error ? caught.message : String(caught);
      throw new HttpError(400, message);
    }
  });

  app.post("/api/mcp/oauth/github-installation", async (request, reply) => {
    const body = bodyOf(request);
    const state = typeof body.state === "string" ? body.state : "";
    const session = await githubPickerSession(state);
    if (session === null) {
      throw new HttpError(404, "session expired");
    }
    try {
      const choice = await resolveGithubInstallation(
        requireGithubApp(),
        session.userToken,
        body.installation_id as string | number | undefined,
        { proxyUrl: process.env.ADAPTER_PROXY_URL ?? "" },
      );
      if (choice.action !== "use") {
        throw new OAuthError("pick one of the GitHub accounts this App is already installed on");
      }
      await applyGithubInstallation(session.row, choice.installation);
      return send(reply, 200, { ok: true, account: choice.installation.account });
    } catch (caught) {
      if (caught instanceof HttpError) {
        throw caught;
      }
      const message = caught instanceof GithubError || caught instanceof OAuthError || caught instanceof Error ? caught.message : String(caught);
      throw new HttpError(400, message);
    }
  });

  app.get("/api/mcp/connections/:connection_id", async (request) => {
    const user = await currentUser(repo, request, deps);
    const connectionId = param(request, "connection_id");
    const row = await repo.getMcpConnection(connectionId);
    if (row === null || !(await visibleCredential(row, user))) {
      throw new HttpError(404, "connection not found");
    }
    const bindings = await repo.listBindingsForConnection(connectionId);
    return { ...connectionMetadata(row), bindings: bindings.map((item) => bindingItem(item)) };
  });

  app.post("/api/mcp/connections/:connection_id/call", async (request) => {
    const user = await currentUser(repo, request, deps);
    const connectionId = param(request, "connection_id");
    const row = await repo.getMcpConnection(connectionId);
    if (row === null || !(await visibleCredential(row, user))) {
      throw new HttpError(404, "connection not found");
    }
    const server = await repo.getMcpServer(String(row.mcp_server_id));
    if (server === null) {
      throw new HttpError(404, "mcp server not found");
    }
    if (!deps.mcp) {
      throw new HttpError(409, "tool calls are unavailable");
    }
    const body = bodyOf(request);
    const tool = String(body.tool ?? "").trim();
    if (!tool) {
      throw new HttpError(422, "tool is required");
    }
    const rawArgs = body.arguments;
    if (rawArgs !== undefined && (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs))) {
      throw new HttpError(422, "arguments must be an object");
    }
    try {
      return await callOwnedConnectionTool({
        repo,
        mcp: deps.mcp,
        connection: row,
        server,
        tool,
        arguments: (rawArgs as Record<string, unknown> | undefined) ?? {},
        ...(deps.masterKey ? { masterKey: deps.masterKey } : {}),
      });
    } catch (error) {
      if (error instanceof OperatorCallError) {
        throw new HttpError(error.status, error.message);
      }
      throw error;
    }
  });

  /** Values for a settings property marked `x-lookup`, searched with the credentials a Connect form holds. */
  app.post("/api/mcp/servers/:server_id/lookup", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const server = await repo.getMcpServer(param(request, "server_id"));
    if (server === null || server.enabled === false || !serverVisible(server, String(org.id))) {
      throw new HttpError(404, "mcp server not found");
    }
    if (!deps.mcp) {
      throw new HttpError(409, "lookups are unavailable");
    }
    const body = bodyOf(request);
    const property = String(body.property ?? "").trim();
    const query = String(body.q ?? "").trim();
    if (!property || !query) {
      throw new HttpError(422, "property and q are required");
    }
    const raw = body.credentials;
    const credentials = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    try {
      return { options: await deps.mcp.lookup(server, property, query, tokenCredentials(server, credentials)) };
    } catch (error) {
      if (error instanceof ConnectError) {
        throw new HttpError(error.status, error.message);
      }
      failure(error, server);
    }
  });

  /** Values for a settings property marked `x-lookup`, searched with a saved login. */
  app.get("/api/mcp/connections/:connection_id/lookup", async (request) => {
    const user = await currentUser(repo, request, deps);
    const connection = await repo.getMcpConnection(param(request, "connection_id"));
    if (connection === null || !(await visibleCredential(connection, user))) {
      throw new HttpError(404, "connection not found");
    }
    const server = await repo.getMcpServer(String(connection.mcp_server_id));
    if (server === null) {
      throw new HttpError(404, "mcp server not found");
    }
    if (!deps.mcp) {
      throw new HttpError(409, "lookups are unavailable");
    }
    const query = queryOf(request);
    const property = (query.property ?? "").trim();
    const q = (query.q ?? "").trim();
    if (!property || !q) {
      throw new HttpError(422, "property and q are required");
    }
    try {
      return { options: await deps.mcp.lookupLogin(repo, connection, server, property, q) };
    } catch (error) {
      failure(error, server);
    }
  });

  /**
   * Stores a login's settings after checking them against the manifest's schema and with the
   * connector's `validate`. A login that waited for its settings connects and lists its tools.
   */
  app.put("/api/mcp/connections/:connection_id/settings", async (request) => {
    const user = await currentUser(repo, request, deps);
    const connection = await repo.getMcpConnection(param(request, "connection_id"));
    if (connection === null || !(await visibleCredential(connection, user))) {
      throw new HttpError(404, "connection not found");
    }
    if (connection.owner_scope === "platform") {
      throw new HttpError(400, "platform-owned credentials cannot be changed here");
    }
    const server = await repo.getMcpServer(String(connection.mcp_server_id));
    if (server === null) {
      throw new HttpError(404, "mcp server not found");
    }
    const schema = installedConnectors().forServer(server)?.manifest.settings_schema;
    if (!schema) {
      throw new HttpError(422, "this connector has no settings");
    }
    if (connection.status !== "connected" && !awaitingSettings(connection)) {
      throw new HttpError(409, "sign in before saving settings");
    }
    if (!deps.mcp) {
      throw new HttpError(409, "settings are unavailable");
    }
    let settings: Record<string, unknown>;
    try {
      settings = validateSettings(schema, bodyOf(request).settings ?? null);
    } catch (error) {
      if (error instanceof SettingsError) {
        throw new HttpError(422, error.message);
      }
      throw error;
    }
    let hint = "";
    try {
      hint = await deps.mcp.validateLogin(repo, connection, server, settings);
    } catch (error) {
      failure(error, server);
    }
    const connects = awaitingSettings(connection) && settingsComplete(schema, settings);
    const row = await repo.updateMcpConnectionSettings(String(connection.id), settings, new Date(), {
        connect: connects,
        accountHint: hint,
      });
    if (row === null) {
      throw new HttpError(404, "connection not found");
    }
    deps.mcp.forget(String(row.id));
    if (row.status === "connected") {
      try {
        await deps.mcp.syncTools(repo, row, server, { force: true, validate: false });
      } catch {
        // The settings stand; the login's tools list on the next sync.
      }
    }
    return connectionMetadata(row);
  });

  app.delete("/api/mcp/connections/:connection_id", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const connectionId = param(request, "connection_id");
    const existing = await repo.getMcpConnection(connectionId);
    if (existing === null || !(await visibleCredential(existing, user))) {
      throw new HttpError(404, "connection not found");
    }
    if (existing.owner_scope === "platform") {
      throw new HttpError(400, "platform-owned credentials cannot be changed here");
    }
    const row = await repo.deleteMcpConnection(connectionId);
    if (row === null) {
      throw new HttpError(404, "connection not found");
    }
    deps.mcp?.forget(connectionId);
    await send(reply, 204);
  });
}
