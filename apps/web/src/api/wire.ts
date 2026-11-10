/** Checks that narrow what the server sends before the app reads it as one of its types. */

import type { ErrorReply, ValidationProblem } from "./client";
import type { ConnectorAuthField, LookupItem } from "./types/access";
import type { NovncUi, RfbConnection } from "./types/agents";
import type {
  BuilderWidget,
  ConnectScope,
  ConnectServer,
  ConnectWidget,
  Question,
  QuestionOption,
  QuestionWidget,
} from "./types/builder";
import type {
  BrowseArguments,
  BrowserToolArguments,
  BuilderToolArguments,
  CodeSearchArguments,
  CodeTaskArguments,
  ConnectorToolArguments,
  FileReadArguments,
  FileToolArguments,
  NamedToolArguments,
  NoteToolArguments,
  RecordToolArguments,
  ReportIssueArguments,
  ShellArguments,
  ShellStatusArguments,
  StudioToolArguments,
  PendingWake,
  WakeAfterArguments,
  WakeUp,
} from "./types/runs";
import type { SecretRequest, SecretRequestAsked } from "./types/secrets";
import type {
  AccessChange,
  AccessChangeKind,
  AccessSetting,
  AccessWidget,
  DraftWidget,
  EditAction,
  EditKind,
  EditTarget,
  EditWidget,
  LineCounts,
  StudioFocus,
  StudioFocusKind,
  StudioFocusRequest,
  StudioWidget,
} from "./types/studio";

/** A value JSON carries: a string, number, boolean or null, or an array or object of them. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** A JSON object. A field held as `undefined` is one JSON leaves out. */
export type JsonObject = { [key: string]: JsonValue | undefined };

/**
 * A JSON Schema object: the keywords the app reads, beside whatever else the schema holds. Each of
 * its `properties` is a JSON Schema too.
 */
export type JsonSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  /** The values the schema allows, when it lists them. */
  enum?: JsonValue[];
  properties?: { [name: string]: JsonSchema };
  required?: string[];
  maxItems?: number;
  /** Marks a connector setting whose values the connector finds by search. */
  "x-lookup"?: boolean;
  [keyword: string]: JsonValue | undefined;
};

/** The value a JSON text holds; undefined when the text is not JSON. */
export function parseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const JSON_SCALARS: readonly string[] = ["string", "number", "boolean"];

/** Whether a value is one JSON carries, every element and field of it included. */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || JSON_SCALARS.includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

/** Whether a value is a JSON object: a plain object, every field of it a JSON value or left out. */
export function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((field) => field === undefined || isJsonValue(field));
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function isNumberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

/** A list whose every item passes `isItem`. */
export function isListOf<T>(value: unknown, isItem: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every((item) => isItem(item));
}

export function isStringList(value: unknown): value is string[] {
  return isListOf(value, isString);
}

/** Whether a value is text or left out. */
function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value);
}

/** Whether a value is true or false, or left out. */
function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || isBoolean(value);
}

/** Whether a value is one of a closed set's members. */
function isOneOf<T>(members: readonly T[], value: unknown): value is T {
  return members.some((member) => member === value);
}

/** The check each keyword the app reads passes when a JSON Schema holds it. */
const schemaKeywordChecks = {
  type: (type) => isString(type) || isStringList(type),
  title: isString,
  description: isString,
  enum: Array.isArray,
  properties: (properties) =>
    isJsonObject(properties) && Object.values(properties).every(isJsonSchema),
  required: isStringList,
  maxItems: isNumber,
  "x-lookup": isBoolean,
} satisfies Record<string, (keyword: JsonValue) => boolean>;

/**
 * Whether a value is a JSON Schema object: a JSON object whose keywords the app reads have their
 * types, each of its properties a JSON Schema too.
 */
export function isJsonSchema(value: unknown): value is JsonSchema {
  return (
    isJsonObject(value) &&
    Object.entries(schemaKeywordChecks).every(([keyword, check]) => {
      const held = value[keyword];
      return held === undefined || check(held);
    })
  );
}

/** Whether every named field of a JSON object passes `isField`. */
export function hasFields(
  record: JsonObject,
  fields: readonly string[],
  isField: (value: JsonValue | undefined) => boolean,
): boolean {
  return fields.every((field) => isField(record[field]));
}

function isValidationProblem(value: unknown): value is ValidationProblem {
  return (
    isJsonObject(value) && hasFields(value, ["type", "msg"], isString) && isStringList(value.loc)
  );
}

