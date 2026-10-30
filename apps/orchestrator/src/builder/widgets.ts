import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { isSystemOfRecord, storageHint } from "../connectors/builder.js";
import { connectorFacts, type ConnectorFacts, type LoadedConnector } from "../connectors/servers.js";
import { oauthSetupState } from "../oauth/index.js";
import {
  findReusableOrgConnection,
  resolvePublishedServer,
  type ConnectedDatabase,
} from "./connected.js";

export const CONNECT_WIDGET = "connect";
export const QUESTION_WIDGET = "question";
export const QUESTION_MAX = 4;
export const QUESTION_OPTIONS_MAX = 8;
export const CONNECT_SCOPES = ["org", "guild", "agent"] as const;

export type ConnectWidgetScope = (typeof CONNECT_SCOPES)[number];

export type ConnectWidgetMode = "org" | "any";

/** What the coach asks the operator to connect: the server (the operator picks when undefined), the owner it recommends, whether the operator may pick another owner, and why. */
export type ConnectRequest = {
  serverRef: string | undefined;
  recommendedScope: ConnectWidgetScope;
  allowScopeChange: boolean;
  reason: string;
};

/** Whether the organisation has a login to a connector it may reuse. */
export type ConnectionState = "connected" | "registered_not_connected";

/** A connector as a connect widget shows it; a token connector names the fields its login asks for. */
export type ConnectServer = {
  id: string;
  slug: string;
  display_name: string;
  auth: LoadedConnector["auth"];
  oauth_setup_state: ReturnType<typeof oauthSetupState>;
  setup_hint: string | null;
  auth_fields?: ConnectorFacts["auth_fields"];
  connection_state: ConnectionState;
};

/** What a connect widget shows in either mode: the owners offered, what the operator does now, and why. */
type ConnectWidgetFields = {
  widget: typeof CONNECT_WIDGET;
  recommended_scope: ConnectWidgetScope;
  allowed_scopes: ConnectWidgetScope[];
  connect_now: boolean;
  already_connected: boolean;
  await_operator: boolean;
  apply_later: boolean;
  reason: string;
  title: string;
  storage_hint: string | null;
};

/** The widget that asks the operator to connect one connector to the organisation now. */
export type OrgConnectWidget = { mode: "org"; server: ConnectServer } & ConnectWidgetFields;

/** The widget that lets the operator connect any published connector, the one the coach named first when it named one. */
export type AnyConnectWidget = {
  mode: "any";
  server: ConnectServer | null;
  servers: ConnectServer[];
} & ConnectWidgetFields;

/** One choice of a question card. */
export type QuestionOption = { id: string; label: string; description: string };

/** One question of a question card: its choices, and whether the operator may type another answer or pick several. */
export type Question = {
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
  allow_other: boolean;
  multi_select: boolean;
};

/** The card that pauses the turn until the operator answers its questions. */
export type QuestionWidget = {
  widget: typeof QUESTION_WIDGET;
  await_operator: true;
  title: string;
  questions: Question[];
};

/** A widget a Builder tool pauses the turn on. */
export type BuilderWidget = OrgConnectWidget | AnyConnectWidget | QuestionWidget;

/** Why a widget cannot be shown. */
export type WidgetRefusal = { error: string };

/** An option as the model writes it: its label alone, or its fields. Other fields are read only when they are strings. */
const OptionInput = Type.Union([
  Type.String(),
  Type.Object({
    label: Type.String(),
    id: Type.Optional(Type.Unknown()),
    description: Type.Optional(Type.Unknown()),
  }),
]);

/** A question as the model writes it: the question alone, or its fields. Other fields are read only when they have their type. */
const QuestionInput = Type.Union([
  Type.String(),
  Type.Object({
    question: Type.String(),
    id: Type.Optional(Type.Unknown()),
    header: Type.Optional(Type.Unknown()),
    options: Type.Optional(Type.Unknown()),
    allow_other: Type.Optional(Type.Unknown()),
    multi_select: Type.Optional(Type.Unknown()),
  }),
]);

export type OptionInput = Static<typeof OptionInput>;
export type QuestionInput = Static<typeof QuestionInput>;

function compactServer(row: LoadedConnector, state: ConnectionState): ConnectServer {
  return {
    id: row.id,
    slug: row.slug,
    display_name: row.display_name || row.slug,
    auth: row.auth,
    oauth_setup_state: oauthSetupState(row),
    setup_hint: row.setup_hint ?? null,
    ...(row.auth === "token" ? { auth_fields: connectorFacts(row).auth_fields } : {}),
    connection_state: state,
  };
}

function isConnectScope(value: string): value is ConnectWidgetScope {
  return CONNECT_SCOPES.some((scope) => scope === value);
}

export function normalizeConnectScope(value: string, fallback: ConnectWidgetScope = "org"): ConnectWidgetScope {
  return isConnectScope(value) ? value : fallback;
}

