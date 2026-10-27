import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  loadOperatorActor,
  listFileChanges,
} from "../artifacts/index.js";
import { requireVisibleGuild } from "../guilds/access.js";
import { requireVisibleAgent } from "../agents/access.js";
import {
  maxWorkspaceMibOf,
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
  type OwnerScope,
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
import { userActor } from "../lib/change-actor.js";
import { newId } from "../lib/ids.js";
import { awaitingSettings, markDisconnected, mcpDatabase } from "../mcp/index.js";
import {
  connect,
  connectDatabase,
  ConnectError,
  connectFailure,
  tokenCredentials,
} from "../connectors/connect.js";
import { settingsComplete, SettingsError, validateSettings } from "../connectors/settings.js";
import type { Manifest } from "../connectors/manifest.js";
import { DESCRIPTION_MAX } from "../mcp/catalog.js";
import { installedConnectors } from "../connectors/index.js";
import { logoPath } from "../connectors/view.js";
import { callOwnedConnectionTool, OperatorCallError } from "../mcp/operator-call.js";
import {
  accountHint,
  authorizationUrl,
  ensureClient,
  exchangeCode,
  githubInstallationPickerHtml,
  isGithubApp,
  newState,
  oauthCallbackHtml,
  oauthCallbackUrl,
  oauthDatabase,
  OAuthError,
  OAuthUnsupportedError,
  pendingOauth,
  pendingOauthPayload,
  pendingReplaces,
  pkcePair,
  startsBrowserOauth,
  tokenPayload,
} from "../oauth/index.js";
import {
  BindingError,
  validateBinding,
  validateCatalog,
  validateScope,
} from "../access/index.js";
import {
  canSeeGuild,
} from "../guilds/validation.js";
import { NotesError } from "../notes/store.js";
import { installedIntegrations, integrationStatuses } from "../instance/integrations.js";
import { registerAdminInstanceRoutes } from "./admin-instance-routes.js";
import { Notifications, notificationsDatabase } from "../notifications/index.js";
import { usageFields } from "../usage.js";
import { usageForOrg } from "./usage-view.js";
import { registerStudioRoutes } from "./studio-routes.js";
import { registerFileRoutes } from "./file-routes.js";
import { publishGroup } from "./publish.js";
import { memoryHistory } from "../memory/history.js";
import { SecretNameTaken } from "../db/errors.js";
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
import type { AppDeps } from "./deps.js";
import { loadAccessView } from "../access/view.js";
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
  readHostFile,
  removeRecord,
  requireArtifacts,
  updateCollection,
  updateRecord,
  writeHostFile,
} from "./artifact-notes.js";
import { registerCodingRoutes } from "./coding-routes.js";
import { registerMeRoutes } from "./me-routes.js";
import { registerAgentRoutes } from "./agent-routes.js";
import { registerGroupChatRoutes } from "./group-chat-routes.js";
import { registerGuildRoutes } from "./guild-routes.js";
import { registerIssueRoutes } from "./issue-routes.js";
import { registerNotificationRoutes } from "./notification-routes.js";
import { registerOrgRoutes } from "./org-routes.js";
import { registerRunRoutes } from "./run-routes.js";
import { registerSandboxRoutes } from "./sandbox-routes.js";
import { registerScheduleRoutes } from "./schedule-routes.js";
import { registerScriptRoutes } from "./script-routes.js";
import { registerUserRoutes } from "./user-routes.js";
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
import { registerMachineRoutes } from "./machine-routes.js";
import { registerBuilderCapabilityRoutes } from "./builder-capability-routes.js";
import { registerBuilderSessionRoutes } from "./builder-routes.js";
import { registerRecipeRoutes } from "./recipe-routes.js";
import { cookieSecure, requestCookies } from "./cookies.js";
import { currentOrg, currentUser, identityDatabase } from "./identity.js";
import { isInstanceAdmin } from "./instance-admin.js";
import { agentConfigObject } from "../agents/view.js";
import { bodyOf, filePathParam, param, queryOf } from "./request.js";
import {
  getMembership,
} from "../db/orgs.js";
import {
  getGuild,
  listGuildsForUser,
} from "../db/guilds.js";
import { getAgent, listAgents } from "../db/agents.js";
import { getUsage } from "../db/usage.js";
import {
  bindMcpConnection,
  connectMcp,
  deleteMcpConnection,
  getMcpConnection,
  getMcpConnectionByOauthState,
  getMcpConnectionForOwner,
  getPendingGithubConnectionForUser,
  isListedMcpTool,
  listMcpConnections,
  saveMcpConnection,
  updateMcpConnectionSettings,
} from "../db/mcp.js";
import { getMcpServer, listMcpServers, updateConnector } from "../db/connectors.js";
import {
  deleteSecret,
  getSecret,
  insertSecret,
  listAgentIdsReached,
  listSecrets,
  secretGrantTargets,
  setSecretAccess,
  updateSecret,
} from "../db/secrets.js";
import {
  deleteBinding,
  getBinding,
  listBindingsForConnection,
  upsertBinding,
  upsertPlatformBinding,
} from "../db/bindings.js";

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