/** Whether a failed reply's body carries a `detail` the app can read. */
export function isErrorReply(value: unknown): value is ErrorReply {
  if (!isJsonObject(value)) return false;
  const { detail } = value;
  if (isString(detail) || isListOf(detail, isValidationProblem)) return true;
  return isJsonObject(detail) && isString(detail.message);
}

/** Whether a value is a number, or left out. */
function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || isNumber(value);
}

/** Whether a value is a JSON object whose every named parameter is text, or left out. */
function hasTextParameters(value: unknown, names: readonly string[]): value is JsonObject {
  return isJsonObject(value) && hasFields(value, names, isOptionalString);
}

/** Whether a tool call's arguments are a note tool's: its query, path, key and listed level, as text. */
export function isNoteToolArguments(value: unknown): value is NoteToolArguments {
  return hasTextParameters(value, ["query", "path", "key", "scope"]);
}

/** Whether a tool call's arguments are a record tool's: its collection and query as text, its record's id a number. */
export function isRecordToolArguments(value: unknown): value is RecordToolArguments {
  return hasTextParameters(value, ["collection", "query"]) && isOptionalNumber(value.id);
}

/** Whether a tool call's arguments are a file tool's: its query, path and home path, as text. */
export function isFileToolArguments(value: unknown): value is FileToolArguments {
  return hasTextParameters(value, ["query", "path", "home_path"]);
}

/** Whether a tool call's arguments are a `shell` call's: its command as text, `background` true or false. */
export function isShellArguments(value: unknown): value is ShellArguments {
  return hasTextParameters(value, ["command"]) && isOptionalBoolean(value.background);
}

/** Whether a tool call's arguments are a `shell_status` call's: its id as text, `stop` true or false. */
export function isShellStatusArguments(value: unknown): value is ShellStatusArguments {
  return hasTextParameters(value, ["id"]) && isOptionalBoolean(value.stop);
}

/** Whether a tool call's arguments are a `file_read` call's: its path as text, its offset a number. */
export function isFileReadArguments(value: unknown): value is FileReadArguments {
  return hasTextParameters(value, ["path"]) && isOptionalNumber(value.offset);
}

/** Whether a tool call's arguments are a `code_search` call's: its pattern, mode and path, as text. */
export function isCodeSearchArguments(value: unknown): value is CodeSearchArguments {
  return hasTextParameters(value, ["pattern", "mode", "path"]);
}

/** Whether a tool call's arguments are a `code_task` call's: its brief, repository and session, as text. */
export function isCodeTaskArguments(value: unknown): value is CodeTaskArguments {
  return hasTextParameters(value, ["brief", "repo", "session_id"]);
}

/** Whether a tool call's arguments name its script or secret as text. */
export function isNamedToolArguments(value: unknown): value is NamedToolArguments {
  return hasTextParameters(value, ["name"]);
}

/** Whether a tool call's arguments are a `report_issue` call's: its summary as text. */
export function isReportIssueArguments(value: unknown): value is ReportIssueArguments {
  return hasTextParameters(value, ["summary"]);
}

/** Whether a tool call's arguments are a `wake_after` call's: its minutes a number, its note text. */
export function isWakeAfterArguments(value: unknown): value is WakeAfterArguments {
  return hasTextParameters(value, ["message"]) && isOptionalNumber(value.minutes);
}

/** Whether a value is a run's pending wake-up as the server sends it. */
export function isPendingWake(value: unknown): value is PendingWake {
  return (
    isJsonObject(value) &&
    hasFields(value, ["id", "due_at", "created_at"], isString) &&
    isStringOrNull(value.message)
  );
}

const WAKE_UP_PREFIX = "Wake-up: ";

/** Whether a JSON object is a fired wake-up as its message tells the agent of it. */
function isWakeUp(body: JsonObject): body is JsonObject & WakeUp {
  return (
    hasFields(body, ["id", "set_at", "due_at"], isString) &&
    hasFields(body, ["fired_at", "message"], isStringOrNull) &&
    isNumber(body.wake_ups_left)
  );
}

/** The fired wake-up a `wake` message's text tells the agent of; null when the text is not one. */
export function parseWakeUp(content: string): WakeUp | null {
  if (!content.startsWith(WAKE_UP_PREFIX)) return null;
  const body = parseJson(content.slice(WAKE_UP_PREFIX.length));
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  return isWakeUp(body) ? body : null;
}

