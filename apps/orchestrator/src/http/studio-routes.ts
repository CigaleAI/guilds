import type { FastifyInstance, FastifyRequest } from "fastify";
import { loadOperatorActor } from "../artifacts/actors.js";
import { ArtifactError } from "../artifacts/errors.js";
import { requireVisibleGuild } from "../guilds/access.js";
import type { AppDeps } from "./deps.js";
import { HttpError } from "./errors.js";
import { currentOrg, currentUser } from "./identity.js";
import { identityDatabase } from "../users/identity.js";
import { pipeSse } from "./sse.js";
import { activityWindow, loadGuildActivity } from "../studio/activity.js";
import { loadGuildTools, loadToolCalls } from "../studio/tool-usage.js";
import { loadGuildReferences } from "../studio/references.js";
import { loadStateHistory, loadStateItem, loadStateList, parseOperation, parseStateKind } from "../studio/state-data.js";
import { LimitError } from "../policy/index.js";
import { StudioError } from "../studio/errors.js";
import { viewDraft } from "../studio/drafts.js";
import type { StudioService } from "../studio/index.js";
import { bodyOf, param, queryOf } from "./request.js";
import { isOrgManager } from "../organisations/service.js";
import { listAgentRoutines, listAgentRunHeaders, readGuildRun, type InspectorServices } from "../studio/inspector.js";
import type { UserRow } from "../db/users.js";
import type { StudioDraftRow, StudioSessionRow } from "../db/studio.js";
import type { OrgMembershipRow } from "../db/orgs.js";


function studioOf(deps: AppDeps): StudioService {
  if (!deps.studio) {
    throw new HttpError(422, "studio is not available");
  }
  return deps.studio;
}

function mapStudioError(error: unknown): never {
  if (error instanceof StudioError) {
    throw new HttpError(error.status, error.message);
  }
  if (error instanceof ArtifactError) {
    throw new HttpError(error.status, error.message);
  }
  if (error instanceof LimitError) {
    throw new HttpError(error.status, error.message);
  }
  throw error;
}