/** The widget that asks the operator to connect `serverRef` to organisation `orgId` now, for `reason`. */
export async function buildOrgConnectWidget(
  db: ConnectedDatabase,
  orgId: string,
  serverRef: string,
  reason: string,
): Promise<OrgConnectWidget | WidgetRefusal> {
  const server = await resolvePublishedServer(db, serverRef, orgId);
  if (!server) {
    return { error: "unknown or unpublished connector" };
  }
  const connection = await findReusableOrgConnection(db, orgId, server);
  const slug = server.slug;
  return {
    widget: CONNECT_WIDGET,
    mode: "org",
    server: compactServer(server, connection ? "connected" : "registered_not_connected"),
    recommended_scope: "org",
    allowed_scopes: ["org"],
    connect_now: !connection,
    already_connected: Boolean(connection),
    await_operator: !connection,
    apply_later: false,
    reason: reason.trim(),
    title: connection
      ? `${server.display_name || slug} is already connected to this organisation`
      : `Connect ${server.display_name || slug} to this organisation`,
    storage_hint: isSystemOfRecord(server) ? storageHint() : null,
  };
}

/** The widget that lets the operator of organisation `orgId` connect any published connector at the scope `request` allows. */
export async function buildAnyConnectWidget(
  db: ConnectedDatabase,
  orgId: string,
  request: ConnectRequest,
): Promise<AnyConnectWidget | WidgetRefusal> {
  const published = await db.listServers({ owner: { visibleTo: orgId }, enabled: true });
  const connections = await db.listMcpConnections({ orgId });
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
    compactServer(row, connectedIds.has(String(row.id)) ? "connected" : "registered_not_connected"),
  );
  const allowed: ConnectWidgetScope[] = request.allowScopeChange
    ? [...CONNECT_SCOPES]
    : [request.recommendedScope];
  const selected = request.serverRef?.trim()
    ? await resolvePublishedServer(db, request.serverRef, orgId)
    : null;
  if (request.serverRef?.trim() && !selected) {
    return { error: "unknown or unpublished connector" };
  }
  const orgConnected = selected
    ? Boolean(await findReusableOrgConnection(db, orgId, selected))
    : false;
  const connectNow = request.recommendedScope === "org" && !orgConnected;
  return {
    widget: CONNECT_WIDGET,
    mode: "any",
    server: selected ? compactServer(selected, orgConnected ? "connected" : "registered_not_connected") : null,
    servers,
    recommended_scope: request.recommendedScope,
    allowed_scopes: allowed,
    connect_now: connectNow,
    already_connected: orgConnected && request.recommendedScope === "org",
    await_operator: !(orgConnected && request.recommendedScope === "org"),
    apply_later: request.recommendedScope !== "org",
    reason: request.reason.trim(),
    title: selected
      ? `Connect ${selected.display_name || selected.slug}`
      : "Connect a service",
    storage_hint: storageHint(),
  };
}

/** `value` trimmed when it is a string; empty otherwise. */
function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionOf(input: OptionInput, index: number): QuestionOption | null {
  const fallbackId = `opt-${index + 1}`;
  if (typeof input === "string") {
    const label = input.trim();
    return label ? { id: fallbackId, label, description: "" } : null;
  }
  const label = input.label.trim();
  if (!label) return null;
  return { id: trimmedString(input.id) || fallbackId, label, description: trimmedString(input.description) };
}

function questionOf(input: QuestionInput, index: number): Question | null {
  const fallbackId = `q-${index + 1}`;
  if (typeof input === "string") {
    const question = input.trim();
    return question
      ? { id: fallbackId, header: "Question", question, options: [], allow_other: true, multi_select: false }
      : null;
  }
  const question = input.question.trim();
  if (!question) return null;
  const options = (Array.isArray(input.options) ? input.options : [])
    .map((item, optionIndex) => (Value.Check(OptionInput, item) ? optionOf(item, optionIndex) : null))
    .filter((item): item is QuestionOption => item !== null)
    .slice(0, QUESTION_OPTIONS_MAX);
  return {
    id: trimmedString(input.id) || fallbackId,
    header: trimmedString(input.header) || "Question",
    question,
    options,
    allow_other: options.length === 0 ? true : input.allow_other !== false,
    multi_select: input.multi_select === true,
  };
}

/** The question card for the questions in `args`: `questions[]`, or `args` itself as one question. */
export function buildQuestionWidget(args: Record<string, unknown>): QuestionWidget | WidgetRefusal {
  const raw = Array.isArray(args.questions)
    ? args.questions
    : args.question
      ? [args]
      : [];
  const questions = raw
    .map((item, index) => (Value.Check(QuestionInput, item) ? questionOf(item, index) : null))
    .filter((item): item is Question => item !== null)
    .slice(0, QUESTION_MAX);
  if (!questions.length) {
    return { error: "at least one question is required" };
  }
  return {
    widget: QUESTION_WIDGET,
    await_operator: true,
    title: questions.length === 1 ? questions[0]?.header || "Question" : `${questions.length} questions`,
    questions,
  };
}