/** Whether a tool call's arguments are a `browse` call's: its task and start page, as text. */
export function isBrowseArguments(value: unknown): value is BrowseArguments {
  return hasTextParameters(value, ["task", "start"]);
}

/** Whether a tool call's arguments are a browser tool's: its URL and direction, as text. */
export function isBrowserToolArguments(value: unknown): value is BrowserToolArguments {
  return hasTextParameters(value, ["url", "direction"]);
}

/** Whether a tool call's arguments are a Studio tool's: the agent, action and subject it names, as text. */
export function isStudioToolArguments(value: unknown): value is StudioToolArguments {
  return hasTextParameters(value, [
    "agent_id",
    "target_agent_id",
    "agent_name",
    "action",
    "key",
    "name",
    "collection",
    "tool",
  ]);
}

/** Whether a tool call's arguments are a Builder tool's: its query and connector, as text. */
export function isBuilderToolArguments(value: unknown): value is BuilderToolArguments {
  return hasTextParameters(value, ["query", "server_ref"]);
}

/** Whether a tool call's arguments are a bundled search connector's: its query, account and post, as text. */
export function isConnectorToolArguments(value: unknown): value is ConnectorToolArguments {
  return hasTextParameters(value, ["query", "user", "id"]);
}

const RFB_METHODS = ["focus", "sendKey", "clipboardPasteFrom", "addEventListener"] as const;

/** Whether a value is noVNC's RFB connection: it has every method the clipboard bridge calls. */
export function isRfbConnection(value: unknown): value is RfbConnection {
  if (typeof value !== "object" || value === null) return false;
  return RFB_METHODS.every((method) => typeof Reflect.get(value, method) === "function");
}

/** Whether a value is noVNC's UI module: an object whose RFB connection is one, or not there yet. */
export function isNovncUi(value: unknown): value is NovncUi {
  if (typeof value !== "object" || value === null) return false;
  const rfb: unknown = Reflect.get(value, "rfb");
  return rfb === undefined || rfb === null || isRfbConnection(rfb);
}

/** Whether a value is a connector's item a lookup stores: an object whose id, name and symbol are text. */
export function isLookupItem(value: unknown): value is LookupItem {
  return isJsonObject(value) && hasFields(value, ["id", "name", "symbol"], isOptionalString);
}

/** Whether a value is a secret_request call's arguments: the name, description and reason, as text. */
export function isSecretRequest(value: unknown): value is SecretRequest {
  return isJsonObject(value) && hasFields(value, ["name", "description", "reason"], isString);
}

/** Whether a value is the line a secret_request result opens with when it asked the operator. */
export function isSecretRequestAsked(value: unknown): value is SecretRequestAsked {
  return (
    isJsonObject(value) &&
    value.widget === "secret_request" &&
    value.status === "asked" &&
    isString(value.name)
  );
}

const STUDIO_FOCUS_KINDS: readonly StudioFocusKind[] = [
  "run",
  "memory_version",
  "routine",
  "file",
  "issue",
  "tool",
];

/** An id or path a focus pin names, null when it names none, or left out. */
function isFocusText(value: unknown): value is string | null | undefined {
  return value === undefined || isStringOrNull(value);
}

/** A step or version a focus pin names, a number; null or left out for none. */
function isFocusIndex(value: unknown): value is number | null | undefined {
  return value === undefined || isNumberOrNull(value);
}

/** Whether a value is the evidence a Studio message is pinned to: a kind the server resolves, and ids that are text or null. */
export function isStudioFocusRequest(value: unknown): value is StudioFocusRequest {
  return (
    isJsonObject(value) &&
    STUDIO_FOCUS_KINDS.some((kind) => kind === value.kind) &&
    hasFields(value, ["seq", "version_index"], isFocusIndex) &&
    hasFields(
      value,
      [
        "agent_id",
        "run_id",
        "call_id",
        "revision_id",
        "schedule_id",
        "display_path",
        "change_id",
        "issue_id",
        "tool_name",
      ],
      isFocusText,
    )
  );
}

/** Whether a value is the evidence the server stored on a pinned Studio message: every field of it. */
export function isStudioFocus(value: unknown): value is StudioFocus {
  return (
    isJsonObject(value) &&
    STUDIO_FOCUS_KINDS.some((kind) => kind === value.kind) &&
    isString(value.label) &&
    hasFields(value, ["seq", "version_index"], isNumberOrNull) &&
    hasFields(
      value,
      [
        "agent_id",
        "agent_name",
        "run_id",
        "call_id",
        "tool_name",
        "revision_id",
        "schedule_id",
        "display_path",
        "change_id",
        "issue_id",
      ],
      isStringOrNull,
    )
  );
}