export async function registerStudioRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const identityDb = identityDatabase(db);
  const inspector: InspectorServices = { db, schedules: deps.schedules, generation: deps.generation ?? null };

  app.get("/api/studio/sessions", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    return studioOf(deps).listSessions(org.id, user.id);
  });

  app.post("/api/studio/sessions", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const body = bodyOf(request);
    const temperature = (body.coach_config as Record<string, unknown> | undefined)?.temperature;
    try {
      const parentSessionId = typeof body.parent_session_id === "string" ? body.parent_session_id.trim() : "";
      return await studioOf(deps).createSession({
        user,
        org,
        mode: String(body.mode ?? "optimize"),
        sourceGuildId: String(body.source_guild_id ?? ""),
        model: String((body.coach_config as Record<string, unknown> | undefined)?.model ?? body.model ?? ""),
        ...(typeof temperature === "number" ? { temperature } : {}),
        ...(parentSessionId ? { parentSessionId } : {}),
      });
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const session = await studioOf(deps).getOwnedSession(param(request, "session_id"), user, org);
      return studioOf(deps).viewSession(session);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.post("/api/studio/sessions/:session_id/archive", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.archive(session);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/connections", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return { connections: await studio.listConnections(session) };
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.put("/api/studio/sessions/:session_id/connections/:connection_id", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const body = bodyOf(request);
    try {
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.setConnectionGrant(session, param(request, "connection_id"), body.granted !== false);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.post("/api/studio/sessions/:session_id/logins/:seq", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const body = bodyOf(request);
    if (body.decision !== "grant" && body.decision !== "decline") {
      throw new HttpError(422, "decision must be grant or decline");
    }
    try {
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.resolveLogin(session, user, Number(param(request, "seq")), body.decision);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/edits/:seq", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.getEdit(session, user, Number(param(request, "seq")));
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.post("/api/studio/sessions/:session_id/edits/:seq", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const body = bodyOf(request);
    if (body.decision !== "apply" && body.decision !== "decline") {
      throw new HttpError(422, "decision must be apply or decline");
    }
    try {
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.resolveEdit(session, user, Number(param(request, "seq")), body.decision);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.put("/api/studio/sessions/:session_id/target", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const body = bodyOf(request);
    const agentId = body.agent_id === null || body.agent_id === undefined ? null : String(body.agent_id);
    try {
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.setTarget(session, agentId);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/guilds/:guild_id/inventory", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), user.id);
    const studio: StudioService = studioOf(deps);
    const rows = await studio.guildInventory(String(guild.id));
    return rows.map((row) => studio.inventoryItem(row));
  });

  app.get("/api/studio/sessions/:session_id/inventory", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.inventory(session);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/agents/:agent_id", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.inspector(session, param(request, "agent_id"));
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/messages", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.messages(session);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.post("/api/studio/sessions/:session_id/messages", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const body = bodyOf(request);
    try {
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.postMessage(session, user, String(body.content ?? ""), body.focus);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.post("/api/studio/sessions/:session_id/cancel", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.cancel(session);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.post("/api/studio/sessions/:session_id/continue", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.continueSession(session, user, org);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/stream", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const studio: StudioService = studioOf(deps);
    try {
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      const sessionId = session.id;
      await pipeSse(
        request,
        reply,
        () => studio.subscribe(sessionId),
        (queue) => studio.unsubscribe(sessionId, queue),
      );
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/drafts", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return (await studio.sessionDrafts(session)).map(viewDraft);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/orphan-drafts", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    if (!(await isOrgManager(db, org.id, user.id))) {
      throw new HttpError(403, "forbidden");
    }
    return (await studioOf(deps).orphanDrafts(org.id)).map(viewDraft);
  });

  app.get("/api/studio/drafts/:draft_id", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      return await loadDraft(deps, user, org, param(request, "draft_id"));
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.post("/api/studio/drafts/:draft_id/revise", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const body = bodyOf(request);
    try {
      const loaded = await loadDraftContext(deps, user, org, param(request, "draft_id"));
      return await studioOf(deps).drafts.revise(
        loaded.session,
        user,
        loaded.draft.id,
        String(body.proposed_content ?? ""),
        String(body.expected_head_id ?? loaded.draft.id),
      );
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.post("/api/studio/drafts/:draft_id/publish", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const loaded = await loadDraftContext(deps, user, org, param(request, "draft_id"));
      return await studioOf(deps).publishDraft(loaded.session, loaded.user, loaded.draft.id, {
        orphan: loaded.orphan,
      });
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.post("/api/studio/drafts/:draft_id/discard", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const loaded = await loadDraftContext(deps, user, org, param(request, "draft_id"));
      if (loaded.orphan) {
        throw new HttpError(403, "orphan recovery cannot discard");
      }
      return await studioOf(deps).drafts.discard(loaded.session, loaded.user, loaded.draft.id);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/agents/:agent_id/runs", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      studio.assertLive(session);
      const agent = await studio.requireGuildAgent(session, param(request, "agent_id"));
      const query = queryOf(request);
      return await listAgentRunHeaders(inspector, String(agent.id), {
        taskPromptHash: query.task_prompt_hash ?? "",
        scheduleId: query.schedule_id ?? "",
        kind: query.kind ?? "",
        limit: query.limit,
      });
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/activity", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      studio.assertLive(session);
      const now = new Date();
      const window = activityWindow(request.query as { hours?: unknown; until?: unknown }, now);
      return await loadGuildActivity(db, session.source_guild_id, {
        ...window,
        now,
        generating: (runId) => (deps.generation ? deps.generation.isGenerating(runId) : false),
      });
    } catch (error) {
      mapStudioError(error);
    }
  });

  // The State list reads with the operator's own permissions, so it lists
  // only what the viewer can open.
  const stateScope = async (request: FastifyRequest) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const studio: StudioService = studioOf(deps);
    const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
    studio.assertLive(session);
    const guildId = session.source_guild_id;
    const actor = await loadOperatorActor(db, user, { orgId: session.org_id, guildId });
    return { actor, guildId, deps: { db, artifacts: studio.deps.artifacts } };
  };

  app.get("/api/studio/sessions/:session_id/state", async (request) => {
    const query = request.query as { hours?: unknown; agent?: unknown; kind?: unknown };
    try {
      const { deps: stateDeps, ...scope } = await stateScope(request);
      return await loadStateList(
        stateDeps,
        { ...scope, window: activityWindow({ hours: query.hours }, new Date()) },
        {
          kind: parseStateKind(query.kind),
          agentId: typeof query.agent === "string" && query.agent ? query.agent : null,
        },
      );
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/state/item", async (request) => {
    const query = request.query as { path?: unknown; hours?: unknown; op?: unknown; cursor?: unknown };
    const path = typeof query.path === "string" ? query.path : "";
    try {
      const { deps: stateDeps, ...scope } = await stateScope(request);
      const numbers = await loadStateItem(stateDeps, { ...scope, window: activityWindow({ hours: query.hours }, new Date()) }, path);
      const history = await loadStateHistory(stateDeps, scope, {
        path,
        op: parseOperation(query.op),
        cursor: typeof query.cursor === "string" && query.cursor ? query.cursor : null,
      });
      return { ...numbers, ...history };
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/tools", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      studio.assertLive(session);
      const window = activityWindow(request.query as { hours?: unknown }, new Date());
      return await loadGuildTools({ db, preview: studio.previewDeps() }, session.source_guild_id, window);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/tools/:name/calls", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const query = request.query as { hours?: unknown; errors?: unknown; cursor?: unknown };
    try {
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      studio.assertLive(session);
      return await loadToolCalls(db, session.source_guild_id, {
        tool: param(request, "name"),
        window: activityWindow({ hours: query.hours }, new Date()),
        query: {
          errorsOnly: query.errors === "true" || query.errors === "1",
          cursor: typeof query.cursor === "string" && query.cursor ? query.cursor : null,
        },
      });
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/references", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      studio.assertLive(session);
      const guildId = session.source_guild_id;
      const actor = await loadOperatorActor(db, user, { orgId: session.org_id, guildId });
      return await loadGuildReferences({ db, artifacts: studio.deps.artifacts }, actor, guildId);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/runs/:run_id", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      studio.assertLive(session);
      return await readGuildRun(inspector, session.source_guild_id, param(request, "run_id"));
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/agents/:agent_id/routines", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      studio.assertLive(session);
      const agent = await studio.requireGuildAgent(session, param(request, "agent_id"));
      return await listAgentRoutines(inspector, String(agent.id));
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/agents/:agent_id/memory-timeline", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    try {
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.memoryTimeline(session, user, param(request, "agent_id"));
    } catch (error) {
      mapStudioError(error);
    }
  });
}

async function loadDraft(
  deps: AppDeps,
  user: UserRow,
  org: OrgMembershipRow,
  draftId: string,
): Promise<Record<string, unknown>> {
  const loaded = await loadDraftContext(deps, user, org, draftId);
  return viewDraft(loaded.draft);
}

async function loadDraftContext(
  deps: AppDeps,
  user: UserRow,
  org: OrgMembershipRow,
  draftId: string,
): Promise<{ session: StudioSessionRow; draft: StudioDraftRow; user: UserRow; orphan: boolean }> {
  const studio: StudioService = studioOf(deps);
  const found = await studio.orgDraft(org.id, draftId);
  if (!found) {
    throw new HttpError(404, "draft not found");
  }
  const { draft, session } = found;
  if (!session) {
    throw new HttpError(404, "studio session not found");
  }
  if (session.created_by_user_id && session.created_by_user_id === user.id) {
    return { session, draft, user, orphan: false };
  }
  if (!session.created_by_user_id) {
    if (await isOrgManager(deps.db, org.id, user.id)) {
      return { session, draft, user, orphan: true };
    }
  }
  throw new HttpError(404, "draft not found");
}
