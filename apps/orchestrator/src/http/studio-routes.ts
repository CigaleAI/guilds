import { Type } from "@sinclair/typebox";
import type { FastifyRequest } from "fastify";
import { loadOperatorActor } from "../artifacts/actors.js";
import type { ArtifactActor } from "../artifacts/types.js";
import { requireVisibleGuild } from "../guilds/access.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { HttpError } from "./errors.js";
import { currentOrg, currentUser } from "./identity.js";
import { GuildParams } from "./params.js";
import { pipeSse } from "./sse.js";
import {
  activityWindow,
  ActivityWindowQuerySchema,
  hoursWindow,
  loadGuildActivity,
} from "../studio/activity.js";
import { loadGuildTools, loadToolCalls } from "../studio/tool-usage.js";
import { loadGuildReferences } from "../studio/references.js";
import {
  loadStateHistory,
  loadStateItem,
  loadStateList,
  parseOperation,
  parseStateKind,
  type StateDeps,
} from "../studio/state-data.js";
import { viewDraft } from "../studio/drafts.js";
import { StudioFocusRequestSchema } from "../studio/focus.js";
import type { StudioService } from "../studio/index.js";
import { isOrgManager } from "../organisations/service.js";
import {
  listAgentRoutines,
  listAgentRunHeaders,
  readGuildRun,
  RunHeaderQuerySchema,
  type InspectorServices,
} from "../studio/inspector.js";
import type { UserRow } from "../db/users.js";
import type { StudioDraftRow, StudioSessionRow } from "../db/studio.js";
import type { OrgMembershipRow } from "../db/orgs.js";

/** The path of one Studio session. */
const SessionParams = Type.Object({ session_id: Type.String() });

/** The path of one connection a session may use. */
const SessionConnectionParams = Type.Object({
  session_id: Type.String(),
  connection_id: Type.String(),
});

/** The path of a session's login request or proposed edit, by the sequence of its message. */
const SessionSeqParams = Type.Object({ session_id: Type.String(), seq: Type.String() });

/** The path of one agent of a session's guild. */
const SessionAgentParams = Type.Object({ session_id: Type.String(), agent_id: Type.String() });

/** The path of one tool the agents of a session's guild call. */
const SessionToolParams = Type.Object({ session_id: Type.String(), name: Type.String() });

/** The path of one run of a session's guild. */
const SessionRunParams = Type.Object({ session_id: Type.String(), run_id: Type.String() });

/** The path of one draft. */
const DraftParams = Type.Object({ draft_id: Type.String() });