function attachmentsOf(deps: AppDeps) {
  if (!deps.attachments) {
    throw new HttpError(503, "attachments are not configured");
  }
  return deps.attachments;
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

async function send(reply: FastifyReply, status: number, payload?: unknown): Promise<FastifyReply> {
  if (status === 204) {
    return reply.code(204).send();
  }
  return reply.code(status).send(payload);
}

async function scopeGuild(
  db: AppDeps["db"],
  scope: string,
  scopeId: string | null,
  user: Record<string, unknown>,
): Promise<string | null> {
  if (scope === "platform") {
    throw new HttpError(400, "platform bindings cannot be changed here");
  }
  if (scope === "org") {
    const membership = await getMembership(db, scopeId || "", String(user.id));
    if (membership === null) {
      throw new HttpError(404, "organisation not found");
    }
    return null;
  }
  if (scope === "guild") {
    const row = await requireVisibleGuild(db, scopeId || "", String(user.id));
    return String(row.id);
  }
  const row = await requireVisibleAgent(db, scopeId || "", String(user.id));
  return String(row.guild_id);
}

export async function registerDomainRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, notes, artifacts } = deps;
  const identityDb = identityDatabase(db);
  const notifications = new Notifications(notificationsDatabase(db));

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
  await registerUserRoutes(app, deps);
  await registerOrgRoutes(app, deps);
  await registerGuildRoutes(app, deps);
  await registerGroupChatRoutes(app, deps, notifications);
  await registerNotificationRoutes(app, deps, notifications);
  await registerScheduleRoutes(app, deps);
  await registerScriptRoutes(app, deps);
  await registerIssueRoutes(app, deps);
  await registerAgentRoutes(app, deps);
  await registerRunRoutes(app, deps);
  await registerSandboxRoutes(app, deps);

  /**
   * What this box is: how it identifies a request and which integrations it has, never a key.
   * An instance admin also sees when and by whom each store integration was written.
   */
  app.get("/api/instance", async (request) => {
    const user = await currentUser(identityDb, request, deps);
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
      const user = await currentUser(identityDb, request, deps);
      const org = await currentOrg(identityDb, request, user);
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
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
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

  app.get("/api/guilds/:guild_id/notes", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const row = await requireVisibleGuild(db, param(request, "guild_id"), String(user.id));
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
        await loadOperatorActor(db, user, { orgId: String(row.org_id), guildId: String(row.id) }),
        "guild",
        String(row.id),
      );
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.get("/api/guilds/:guild_id/notes/*", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const row = await requireVisibleGuild(db, param(request, "guild_id"), String(user.id));
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
        await loadOperatorActor(db, user, { orgId: String(row.org_id), guildId: String(row.id) }),
        "guild",
        String(row.id),
        filePath,
      );
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.put("/api/guilds/:guild_id/notes/*", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const row = await requireVisibleGuild(db, param(request, "guild_id"), String(user.id));
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
        await loadOperatorActor(db, user, { orgId: String(row.org_id), guildId: String(row.id) }),
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
    const user = await currentUser(identityDb, request, deps);
    const row = await requireVisibleGuild(db, param(request, "guild_id"), String(user.id));
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
        await loadOperatorActor(db, user, { orgId: String(row.org_id), guildId: String(row.id) }),
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
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    if (!artifacts) {
      return [];
    }
    try {
      return await listHostFiles(artifacts, await loadOperatorActor(db, user, { orgId: String(org.id) }), "org", String(org.id));
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.get("/api/file-changes", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const displayPath = String(
      (request.query as { display_path?: unknown }).display_path ?? "",
    ).trim();
    if (!displayPath) {
      throw new HttpError(422, "display_path is required");
    }
    const store = requireArtifacts(artifacts);
    const actor = await loadOperatorActor(db, user, { orgId: String(org.id) });
    if (!(await store.canReadDisplayPath(actor, displayPath))) {
      return [];
    }
    return listFileChanges(db, String(org.id), displayPath);
  });

  // Newest change per display path. `display_paths` is comma-separated in
  // the query, or a JSON array in a POST body when the list is long.
  app.get("/api/file-changes/latest", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const raw = String((request.query as { display_paths?: unknown }).display_paths ?? "");
    const paths = raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const store = requireArtifacts(artifacts);
    return latestFileChanges(store, db, await loadOperatorActor(db, user, { orgId: String(org.id) }), paths);
  });

  app.post("/api/file-changes/latest", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const body = bodyOf(request);
    const paths = Array.isArray(body.display_paths)
      ? body.display_paths.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [];
    const store = requireArtifacts(artifacts);
    return latestFileChanges(store, db, await loadOperatorActor(db, user, { orgId: String(org.id) }), paths);
  });

  app.get("/api/org/notes/*", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const filePath = filePathParam(request);
    if (!artifacts) {
      throw new HttpError(404, "artifact not found");
    }
    try {
      return await readHostFile(artifacts, await loadOperatorActor(db, user, { orgId: String(org.id) }), "org", String(org.id), filePath);
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.put("/api/org/notes/*", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const filePath = filePathParam(request);
    const body = bodyOf(request);
    if (!artifacts) {
      throw new HttpError(422, "artifact store is not available");
    }
    try {
      return await writeHostFile(
        artifacts,
        await loadOperatorActor(db, user, { orgId: String(org.id) }),
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
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const filePath = filePathParam(request);
    if (!artifacts) {
      throw new HttpError(422, "artifact store is not available");
    }
    try {
      await deleteHostFile(artifacts, await loadOperatorActor(db, user, { orgId: String(org.id) }), "org", String(org.id), filePath);
      await send(reply, 204);
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.get("/api/org/embeddable-notes", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const displayPath = String((request.query as { display_path?: string }).display_path ?? "").trim();
    if (!artifacts) {
      if (displayPath) {
        throw new HttpError(404, "note not found");
      }
      return [];
    }
    const actor = await loadOperatorActor(db, user, { orgId: String(org.id) });
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
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      return await listCollections(store, await loadOperatorActor(db, user, { orgId: String(org.id) }));
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.post("/api/collections", async (request, reply) => {
    const store = requireArtifacts(artifacts);
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const missing = missingBodyFields(request.body, ["name", "purpose"]);
    if (missing) {
      throw missing;
    }
    try {
      const created = await createCollection(store, await loadOperatorActor(db, user, { orgId: String(org.id) }), bodyOf(request));
      return await send(reply, 201, created);
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.get("/api/collections/:collection_id", async (request) => {
    const store = requireArtifacts(artifacts);
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      return await getCollection(store, await loadOperatorActor(db, user, { orgId: String(org.id) }), param(request, "collection_id"));
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.patch("/api/collections/:collection_id", async (request) => {
    const store = requireArtifacts(artifacts);
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      return await updateCollection(store, await loadOperatorActor(db, user, { orgId: String(org.id) }), param(request, "collection_id"), bodyOf(request));
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.delete("/api/collections/:collection_id", async (request, reply) => {
    const store = requireArtifacts(artifacts);
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      await deleteCollection(store, await loadOperatorActor(db, user, { orgId: String(org.id) }), param(request, "collection_id"));
      await send(reply, 204);
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.get("/api/collections/:collection_id/export", async (request, reply) => {
    const store = requireArtifacts(artifacts);
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const exported = await exportCollection(store, await loadOperatorActor(db, user, { orgId: String(org.id) }), param(request, "collection_id"));
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
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      return await listRecords(store, await loadOperatorActor(db, user, { orgId: String(org.id) }), param(request, "collection_id"), queryOf(request));
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.post("/api/collections/:collection_id/records", async (request, reply) => {
    const store = requireArtifacts(artifacts);
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const missing = missingBodyFields(request.body, ["body"]);
    if (missing) {
      throw missing;
    }
    try {
      const added = await addRecord(store, await loadOperatorActor(db, user, { orgId: String(org.id) }), param(request, "collection_id"), bodyOf(request).body);
      return await send(reply, 201, added);
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.delete("/api/collections/:collection_id/records", async (request, reply) => {
    const store = requireArtifacts(artifacts);
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      await clearRecords(store, await loadOperatorActor(db, user, { orgId: String(org.id) }), param(request, "collection_id"));
      await send(reply, 204);
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.get("/api/collections/:collection_id/records/:record_id", async (request) => {
    const store = requireArtifacts(artifacts);
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      return await getRecord(store, await loadOperatorActor(db, user, { orgId: String(org.id) }), param(request, "collection_id"), param(request, "record_id"));
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.patch("/api/collections/:collection_id/records/:record_id", async (request) => {
    const store = requireArtifacts(artifacts);
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const missing = missingBodyFields(request.body, ["body"]);
    if (missing) {
      throw missing;
    }
    try {
      return await updateRecord(
        store,
        await loadOperatorActor(db, user, { orgId: String(org.id) }),
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
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      await removeRecord(store, await loadOperatorActor(db, user, { orgId: String(org.id) }), param(request, "collection_id"), param(request, "record_id"));
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
      const user = await currentUser(identityDb, request, deps);
      const org = await currentOrg(identityDb, request, user);
      try {
        const actor = await loadOperatorActor(db, user, { orgId: String(org.id) });
        return await store.accessList(actor, { kind: target.kind, id: param(request, target.param) });
      } catch (error) {
        catchArtifact(error);
      }
    });

    app.put(target.path, async (request) => {
      const store = requireArtifacts(artifacts);
      const user = await currentUser(identityDb, request, deps);
      const org = await currentOrg(identityDb, request, user);
      const missing = missingBodyFields(request.body, ["subjects"]);
      if (missing) {
        throw missing;
      }
      try {
        const actor = await loadOperatorActor(db, user, { orgId: String(org.id) });
        return await store.replaceAccess(actor, { kind: target.kind, id: param(request, target.param) }, bodyOf(request).subjects);
      } catch (error) {
        catchArtifact(error);
      }
    });
  }

  app.get("/api/guilds/:guild_id/reach", async (request) => {
    const store = requireArtifacts(artifacts);
    const user = await currentUser(identityDb, request, deps);
    const row = await requireVisibleGuild(db, param(request, "guild_id"), String(user.id));
    try {
      const actor = await loadOperatorActor(db, user, { orgId: String(row.org_id) });
      return await store.reachOf(actor, { type: "guild", id: String(row.id), guildId: String(row.id) });
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.get("/api/agents/:agent_id/reach", async (request) => {
    const store = requireArtifacts(artifacts);
    const user = await currentUser(identityDb, request, deps);
    const row = await requireVisibleAgent(db, param(request, "agent_id"), String(user.id));
    try {
      const actor = await loadOperatorActor(db, user, { orgId: String(row.org_id) });
      return await store.reachOf(actor, { type: "agent", id: String(row.id), guildId: String(row.guild_id) });
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.get("/api/agents/:agent_id/notes", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const row = await requireVisibleAgent(db, param(request, "agent_id"), String(user.id));
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
      const actor = await loadOperatorActor(db, user, {
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
    const user = await currentUser(identityDb, request, deps);
    const row = await requireVisibleAgent(db, param(request, "agent_id"), String(user.id));
    try {
      const store = requireArtifacts(artifacts);
      const actor = await loadOperatorActor(db, user, {
        orgId: String(row.org_id),
        guildId: String(row.guild_id),
        agentId: String(row.id),
      });
      await ensureAgentArtifacts(store, actor, {
        id: row.id,
        guild_id: row.guild_id,
        org_id: row.org_id,
      });
      return await memoryHistory({ artifacts: store, db }, actor, { id: String(row.id), name: String(row.name) });
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.get("/api/agents/:agent_id/notes/*", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const row = await requireVisibleAgent(db, param(request, "agent_id"), String(user.id));
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
      const actor = await loadOperatorActor(db, user, {
        orgId: String(row.org_id),
        guildId: String(row.guild_id),
        agentId: String(row.id),
      });
      await ensureAgentArtifacts(artifacts, actor, {
        id: row.id,
        guild_id: row.guild_id,
        org_id: row.org_id,
      });
      return await readHostFile(artifacts, actor, "agent", String(row.id), filePath, db);
    } catch (error) {
      catchArtifact(error);
    }
  });

  app.put("/api/agents/:agent_id/notes/*", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const row = await requireVisibleAgent(db, param(request, "agent_id"), String(user.id));
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
      const actor = await loadOperatorActor(db, user, {
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
        db,
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
    const user = await currentUser(identityDb, request, deps);
    const row = await requireVisibleAgent(db, param(request, "agent_id"), String(user.id));
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
        await loadOperatorActor(db, user, { orgId: String(row.org_id), guildId: String(row.guild_id), agentId: String(row.id) }),
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
  app.get("/api/usage", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    return { organisation: await usageForOrg(deps, org, String(user.id)) };
  });

  app.get("/api/guilds/:guild_id/usage", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), String(user.id));
    const agents = await listAgents(db, String(guild.id));
    return {
      id: guild.id,
      name: guild.name,
      ...usageFields(await getUsage(db, "guild", String(guild.id))),
      agents: await Promise.all(
        agents.map(async (agent) => ({
          id: agent.id,
          name: agent.name,
          avatar_shape: agent.avatar_shape || "teardrop",
          avatar_color: agent.avatar_color || "#7c5cff",
          ...usageFields(await getUsage(db, "agent", String(agent.id))),
        })),
      ),
    };
  });

  app.get("/api/agents/:agent_id/usage", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const agent = await requireVisibleAgent(db, param(request, "agent_id"), String(user.id));
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
      ...usageFields(await getUsage(db, "agent", String(agent.id))),
    };
  });

  app.get("/api/platform", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    if (!(await isInstanceAdmin(deps, String(user.id)))) {
      throw new HttpError(404, "Not Found");
    }
    return loadAccessView(mcpDatabase(db), { viewScope: "platform", mcp: deps.mcp ?? null });
  });

  app.get("/api/access", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    return loadAccessView(mcpDatabase(db), { orgId: String(org.id), viewScope: "org", mcp: deps.mcp ?? null });
  });

  app.get("/api/guilds/:guild_id/access", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), String(user.id));
    return loadAccessView(mcpDatabase(db), {
      orgId: String(guild.org_id),
      guildId: String(guild.id),
      viewScope: "guild",
      mcp: deps.mcp ?? null,
    });
  });

  app.get("/api/agents/:agent_id/access", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const row = await requireVisibleAgent(db, param(request, "agent_id"), String(user.id));
    return loadAccessView(mcpDatabase(db), {
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
      const membership = await getMembership(db, String(ownerId || ""), String(user.id));
      return membership !== null;
    }
    if (ownerScope === "guild") {
      const guild = await getGuild(db, String(ownerId || ""));
      if (guild === null || !canSeeGuild(guild, String(user.id))) {
        return false;
      }
      const membership = await getMembership(db, String(guild.org_id), String(user.id));
      return membership !== null;
    }
    const agent = await getAgent(db, String(ownerId || ""));
    if (agent === null) {
      return false;
    }
    const membership = await getMembership(db, String(agent.org_id), String(user.id));
    if (membership === null) {
      return false;
    }
    const guild = await getGuild(db, String(agent.guild_id));
    return guild !== null && canSeeGuild(guild, String(user.id));
  }

  /** The organisation a login's owner belongs to; null for the platform. */
  async function ownerOrgId(ownerScope: string, ownerId: string | null): Promise<string | null> {
    if (ownerScope === "org") {
      return ownerId;
    }
    if (ownerScope === "guild") {
      const guild = await getGuild(db, ownerId ?? "");
      return guild === null ? null : String(guild.org_id);
    }
    if (ownerScope === "agent") {
      const agent = await getAgent(db, ownerId ?? "");
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
      const membership = await getMembership(db, ownerId || "", String(user.id));
      if (membership === null) {
        throw new HttpError(404, "organisation not found");
      }
      return null;
    }
    if (ownerScope === "guild") {
      const row = await requireVisibleGuild(db, ownerId || "", String(user.id));
      return String(row.id);
    }
    const row = await requireVisibleAgent(db, ownerId || "", String(user.id));
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
      await markDisconnected(mcpDatabase(db), row);
    } else {
      await deleteMcpConnection(db, String(row.id));
    }
    deps.mcp?.forget(String(row.id));
  }

  async function abandonOauthAttempt(state: string | undefined): Promise<void> {
    if (!state) {
      return;
    }
    const row = await getMcpConnectionByOauthState(db, state);
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
    const connected = await saveMcpConnection(db,
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
      await bindMcpConnection(db,
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
        await deps.mcp?.syncTools(mcpDatabase(db), connected, server, { force: true });
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
      const info = await deps.mcp.describeEndpoint(mcpDatabase(db), connection, server);
      const next: Manifest = {
        ...manifest,
        ...(blankName && info.name ? { display_name: info.name.slice(0, 120) } : {}),
        ...(blankDescription && info.instructions ? { description: info.instructions.slice(0, DESCRIPTION_MAX) } : {}),
      };
      if (next.display_name !== manifest.display_name || next.description !== manifest.description) {
        await updateConnector(db, String(server.id), { manifest: next }, new Date());
      }
    } catch {
      // The server keeps the name and description it was added with.
    }
  }

  /** Stores a signed-in login that still needs its settings: pending, bound, with no sign-in under way. */
  async function awaitSettings(row: Record<string, unknown>, stored: Record<string, unknown>, now: Date): Promise<void> {
    const [ciphertext, nonce] = encrypt(stored);
    const saved = await saveMcpConnection(db,
      String(row.id),
      { ciphertext, nonce, status: "pending", accountHint: accountHint(stored), oauthState: null },
      now,
    );
    if (saved !== null) {
      await bindMcpConnection(db,
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
    const connected = await saveMcpConnection(db,
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
    await bindMcpConnection(db,
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
      await saveMcpConnection(db,
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
    await saveMcpConnection(db,
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
      const row = await getMcpConnectionByOauthState(db, state);
      if (row !== null) {
        return row;
      }
    }
    if (!githubCallback) {
      return null;
    }
    try {
      const user = await currentUser(identityDb, request, deps);
      return await getPendingGithubConnectionForUser(db, String(user.id), GITHUB_SERVER_ID);
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
    const row = await getMcpConnectionByOauthState(db, state);
    if (row === null || row.status !== "pending") {
      return null;
    }
    const server = await getMcpServer(db, String(row.mcp_server_id));
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
    const membership = await getMembership(db, orgId, String(user.id));
    if (membership === null) {
      return null;
    }
    const guilds = await listGuildsForUser(db, orgId, String(user.id));
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
    const row = await getSecret(db, secretId);
    const viewer = row === null ? null : await secretViewer(String(row.org_id), user);
    if (row === null || viewer === null) {
      throw new HttpError(404, "secret not found");
    }
    return [row, viewer];
  }

  /** Each granted agent's guild; refuses a guild or agent outside the organisation. */
  async function grantTargets(orgId: string, access: SecretAccess): Promise<Map<string, string>> {
    const found = await secretGrantTargets(db, orgId, access.guild_ids, access.agent_ids);
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
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const orgId = String(org.id);
    const query = request.query as { guild_id?: string; agent_id?: string };
    if (query.guild_id && String((await requireVisibleGuild(db, query.guild_id, String(user.id))).org_id) !== orgId) {
      throw new HttpError(404, "guild not found");
    }
    if (query.agent_id && String((await requireVisibleAgent(db, query.agent_id, String(user.id))).org_id) !== orgId) {
      throw new HttpError(404, "agent not found");
    }
    const viewer = await secretViewer(orgId, user);
    if (viewer === null) {
      throw new HttpError(404, "organisation not found");
    }
    const rows = await listSecrets(db, orgId, {
      guildId: query.guild_id ?? null,
      agentId: query.agent_id ?? null,
    });
    return { secrets: rows.map((row) => secretMetadata(row, viewer)) };
  });

  app.post("/api/secrets", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
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
      const row = await insertSecret(db,
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
      await deps.generation?.secretAccessChanged(await listAgentIdsReached(db, orgId, access));
      await send(reply, 201, secretMetadata(row, viewer));
    } catch (error) {
      throw secretHttp(error);
    }
  });

  app.get("/api/secrets/:secret_id", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const [row, viewer] = await memberSecret(param(request, "secret_id"), user);
    return secretMetadata(row, viewer);
  });

  app.patch("/api/secrets/:secret_id", async (request) => {
    const user = await currentUser(identityDb, request, deps);
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
      const updated = await updateSecret(db,
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
    const user = await currentUser(identityDb, request, deps);
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
      const before = await listAgentIdsReached(db, orgId, accessOf(row));
      const updated = await setSecretAccess(db, secretId, access, new Date());
      if (updated === null) {
        throw new HttpError(404, "secret not found");
      }
      const after = await listAgentIdsReached(db, orgId, access);
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
    const user = await currentUser(identityDb, request, deps);
    const secretId = param(request, "secret_id");
    const [row, viewer] = await memberSecret(secretId, user);
    if (!canManageSecret(row, viewer)) {
      throw new HttpError(403, "only an org owner or admin can delete this secret");
    }
    const reached = await listAgentIdsReached(db, String(row.org_id), accessOf(row));
    if ((await deleteSecret(db, secretId)) === null) {
      throw new HttpError(404, "secret not found");
    }
    await deps.generation?.secretAccessChanged(reached);
    await send(reply, 204);
  });

  app.put("/api/bindings", async (request) => {
    const user = await currentUser(identityDb, request, deps);
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
      const guildId = await scopeGuild(db, scope, scopeId, user);
      let orgId: string | null = null;
      if (scope === "org") {
        orgId = scopeId;
      } else if (scope === "guild") {
        const guild = await getGuild(db, scopeId || "");
        orgId = guild === null ? null : String(guild.org_id);
      } else if (scope === "agent") {
        const agent = await getAgent(db, scopeId || "");
        orgId = agent === null ? null : String(agent.org_id);
      }
      const replaceConnection = Object.prototype.hasOwnProperty.call(body, "connection_id");
      const connectionId = replaceConnection
        ? body.connection_id === null || body.connection_id === undefined
          ? null
          : String(body.connection_id)
        : null;
      if (catalogKind === "mcp_tool" && !(await isListedMcpTool(db, catalogId, orgId))) {
        throw new HttpError(404, "mcp tool not found");
      }
      let server: Record<string, unknown> | null = null;
      let connection: Record<string, unknown> | null = null;
      if (catalogKind === "mcp") {
        server = await getMcpServer(db, catalogId);
        if (server === null || !serverVisible(server, orgId)) {
          throw new HttpError(404, "mcp server not found");
        }
        if (connectionId !== null) {
          connection = await getMcpConnection(db, connectionId);
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
        const existing = await getBinding(db, { catalogKind, catalogId, scope, scopeId });
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
          ? await upsertPlatformBinding(db,
              {
                bindingId: newId("bind"),
                catalogKind: overlay.catalog_kind,
                catalogId: overlay.catalog_id,
                enabled: overlay.enabled,
                connectionId: writeConnectionId,
              },
              now,
            )
          : await upsertBinding(db,
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
    const user = await currentUser(identityDb, request, deps);
    const query = queryOf(request);
    try {
      const [catalogKind, catalogId] = validateCatalog(query.catalog_kind ?? "", query.catalog_id ?? "");
      const [scope, scopeId] = validateScope(query.scope ?? "", query.scope_id ?? null);
      await scopeGuild(db, scope, scopeId, user);
      const row = await deleteBinding(db,
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
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const rows = await listMcpServers(db, String(org.id));
    return { servers: rows.map((row) => serverItem(row)) };
  });

  app.get("/api/mcp/servers/:server_id/logo", async (request, reply) => {
    await currentUser(identityDb, request, deps);
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
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const query = request.query as { guild_id?: string; agent_id?: string };
    const guildId = query.guild_id;
    const agentId = query.agent_id;
    if (guildId) {
      await requireVisibleGuild(db, guildId, String(user.id));
    }
    if (agentId) {
      await requireVisibleAgent(db, agentId, String(user.id));
    }
    const rows = await listMcpConnections(db, {
      orgId: String(org.id),
      guildId: guildId ?? null,
      agentId: agentId ?? null,
    });
    return { connections: rows.map((row) => connectionMetadata(row)) };
  });

  app.post("/api/mcp/connections", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const missing = missingBodyFields(request.body, ["mcp_server_id", "owner_scope"]);
    if (missing) {
      throw missing;
    }
    const body = bodyOf(request);
    let ownerScope: OwnerScope;
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
    const server = await getMcpServer(db, String(body.mcp_server_id ?? ""));
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
          connectDatabase(db),
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
    const existing = await getMcpConnectionForOwner(db, String(server.id), ownerScope, ownerId);
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
        const [discovery, client] = await ensureClient(oauthDatabase(db), server, redirect);
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
    const row = await connectMcp(db,
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
    const server = await getMcpServer(db, String(row.mcp_server_id));
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
          await saveMcpConnection(db,
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
      const [discovery, client] = await ensureClient(oauthDatabase(db), server, redirectUri);
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
    const user = await currentUser(identityDb, request, deps);
    const connectionId = param(request, "connection_id");
    const row = await getMcpConnection(db, connectionId);
    if (row === null || !(await visibleCredential(row, user))) {
      throw new HttpError(404, "connection not found");
    }
    const bindings = await listBindingsForConnection(db, connectionId);
    return { ...connectionMetadata(row), bindings: bindings.map((item) => bindingItem(item)) };
  });

  app.post("/api/mcp/connections/:connection_id/call", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const connectionId = param(request, "connection_id");
    const row = await getMcpConnection(db, connectionId);
    if (row === null || !(await visibleCredential(row, user))) {
      throw new HttpError(404, "connection not found");
    }
    const server = await getMcpServer(db, String(row.mcp_server_id));
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
        db: mcpDatabase(db),
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
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const server = await getMcpServer(db, param(request, "server_id"));
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
    const user = await currentUser(identityDb, request, deps);
    const connection = await getMcpConnection(db, param(request, "connection_id"));
    if (connection === null || !(await visibleCredential(connection, user))) {
      throw new HttpError(404, "connection not found");
    }
    const server = await getMcpServer(db, String(connection.mcp_server_id));
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
      return { options: await deps.mcp.lookupLogin(mcpDatabase(db), connection, server, property, q) };
    } catch (error) {
      failure(error, server);
    }
  });

  /**
   * Stores a login's settings after checking them against the manifest's schema and with the
   * connector's `validate`. A login that waited for its settings connects and lists its tools.
   */
  app.put("/api/mcp/connections/:connection_id/settings", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const connection = await getMcpConnection(db, param(request, "connection_id"));
    if (connection === null || !(await visibleCredential(connection, user))) {
      throw new HttpError(404, "connection not found");
    }
    if (connection.owner_scope === "platform") {
      throw new HttpError(400, "platform-owned credentials cannot be changed here");
    }
    const server = await getMcpServer(db, String(connection.mcp_server_id));
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
      hint = await deps.mcp.validateLogin(mcpDatabase(db), connection, server, settings);
    } catch (error) {
      failure(error, server);
    }
    const connects = awaitingSettings(connection) && settingsComplete(schema, settings);
    const row = await updateMcpConnectionSettings(db, String(connection.id), settings, new Date(), {
        connect: connects,
        accountHint: hint,
      });
    if (row === null) {
      throw new HttpError(404, "connection not found");
    }
    deps.mcp.forget(String(row.id));
    if (row.status === "connected") {
      try {
        await deps.mcp.syncTools(mcpDatabase(db), row, server, { force: true, validate: false });
      } catch {
        // The settings stand; the login's tools list on the next sync.
      }
    }
    return connectionMetadata(row);
  });

  app.delete("/api/mcp/connections/:connection_id", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const connectionId = param(request, "connection_id");
    const existing = await getMcpConnection(db, connectionId);
    if (existing === null || !(await visibleCredential(existing, user))) {
      throw new HttpError(404, "connection not found");
    }
    if (existing.owner_scope === "platform") {
      throw new HttpError(400, "platform-owned credentials cannot be changed here");
    }
    const row = await deleteMcpConnection(db, connectionId);
    if (row === null) {
      throw new HttpError(404, "connection not found");
    }
    deps.mcp?.forget(connectionId);
    await send(reply, 204);
  });
}