const EDIT_KINDS: readonly EditKind[] = [
  "memory",
  "note",
  "guild",
  "collection",
  "access",
  "routine",
];

const EDIT_ACTIONS: readonly EditAction[] = ["create", "edit", "delete"];

const ACCESS_CHANGE_KINDS: readonly AccessChangeKind[] = ["native_tool", "mcp", "mcp_tool"];

const ACCESS_SETTINGS: readonly AccessSetting[] = ["on", "off", "inherit"];

/** The fields of a JSON object that hold text, by name; a field of another type is left out. */
function textFields<Key extends string>(
  record: JsonObject,
  keys: readonly Key[],
): Partial<Record<Key, string>> {
  const fields: Partial<Record<Key, string>> = {};
  for (const key of keys) {
    const value = record[key];
    if (isString(value)) fields[key] = value;
  }
  return fields;
}

/** The fields of a JSON object that hold text or null, by name; one of another type is left out. */
function nullableTextFields<Key extends string>(
  record: JsonObject,
  keys: readonly Key[],
): Partial<Record<Key, string | null>> {
  const fields: Partial<Record<Key, string | null>> = {};
  for (const key of keys) {
    const value = record[key];
    if (isStringOrNull(value)) fields[key] = value;
  }
  return fields;
}

/** One overlay of an access edit; null when it lacks a field or names no known kind or setting. */
function parseAccessChange(value: unknown): AccessChange | null {
  if (!isJsonObject(value)) return null;
  const kind = ACCESS_CHANGE_KINDS.find((entry) => entry === value.kind);
  const setting = ACCESS_SETTINGS.find((entry) => entry === value.setting);
  if (!kind || !setting || !isString(value.id) || !isString(value.label)) return null;
  return { kind, id: value.id, label: value.label, setting };
}

/** The line counts of an edit, keeping the counts that are numbers. */
function parseLineCounts(lines: JsonObject): LineCounts {
  return {
    ...(isNumber(lines.added) ? { added: lines.added } : {}),
    ...(isNumber(lines.removed) ? { removed: lines.removed } : {}),
  };
}

/** What an edit names as its target, keeping the fields of the type each holds. */
function parseEditTarget(target: JsonObject): EditTarget {
  return {
    ...textFields(target, [
      "agent_id",
      "agent_name",
      "display_path",
      "title",
      "guild_id",
      "guild_name",
      "name",
      "description",
    ]),
    ...nullableTextFields(target, ["collection_id", "schedule_id"]),
  };
}

/** An edit request's edit, keeping each field that holds what the field says. */
export function parseStudioEdit(value: unknown): EditWidget["edit"] {
  if (!isJsonObject(value)) return {};
  const kind = EDIT_KINDS.find((entry) => entry === value.kind);
  const action = EDIT_ACTIONS.find((entry) => entry === value.action);
  const { fields, changes } = value;
  return {
    ...(kind ? { kind } : {}),
    ...(action ? { action } : {}),
    ...(isJsonObject(value.target) ? { target: parseEditTarget(value.target) } : {}),
    ...(isNumber(value.base_version) ? { base_version: value.base_version } : {}),
    ...(Array.isArray(fields) ? { fields: fields.filter(isString) } : {}),
    ...(isJsonObject(value.lines) ? { lines: parseLineCounts(value.lines) } : {}),
    ...(Array.isArray(changes)
      ? { changes: changes.map(parseAccessChange).filter((change) => change !== null) }
      : {}),
    ...(isBoolean(value.widens) ? { widens: value.widens } : {}),
  };
}

/** The login an access request names, keeping the fields that hold text. */
export function parseStudioConnection(value: unknown): AccessWidget["connection"] {
  if (!isJsonObject(value)) return {};
  return {
    ...textFields(value, ["id", "owner_scope", "account_hint"]),
    ...(isJsonObject(value.server)
      ? { server: textFields(value.server, ["id", "slug", "display_name"]) }
      : {}),
  };
}