/** A new coach session: its mode, the guild it works on, the coach's model and temperature, and the session it continues. */
const SessionDraftSchema = Type.Object({
  mode: Type.Optional(Type.String()),
  source_guild_id: Type.Optional(Type.String()),
  coach_config: Type.Optional(
    Type.Object({
      model: Type.Optional(Type.String()),
      temperature: Type.Optional(Type.Number()),
    }),
  ),
  model: Type.Optional(Type.String()),
  parent_session_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

/** Whether a session may use a connection; left out is granted. */
const ConnectionGrantSchema = Type.Object({ granted: Type.Optional(Type.Boolean()) });

/** The operator's answer to the coach's login request. */
const LoginDecisionSchema = Type.Object({
  decision: Type.Union([Type.Literal("grant"), Type.Literal("decline")]),
});

/** The operator's answer to an edit the coach proposed. */
const EditDecisionSchema = Type.Object({
  decision: Type.Union([Type.Literal("apply"), Type.Literal("decline")]),
});

/** The agent a session works on; null or left out is none. */
const TargetSchema = Type.Object({
  agent_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

/** The operator's message to the coach, and the evidence it is pinned to. */
const MessageSchema = Type.Object({
  content: Type.Optional(Type.String()),
  focus: Type.Optional(Type.Union([StudioFocusRequestSchema, Type.Null()])),
});

/** A draft's new content, over the head it was edited from; the draft itself when left out. */
const ReviseSchema = Type.Object({
  proposed_content: Type.Optional(Type.String()),
  expected_head_id: Type.Optional(Type.String()),
});

/** The State list's window and filters: an agent and an item kind. */
const StateListQuerySchema = Type.Object({
  hours: Type.Optional(Type.String()),
  agent: Type.Optional(Type.String()),
  kind: Type.Optional(Type.String()),
});

/** One State item by its display path: its numbers over the window, and a page of its history. */
const StateItemQuerySchema = Type.Object({
  path: Type.Optional(Type.String()),
  hours: Type.Optional(Type.String()),
  op: Type.Optional(Type.String()),
  cursor: Type.Optional(Type.String()),
});

/** A tool's calls over the window, the failed ones alone when `errors` is `true` or `1`, a page at a time. */
const ToolCallsQuerySchema = Type.Object({
  hours: Type.Optional(Type.String()),
  errors: Type.Optional(Type.String()),
  cursor: Type.Optional(Type.String()),
});

function studioOf(deps: AppDeps): StudioService {
  if (!deps.studio) {
    throw new HttpError(422, "studio is not available");
  }
  return deps.studio;
}

export async function registerStudioRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const inspector: InspectorServices = {
    db,
    schedules: deps.schedules,
    generation: deps.generation ?? null,
  };

  app.get("/api/studio/sessions", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    return studioOf(deps).listSessions(org.id, user.id);
  });

  app.post("/api/studio/sessions", { schema: { body: SessionDraftSchema } }, async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    const body = request.body;
    const temperature = body.coach_config?.temperature;
    const parentSessionId = body.parent_session_id?.trim() ?? "";
    return await studioOf(deps).createSession({
      user,
      org,
      mode: body.mode ?? "optimize",
      sourceGuildId: body.source_guild_id ?? "",
      model: body.coach_config?.model ?? body.model ?? "",
      ...(temperature !== undefined ? { temperature } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
    });
  });

  app.get(
    "/api/studio/sessions/:session_id",
    { schema: { params: SessionParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(request.params.session_id, user, org);
      return studio.viewSession(session);
    },
  );

  app.post(
    "/api/studio/sessions/:session_id/archive",
    { schema: { params: SessionParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(request.params.session_id, user, org);
      return await studio.archive(session);
    },
  );

  app.get(
    "/api/studio/sessions/:session_id/connections",
    { schema: { params: SessionParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(request.params.session_id, user, org);
      return { connections: await studio.listConnections(session) };
    },
  );

  app.put(
    "/api/studio/sessions/:session_id/connections/:connection_id",
    { schema: { params: SessionConnectionParams, body: ConnectionGrantSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(request.params.session_id, user, org);
      const connectionId = request.params.connection_id;
      return request.body.granted === false
        ? await studio.withdrawConnection(session, connectionId)
        : await studio.grantConnection(session, connectionId);
    },
  );

  app.post(
    "/api/studio/sessions/:session_id/logins/:seq",
    { schema: { params: SessionSeqParams, body: LoginDecisionSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(request.params.session_id, user, org);
      const seq = Number(request.params.seq);
      return await studio.resolveLogin(session, user, seq, request.body.decision);
    },
  );

  app.get(
    "/api/studio/sessions/:session_id/edits/:seq",
    { schema: { params: SessionSeqParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(request.params.session_id, user, org);
      return await studio.getEdit(session, user, Number(request.params.seq));
    },
  );

  app.post(
    "/api/studio/sessions/:session_id/edits/:seq",
    { schema: { params: SessionSeqParams, body: EditDecisionSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(request.params.session_id, user, org);
      const seq = Number(request.params.seq);
      return await studio.resolveEdit(session, user, seq, request.body.decision);
    },
  );

  app.put(
    "/api/studio/sessions/:session_id/target",
    { schema: { params: SessionParams, body: TargetSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(request.params.session_id, user, org);
      return await studio.setTarget(session, request.body.agent_id ?? null);
    },
  );

  app.get(
    "/api/studio/guilds/:guild_id/inventory",
    { schema: { params: GuildParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const guild = await requireVisibleGuild(db, request.params.guild_id, user.id);
      const studio: StudioService = studioOf(deps);
      const rows = await studio.guildInventory(String(guild.id));
      return rows.map((row) => studio.inventoryItem(row));
    },
  );

  app.get(
    "/api/studio/sessions/:session_id/inventory",
    { schema: { params: SessionParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(request.params.session_id, user, org);
      return await studio.inventory(session);
    },
  );

  app.get(
    "/api/studio/sessions/:session_id/agents/:agent_id",
    { schema: { params: SessionAgentParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(request.params.session_id, user, org);
      return await studio.inspector(session, request.params.agent_id);
    },
  );

  app.get(
    "/api/studio/sessions/:session_id/messages",
    { schema: { params: SessionParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(request.params.session_id, user, org);
      return await studio.messages(session);
    },
  );

  app.post(
    "/api/studio/sessions/:session_id/messages",
    { schema: { params: SessionParams, body: MessageSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(request.params.session_id, user, org);
      const body = request.body;
      return await studio.postMessage(session, user, body.content ?? "", body.focus);
    },
  );

  app.post(
    "/api/studio/sessions/:session_id/cancel",
    { schema: { params: SessionParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(request.params.session_id, user, org);
      return await studio.cancel(session);
    },
  );

  app.post(
    "/api/studio/sessions/:session_id/continue",
    { schema: { params: SessionParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(request.params.session_id, user, org);
      return await studio.continueSession(session, user, org);
    },
  );

  app.get(
    "/api/studio/sessions/:session_id/stream",
    { schema: { params: SessionParams } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(request.params.session_id, user, org);
      const sessionId = session.id;
      await pipeSse(
        request,
        reply,
        () => studio.subscribe(sessionId),
        (queue) => studio.unsubscribe(sessionId, queue),
      );
    },
  );

  app.get(
    "/api/studio/sessions/:session_id/drafts",
    { schema: { params: SessionParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(request.params.session_id, user, org);
      return (await studio.sessionDrafts(session)).map(viewDraft);
    },
  );

  app.get("/api/studio/orphan-drafts", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    if (!(await isOrgManager(db, org.id, user.id))) {
      throw new HttpError(403, "forbidden");
    }
    return (await studioOf(deps).orphanDrafts(org.id)).map(viewDraft);
  });

  app.get("/api/studio/drafts/:draft_id", { schema: { params: DraftParams } }, async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    const loaded = await loadDraftContext(deps, user, org, request.params.draft_id);
    return viewDraft(loaded.draft);
  });

  app.post(
    "/api/studio/drafts/:draft_id/revise",
    { schema: { params: DraftParams, body: ReviseSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const body = request.body;
      const loaded = await loadDraftContext(deps, user, org, request.params.draft_id);
      return await studioOf(deps).drafts.revise(
        loaded.session,
        user,
        loaded.draft.id,
        body.proposed_content ?? "",
        body.expected_head_id ?? loaded.draft.id,
      );
    },
  );

  app.post(
    "/api/studio/drafts/:draft_id/publish",
    { schema: { params: DraftParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const loaded = await loadDraftContext(deps, user, org, request.params.draft_id);
      const studio: StudioService = studioOf(deps);
      return loaded.orphan
        ? await studio.publishOrphanDraft(loaded.session, loaded.user, loaded.draft.id)
        : await studio.publishDraft(loaded.session, loaded.user, loaded.draft.id);
    },
  );

  app.post(
    "/api/studio/drafts/:draft_id/discard",
    { schema: { params: DraftParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const loaded = await loadDraftContext(deps, user, org, request.params.draft_id);
      if (loaded.orphan) {
        throw new HttpError(403, "orphan recovery cannot discard");
      }
      return await studioOf(deps).drafts.discard(loaded.session, loaded.user, loaded.draft.id);
    },
  );

  app.get(
    "/api/studio/sessions/:session_id/agents/:agent_id/runs",
    { schema: { params: SessionAgentParams, querystring: RunHeaderQuerySchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(request.params.session_id, user, org);
      studio.assertLive(session);
      const agent = await studio.requireGuildAgent(session, request.params.agent_id);
      return await listAgentRunHeaders(inspector, String(agent.id), request.query);
    },
  );

  app.get(
    "/api/studio/sessions/:session_id/activity",
    { schema: { params: SessionParams, querystring: ActivityWindowQuerySchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(request.params.session_id, user, org);
      studio.assertLive(session);
      const now = new Date();
      const window = activityWindow(request.query, now);
      return await loadGuildActivity(db, session.source_guild_id, {
        ...window,
        now,
        generating: (runId) => (deps.generation ? deps.generation.isGenerating(runId) : false),
      });
    },
  );

  // The State list reads with the operator's own permissions, so it lists
  // only what the viewer can open.
  async function stateScope(
    request: FastifyRequest,
    sessionId: string,
  ): Promise<{ actor: ArtifactActor; guildId: string; deps: StateDeps }> {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    const studio: StudioService = studioOf(deps);
    const session = await studio.getOwnedSession(sessionId, user, org);
    studio.assertLive(session);
    const guildId = session.source_guild_id;
    const actor = await loadOperatorActor(db, user, { orgId: session.org_id, guildId });
    return { actor, guildId, deps: { db, artifacts: studio.deps.artifacts } };
  }

  app.get(
    "/api/studio/sessions/:session_id/state",
    { schema: { params: SessionParams, querystring: StateListQuerySchema } },
    async (request) => {
      const query = request.query;
      const { deps: stateDeps, ...scope } = await stateScope(request, request.params.session_id);
      return await loadStateList(
        stateDeps,
        { ...scope, window: hoursWindow(query.hours, new Date()) },
        { kind: parseStateKind(query.kind), agentId: query.agent || null },
      );
    },
  );

  app.get(
    "/api/studio/sessions/:session_id/state/item",
    { schema: { params: SessionParams, querystring: StateItemQuerySchema } },
    async (request) => {
      const query = request.query;
      const path = query.path ?? "";
      const { deps: stateDeps, ...scope } = await stateScope(request, request.params.session_id);
      const window = hoursWindow(query.hours, new Date());
      const numbers = await loadStateItem(stateDeps, { ...scope, window }, path);
      const history = await loadStateHistory(stateDeps, scope, {
        path,
        op: parseOperation(query.op),
        cursor: query.cursor || null,
      });
      return { ...numbers, ...history };
    },
  );

  app.get(
    "/api/studio/sessions/:session_id/tools",
    { schema: { params: SessionParams, querystring: ActivityWindowQuerySchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(request.params.session_id, user, org);
      studio.assertLive(session);
      const window = activityWindow(request.query, new Date());
      const services = { db, preview: studio.previewDeps() };
      return await loadGuildTools(services, session.source_guild_id, window);
    },
  );

  app.get(
    "/api/studio/sessions/:session_id/tools/:name/calls",
    { schema: { params: SessionToolParams, querystring: ToolCallsQuerySchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const query = request.query;
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(request.params.session_id, user, org);
      studio.assertLive(session);
      return await loadToolCalls(db, session.source_guild_id, {
        tool: request.params.name,
        window: hoursWindow(query.hours, new Date()),
        query: {
          errorsOnly: query.errors === "true" || query.errors === "1",
          cursor: query.cursor || null,
        },
      });
    },
  );

  app.get(
    "/api/studio/sessions/:session_id/references",
    { schema: { params: SessionParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(request.params.session_id, user, org);
      studio.assertLive(session);
      const guildId = session.source_guild_id;
      const actor = await loadOperatorActor(db, user, { orgId: session.org_id, guildId });
      return await loadGuildReferences({ db, artifacts: studio.deps.artifacts }, actor, guildId);
    },
  );

  app.get(
    "/api/studio/sessions/:session_id/runs/:run_id",
    { schema: { params: SessionRunParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(request.params.session_id, user, org);
      studio.assertLive(session);
      return await readGuildRun(inspector, session.source_guild_id, request.params.run_id);
    },
  );

  app.get(
    "/api/studio/sessions/:session_id/agents/:agent_id/routines",
    { schema: { params: SessionAgentParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(request.params.session_id, user, org);
      studio.assertLive(session);
      const agent = await studio.requireGuildAgent(session, request.params.agent_id);
      return await listAgentRoutines(inspector, String(agent.id));
    },
  );

  app.get(
    "/api/studio/sessions/:session_id/agents/:agent_id/memory-timeline",
    { schema: { params: SessionAgentParams } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const org = await currentOrg(db, request, user);
      const studio: StudioService = studioOf(deps);
      const session = await studio.getOwnedSession(request.params.session_id, user, org);
      return await studio.memoryTimeline(session, user, request.params.agent_id);
    },
  );
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
