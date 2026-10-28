import { isSystemOfRecord, storageHint } from "../connectors/builder.js";
import { connectorFacts } from "../connectors/view.js";
import type { CapabilityService } from "../capabilities/index.js";
import { oauthSetupState } from "../oauth/index.js";
import {
  findReusableOrgConnection,
  resolvePublishedServer,
  type ConnectedDatabase,
} from "./connected.js";
import type { LoadedConnector } from "../connectors/load.js";

export const CONNECT_WIDGET = "connect";
export const QUESTION_WIDGET = "question";
export const QUESTION_MAX = 4;
export const QUESTION_OPTIONS_MAX = 8;
export const CONNECT_SCOPES = ["org", "guild", "agent"] as const;

export type ConnectWidgetScope = (typeof CONNECT_SCOPES)[number];

export type ConnectWidgetMode = "org" | "any";

function compactServer(row: LoadedConnector, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: row.id,
    slug: row.slug,
    display_name: row.display_name || row.slug,
    auth: row.auth,
    oauth_setup_state: oauthSetupState(row),
    setup_hint: row.setup_hint ?? null,
    ...(row.auth === "token" ? { auth_fields: connectorFacts(row).auth_fields } : {}),
    ...extras,
  };
}

export function normalizeConnectScope(value: string, fallback: ConnectWidgetScope = "org"): ConnectWidgetScope {
  return CONNECT_SCOPES.includes(value as ConnectWidgetScope) ? (value as ConnectWidgetScope) : fallback;
}

export async function buildOrgConnectWidget(args: {
  db: ConnectedDatabase;
  orgId: string;
  serverRef: string;
  reason: string;
}): Promise<Record<string, unknown>> {
  const server = await resolvePublishedServer(args.db, args.serverRef, args.orgId);
  if (!server) {
    return { error: "unknown or unpublished connector" };
  }
  const connection = await findReusableOrgConnection(args.db, args.orgId, server);
  const slug = server.slug;
  return {
    widget: CONNECT_WIDGET,
    mode: "org" as ConnectWidgetMode,
    server: compactServer(server, {
      connection_state: connection ? "connected" : "registered_not_connected",
    }),
    recommended_scope: "org",
    allowed_scopes: ["org"],
    connect_now: !connection,
    already_connected: Boolean(connection),
    await_operator: !connection,
    apply_later: false,
    reason: args.reason.trim(),
    title: connection
      ? `${server.display_name || slug} is already connected to this organisation`
      : `Connect ${server.display_name || slug} to this organisation`,
    storage_hint: isSystemOfRecord(server) ? storageHint() : null,
  };
}

export async function buildAnyConnectWidget(args: {
  db: ConnectedDatabase;
  capabilities: CapabilityService;
  orgId: string;
  serverRef?: string | undefined;
  recommendedScope: ConnectWidgetScope;
  allowScopeChange: boolean;
  reason: string;
}): Promise<Record<string, unknown>> {
  void args.capabilities;
  const published = (await args.db.listMcpServers(args.orgId)).filter(
    (row) => row.enabled !== false,
  );
  const connections = await args.db.listMcpConnections({ orgId: args.orgId });
  const connectedIds = new Set(
    connections
      .filter(
        (row) =>
          row.status === "connected" &&
          (row.owner_scope === "org" || row.owner_scope === "platform"),
      )
      .map((row) => String(row.mcp_server_id)),
  );
  const servers = published.map((row) =>
    compactServer(row, {
      connection_state: connectedIds.has(String(row.id))
        ? "connected"
        : "registered_not_connected",
    }),
  );
  const allowed: ConnectWidgetScope[] = args.allowScopeChange
    ? [...CONNECT_SCOPES]
    : [args.recommendedScope];
  const selected = args.serverRef?.trim()
    ? await resolvePublishedServer(args.db, args.serverRef, args.orgId)
    : null;
  if (args.serverRef?.trim() && !selected) {
    return { error: "unknown or unpublished connector" };
  }
  const orgConnected = selected
    ? Boolean(await findReusableOrgConnection(args.db, args.orgId, selected))
    : false;
  const connectNow = args.recommendedScope === "org" && !orgConnected;
  return {
    widget: CONNECT_WIDGET,
    mode: "any" as ConnectWidgetMode,
    server: selected
      ? compactServer(selected, {
          connection_state: orgConnected ? "connected" : "registered_not_connected",
        })
      : null,
    servers,
    recommended_scope: args.recommendedScope,
    allowed_scopes: allowed,
    connect_now: connectNow,
    already_connected: orgConnected && args.recommendedScope === "org",
    await_operator: !(orgConnected && args.recommendedScope === "org"),
    apply_later: args.recommendedScope !== "org",
    reason: args.reason.trim(),
    title: selected
      ? `Connect ${selected.display_name || selected.slug}`
      : "Connect a service",
    storage_hint: storageHint(),
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionFromUnknown(value: unknown, index: number): { id: string; label: string; description: string } | null {
  if (typeof value === "string" && value.trim()) {
    return { id: `opt-${index + 1}`, label: value.trim(), description: "" };
  }
  const row = asObject(value);
  if (!row) return null;
  const label = typeof row.label === "string" ? row.label.trim() : "";
  if (!label) return null;
  const id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : `opt-${index + 1}`;
  const description = typeof row.description === "string" ? row.description.trim() : "";
  return { id, label, description };
}

function questionFromUnknown(value: unknown, index: number): Record<string, unknown> | null {
  if (typeof value === "string" && value.trim()) {
    return {
      id: `q-${index + 1}`,
      header: "Question",
      question: value.trim(),
      options: [],
      allow_other: true,
      multi_select: false,
    };
  }
  const row = asObject(value);
  if (!row) return null;
  const question = typeof row.question === "string" ? row.question.trim() : "";
  if (!question) return null;
  const rawOptions = Array.isArray(row.options) ? row.options : [];
  const options = rawOptions
    .map((item, optionIndex) => optionFromUnknown(item, optionIndex))
    .filter((item): item is { id: string; label: string; description: string } => Boolean(item))
    .slice(0, QUESTION_OPTIONS_MAX);
  return {
    id: typeof row.id === "string" && row.id.trim() ? row.id.trim() : `q-${index + 1}`,
    header: typeof row.header === "string" && row.header.trim() ? row.header.trim() : "Question",
    question,
    options,
    allow_other: options.length === 0 ? true : row.allow_other !== false,
    multi_select: row.multi_select === true,
  };
}

export function buildQuestionWidget(args: Record<string, unknown>): Record<string, unknown> {
  const raw = Array.isArray(args.questions)
    ? args.questions
    : args.question
      ? [args]
      : [];
  const questions = raw
    .map((item, index) => questionFromUnknown(item, index))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .slice(0, QUESTION_MAX);
  if (!questions.length) {
    return { error: "at least one question is required" };
  }
  return {
    widget: QUESTION_WIDGET,
    await_operator: true,
    title: questions.length === 1 ? String(questions[0]?.header || "Question") : `${questions.length} questions`,
    questions,
  };
}
