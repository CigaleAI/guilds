import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { canManageSettings } from "../organisations/index.js";
import { ArtifactError, collectTaskEmbeds } from "../artifacts/index.js";
import { jsonObj } from "../db/json.js";
import { iso } from "../db/views.js";
import type { AppDeps } from "./deps.js";
import { HttpError } from "./errors.js";
import { currentOrg, currentUser } from "./identity.js";
import { ownedGuild } from "./items.js";
import { frameSse, SSE_HEADERS } from "./sse.js";
import { activityWindow, loadGuildActivity } from "../studio/activity.js";
import { loadGuildReferences } from "../studio/references.js";
import { operatorFor } from "./artifact-files.js";
import { LimitError } from "../policy/index.js";
import { StudioError } from "../studio/errors.js";
import { viewDraft } from "../studio/drafts.js";
import type { StudioService } from "../studio/index.js";
import { bodyOf, param } from "./request.js";


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
  const { repo } = deps;

  app.get("/api/studio/sessions", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    return studioOf(deps).listSessions(String(org.id), String(user.id));
  });

  app.post("/api/studio/sessions", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
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
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const session = await studioOf(deps).getOwnedSession(param(request, "session_id"), user, org);
      return studioOf(deps).viewSession(session);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.post("/api/studio/sessions/:session_id/archive", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const studio = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.archive(session);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/connections", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const studio = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return { connections: await studio.listConnections(session) };
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.put("/api/studio/sessions/:session_id/connections/:connection_id", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const body = bodyOf(request);
    try {
      const studio = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.setConnectionGrant(session, param(request, "connection_id"), body.granted !== false);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.post("/api/studio/sessions/:session_id/logins/:seq", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const body = bodyOf(request);
    if (body.decision !== "grant" && body.decision !== "decline") {
      throw new HttpError(422, "decision must be grant or decline");
    }
    try {
      const studio = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.resolveLogin(session, user, Number(param(request, "seq")), body.decision);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/edits/:seq", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const studio = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.getEdit(session, user, Number(param(request, "seq")));
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.post("/api/studio/sessions/:session_id/edits/:seq", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const body = bodyOf(request);
    if (body.decision !== "apply" && body.decision !== "decline") {
      throw new HttpError(422, "decision must be apply or decline");
    }
    try {
      const studio = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.resolveEdit(session, user, Number(param(request, "seq")), body.decision);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.put("/api/studio/sessions/:session_id/target", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const body = bodyOf(request);
    const agentId = body.agent_id === null || body.agent_id === undefined ? null : String(body.agent_id);
    try {
      const studio = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.setTarget(session, agentId);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/guilds/:guild_id/inventory", async (request) => {
    const user = await currentUser(repo, request, deps);
    const guild = await ownedGuild(repo, param(request, "guild_id"), user);
    const studio = studioOf(deps);
    const rows = await studio.store.inventory(String(guild.id), null);
    return rows.map((row) => studio.inventoryItem(row));
  });

  app.get("/api/studio/sessions/:session_id/inventory", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const studio = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.inventory(session);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/agents/:agent_id", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const studio = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.inspector(session, user, param(request, "agent_id"));
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/messages", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const studio = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.store.listMessages(String(session.id));
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.post("/api/studio/sessions/:session_id/messages", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const body = bodyOf(request);
    try {
      const studio = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.postMessage(session, user, String(body.content ?? ""), body.focus);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.post("/api/studio/sessions/:session_id/cancel", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const studio = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.cancel(session);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.post("/api/studio/sessions/:session_id/continue", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const studio = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.continueSession(session, user, org);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/stream", async (request, reply) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const studio = studioOf(deps);
    try {
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      await pipeStudioSse(request, reply, studio, String(session.id));
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/drafts", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const studio = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return (await studio.store.listDrafts(String(session.id))).map(viewDraft);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/orphan-drafts", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const membership = await repo.getMembership(String(org.id), String(user.id));
    if (!membership || !canManageSettings(String(membership.role))) {
      throw new HttpError(403, "forbidden");
    }
    return (await studioOf(deps).store.listOrphanDrafts(String(org.id))).map(viewDraft);
  });

  app.get("/api/studio/drafts/:draft_id", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      return await loadDraft(deps, user, org, param(request, "draft_id"));
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.post("/api/studio/drafts/:draft_id/revise", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    const body = bodyOf(request);
    try {
      const loaded = await loadDraftContext(deps, user, org, param(request, "draft_id"));
      return await studioOf(deps).drafts.revise(
        loaded.session,
        user,
        String(loaded.draft.id),
        String(body.proposed_content ?? ""),
        String(body.expected_head_id ?? loaded.draft.id),
      );
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.post("/api/studio/drafts/:draft_id/publish", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const loaded = await loadDraftContext(deps, user, org, param(request, "draft_id"));
      return await studioOf(deps).publishDraft(loaded.session, loaded.user, String(loaded.draft.id), {
        orphan: loaded.orphan,
      });
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.post("/api/studio/drafts/:draft_id/discard", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const loaded = await loadDraftContext(deps, user, org, param(request, "draft_id"));
      if (loaded.orphan) {
        throw new HttpError(403, "orphan recovery cannot discard");
      }
      return await studioOf(deps).drafts.discard(loaded.session, String(loaded.draft.id));
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/agents/:agent_id/runs", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const studio = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      studio.assertLive(session);
      const agent = await studio.requireGuildAgent(session, param(request, "agent_id"));
      const query = request.query as { task_prompt_hash?: string; schedule_id?: string; kind?: string; limit?: string };
      const hash = String(query.task_prompt_hash ?? "");
      const scheduleId = String(query.schedule_id ?? "");
      const kind = String(query.kind ?? "");
      const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
      const runs = await repo.listRunHeaders(String(agent.id), {
        taskPromptHash: hash,
        scheduleId,
        kind,
        limit,
      });
      return runs.map((row) => studioRunHeader(deps, row));
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/activity", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const studio = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      studio.assertLive(session);
      const now = new Date();
      const window = activityWindow(request.query as { hours?: unknown; until?: unknown }, now);
      return await loadGuildActivity(repo, String(session.source_guild_id), {
        ...window,
        now,
        generating: (runId) => (deps.generation ? deps.generation.generating(runId) : false),
      });
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/references", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const studio = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      studio.assertLive(session);
      const guildId = String(session.source_guild_id);
      const actor = await operatorFor(repo, user, { orgId: String(session.org_id), guildId });
      return await loadGuildReferences({ repo, artifacts: studio.deps.artifacts }, actor, guildId);
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/runs/:run_id", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const studio = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      studio.assertLive(session);
      const run = await repo.getRun(param(request, "run_id"));
      if (!run) throw new HttpError(404, "run not found");
      const agent = await repo.getAgent(String(run.agent_id));
      if (!agent || String(agent.guild_id) !== String(session.source_guild_id)) {
        throw new HttpError(404, "run not found");
      }
      const messages = await repo.listMessages(String(run.id));
      return {
        run: {
          id: run.id,
          agent_id: run.agent_id,
          kind: run.kind,
          status: run.status,
          task_prompt_hash: run.task_prompt_hash,
          metadata: jsonObj(run.metadata),
        },
        messages,
      };
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/agents/:agent_id/routines", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const studio = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      studio.assertLive(session);
      const agent = await studio.requireGuildAgent(session, param(request, "agent_id"));
      const rows = await repo.listSchedules(String(agent.id));
      const byRoutine = await repo.routineRunStats(rows.map((row) => String(row.id)));
      const items = [];
      for (const row of rows) {
        const stats = byRoutine.get(String(row.id));
        items.push({
          ...(await deps.schedules.view(row)),
          run_count: stats?.count ?? 0,
          latest_run: stats?.latest ? studioRunHeader(deps, stats.latest) : null,
        });
      }
      return items;
    } catch (error) {
      mapStudioError(error);
    }
  });

  app.get("/api/studio/sessions/:session_id/agents/:agent_id/memory-timeline", async (request) => {
    const user = await currentUser(repo, request, deps);
    const org = await currentOrg(repo, request, user);
    try {
      const studio = studioOf(deps);
      const session = await studio.getOwnedSession(param(request, "session_id"), user, org);
      return await studio.memoryTimeline(session, user, param(request, "agent_id"));
    } catch (error) {
      mapStudioError(error);
    }
  });
}

// The run facts the inspector lists without loading a transcript.
function studioRunHeader(deps: AppDeps, row: Record<string, unknown>): Record<string, unknown> {
  const metadata = (jsonObj(row.metadata) as Record<string, unknown> | null) ?? {};
  const errors = jsonObj(row.errors);
  const errorList = Array.isArray(errors) ? (errors as Array<Record<string, unknown>>) : [];
  const last = errorList[errorList.length - 1];
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    generating: deps.generation ? deps.generation.generating(String(row.id)) : false,
    task_prompt_hash: row.task_prompt_hash,
    system_prompt_hash: row.system_prompt_hash,
    memory_prompt_hash: row.memory_prompt_hash,
    schedule_id: row.schedule_id ?? null,
    instruction_hash: typeof metadata.instruction_hash === "string" ? metadata.instruction_hash : null,
    group_chat_through_seq: row.group_chat_through_seq ?? null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    error_count: errorList.length,
    last_error: last ? { operation: last.operation ?? null, message: last.message ?? null } : null,
  };
}

async function loadDraft(
  deps: AppDeps,
  user: Record<string, unknown>,
  org: Record<string, unknown>,
  draftId: string,
): Promise<Record<string, unknown>> {
  const loaded = await loadDraftContext(deps, user, org, draftId);
  return viewDraft(loaded.draft);
}

async function loadDraftContext(
  deps: AppDeps,
  user: Record<string, unknown>,
  org: Record<string, unknown>,
  draftId: string,
): Promise<{ session: Record<string, unknown>; draft: Record<string, unknown>; user: Record<string, unknown>; orphan: boolean }> {
  const studio = studioOf(deps);
  const draft = await studio.store.getDraft(draftId);
  if (!draft || String(draft.org_id) !== String(org.id)) {
    throw new HttpError(404, "draft not found");
  }
  const session = await studio.store.getSession(String(draft.session_id));
  if (!session) {
    throw new HttpError(404, "studio session not found");
  }
  if (session.created_by_user_id && String(session.created_by_user_id) === String(user.id)) {
    return { session, draft, user, orphan: false };
  }
  if (!session.created_by_user_id) {
    const membership = await deps.repo.getMembership(String(org.id), String(user.id));
    if (membership && canManageSettings(String(membership.role))) {
      return { session, draft, user, orphan: true };
    }
  }
  throw new HttpError(404, "draft not found");
}

async function pipeStudioSse(
  request: FastifyRequest,
  reply: FastifyReply,
  studio: StudioService,
  sessionId: string,
): Promise<void> {
  const queue = studio.subscribe(sessionId);
  reply.hijack();
  reply.raw.writeHead(200, SSE_HEADERS);
  reply.raw.write(": connected\n\n");
  const abort = new AbortController();
  const onClose = () => abort.abort();
  request.raw.on("close", onClose);
  try {
    while (!abort.signal.aborted) {
      const [event, data] = await queue.get(abort.signal);
      reply.raw.write(frameSse(event, data));
    }
  } catch {
    /* disconnected */
  } finally {
    request.raw.off("close", onClose);
    studio.unsubscribe(sessionId, queue);
  }
}

export { collectTaskEmbeds };