/** A draft widget's fields, when the tool result carries them. */
function parseDraftWidget(body: JsonObject): DraftWidget | null {
  const agent = textFields(isJsonObject(body.agent) ? body.agent : {}, ["id", "name"]);
  if (!isString(body.draft_id) || agent.id === undefined) return null;
  return {
    kind: "draft",
    agent: { id: agent.id, name: agent.name ?? agent.id },
    draft_id: body.draft_id,
    ...textFields(body, ["rationale"]),
  };
}

/**
 * The request a coach's tool result text carries for the operator: an edit to apply, a login to
 * grant, or a Task draft; null when the text is not JSON or names no such widget.
 */
export function parseStudioWidget(content: string): StudioWidget | null {
  const body = parseJson(content);
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  if (body.widget === "studio_edit_request") {
    return {
      kind: "edit",
      ...textFields(body, ["title", "reason"]),
      edit: parseStudioEdit(body.edit),
    };
  }
  if (body.widget === "studio_connection_access") {
    return {
      kind: "access",
      ...textFields(body, ["title", "reason"]),
      connection: parseStudioConnection(body.connection),
    };
  }
  if (body.widget === "studio_task_draft") return parseDraftWidget(body);
  return null;
}

const connectScopes: readonly ConnectScope[] = ["org", "guild", "agent"];

/** Whether a value names where a login lives: the organisation, the guild or an agent. */
export function isConnectScope(value: unknown): value is ConnectScope {
  return isOneOf(connectScopes, value);
}

const connectorAuths: readonly ConnectServer["auth"][] = ["none", "token", "oauth"];

const oauthSetupStates: readonly ConnectServer["oauth_setup_state"][] = [
  "not_applicable",
  "dynamic",
  "configured",
  "unsupported",
];

const connectionStates: readonly ConnectServer["connection_state"][] = [
  "connected",
  "registered_not_connected",
];

/** Whether a value is one input a key login asks for: its name and label, and the flags it sets. */
function isConnectorAuthField(value: unknown): value is ConnectorAuthField {
  return (
    isJsonObject(value) &&
    hasFields(value, ["name", "label"], isString) &&
    hasFields(value, ["secret", "optional"], isOptionalBoolean) &&
    isOptionalString(value.placeholder)
  );
}

/** Whether a value is a connector as a connect widget shows it. */
function isConnectServer(value: unknown): value is ConnectServer {
  return (
    isJsonObject(value) &&
    hasFields(value, ["id", "slug", "display_name"], isString) &&
    isStringOrNull(value.setup_hint) &&
    isOneOf(connectorAuths, value.auth) &&
    isOneOf(oauthSetupStates, value.oauth_setup_state) &&
    isOneOf(connectionStates, value.connection_state) &&
    (value.auth_fields === undefined || isListOf(value.auth_fields, isConnectorAuthField))
  );
}

/** Whether a widget's body is a connect widget: its scopes, texts, and the server or servers its mode names. */
function isConnectWidget(body: JsonObject): body is ConnectWidget {
  const named =
    (body.mode === "org" && isConnectServer(body.server)) ||
    (body.mode === "any" &&
      (body.server === null || isConnectServer(body.server)) &&
      isListOf(body.servers, isConnectServer));
  return (
    named &&
    isConnectScope(body.recommended_scope) &&
    isListOf(body.allowed_scopes, isConnectScope) &&
    hasFields(body, ["already_connected", "await_operator"], isBoolean) &&
    hasFields(body, ["reason", "title"], isString) &&
    isStringOrNull(body.storage_hint)
  );
}

function isQuestionOption(value: unknown): value is QuestionOption {
  return isJsonObject(value) && hasFields(value, ["id", "label", "description"], isString);
}

function isQuestion(value: unknown): value is Question {
  return (
    isJsonObject(value) &&
    hasFields(value, ["id", "header", "question"], isString) &&
    isListOf(value.options, isQuestionOption) &&
    hasFields(value, ["allow_other", "multi_select"], isBoolean)
  );
}

/** Whether a widget's body is a question card: its title and its questions. */
function isQuestionWidget(body: JsonObject): body is QuestionWidget {
  return (
    body.await_operator === true && isString(body.title) && isListOf(body.questions, isQuestion)
  );
}

/** Whether a value is a widget a Builder tool result carries: a connect widget or a question card. */
export function isBuilderWidget(value: unknown): value is BuilderWidget {
  if (!isJsonObject(value)) return false;
  if (value.widget === "connect") return isConnectWidget(value);
  return value.widget === "question" && isQuestionWidget(value);
}
