import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { AgentFileError, agentDisplayPath, writeAgentFile } from "../../lib/agent-file.js";
import { decode } from "../../lib/decode.js";
import { proxyFetch, type FetchFn } from "../../net/http.js";
import { argStr, clipRows, clipText, joinParts, rowLimit } from "../format.js";
import {
  AttachmentResponse,
  DraftListResponse,
  DraftResponse,
  ErrorBody,
  LabelsResponse,
  Message,
  ProfileResponse,
  SentResponse,
  ThreadListResponse,
  ThreadResponse,
  type DraftSummary,
  type Header,
  type MessagePart,
  type ThreadSummary,
} from "./responses.js";

export const API_BASE = "https://gmail.googleapis.com/gmail/v1";
export const SNIPPET_CAP = 160;
export const BODY_CAP = 4_000;
export const ATTACHMENT_CAP = 25 * 1024 * 1024;
const METADATA_HEADERS = ["From", "To", "Subject", "Date"];

export class GmailError extends Error {
  status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "GmailError";
    this.status = status;
  }
}

export type GmailOptions = {
  accessToken: string;
  client?: FetchFn;
  proxyUrl?: string;
  /** The agent's workspace when the call comes from a run. */
  workspaceDir?: string;
};

/**
 * A message part sent as a file. Its bytes are fetched by `attachmentId`, or carried inline in
 * `data` when the part is small.
 */
export type MessageAttachment = {
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
  data: string;
};

export function headerMap(headers: Header[] | null | undefined): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const item of headers ?? []) {
    const name = String(item.name ?? "").trim().toLowerCase();
    const value = String(item.value ?? "").trim();
    if (name && value && mapped[name] === undefined) {
      mapped[name] = value;
    }
  }
  return mapped;
}

export function decodeBodyData(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

export function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function partFilename(part: MessagePart): string {
  return String(part.filename ?? "").trim();
}

/** The inline body data of a part that is message text, not an attachment. */
function textData(part: MessagePart): string {
  if (partFilename(part)) {
    return "";
  }
  const data = part.body?.data;
  return typeof data === "string" ? data : "";
}

/** A message's text, as its plain and its HTML parts carry it. */
type MessageText = { plain: string; html: string };

function collectText(part: MessagePart, into: MessageText): void {
  const mime = String(part.mimeType ?? "");
  const data = textData(part);
  if (data && mime.startsWith("text/plain")) {
    into.plain += decodeBodyData(data);
  } else if (data && mime.startsWith("text/html")) {
    into.html += decodeBodyData(data);
  }
  for (const child of part.parts ?? []) {
    collectText(child, into);
  }
}

function attachmentOf(part: MessagePart): MessageAttachment | null {
  const filename = partFilename(part);
  if (!filename) {
    return null;
  }
  const body = part.body ?? {};
  return {
    partId: String(part.partId ?? "").trim(),
    filename,
    mimeType: String(part.mimeType ?? "").trim(),
    size: typeof body.size === "number" ? body.size : 0,
    attachmentId: typeof body.attachmentId === "string" ? body.attachmentId : "",
    data: typeof body.data === "string" ? body.data : "",
  };
}

function collectAttachments(part: MessagePart, into: MessageAttachment[]): void {
  const attachment = attachmentOf(part);
  if (attachment) {
    into.push(attachment);
  }
  for (const child of part.parts ?? []) {
    collectAttachments(child, into);
  }
}

/** Every part of a message that carries a filename, in message order. */
export function messageAttachments(payload: MessagePart | null | undefined): MessageAttachment[] {
  const found: MessageAttachment[] = [];
  if (payload) {
    collectAttachments(payload, found);
  }
  return found;
}

function attachmentLine(attachment: MessageAttachment): string {
  return joinParts(
    "attachment",
    `part=${attachment.partId}`,
    attachment.filename,
    attachment.mimeType,
    `bytes=${attachment.size}`,
  );
}

export function messageBody(payload: MessagePart | null | undefined): string {
  if (!payload) {
    return "";
  }
  const collected: MessageText = { plain: "", html: "" };
  collectText(payload, collected);
  if (collected.plain.trim()) {
    return clipText(collected.plain, BODY_CAP);
  }
  if (collected.html.trim()) {
    return clipText(stripTags(collected.html), BODY_CAP);
  }
  return "";
}

function encodeSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) {
    return subject;
  }
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

/** A plain-text message to send: its recipients, subject and body. */
export type OutgoingMessage = { to: string; subject: string; body: string; cc?: string; bcc?: string };

export function rfc2822Raw(fields: OutgoingMessage): string {
  const lines = [`To: ${fields.to}`];
  if (fields.cc) {
    lines.push(`Cc: ${fields.cc}`);
  }
  if (fields.bcc) {
    lines.push(`Bcc: ${fields.bcc}`);
  }
  lines.push(`Subject: ${encodeSubject(fields.subject)}`);
  lines.push("MIME-Version: 1.0");
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push("");
  lines.push(fields.body);
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

/** A listing's next page token, trimmed; empty on the last page. */
function pageToken(token: unknown): string {
  return typeof token === "string" && token.trim() ? token.trim() : "";
}

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    return text.trim() || `Gmail HTTP ${response.status}`;
  }
  const message = Value.Check(ErrorBody, payload) ? payload.error.message : undefined;
  return typeof message === "string" && message.trim() ? message.trim() : `Gmail HTTP ${response.status}`;
}

function gmailUrl(path: string, params: Record<string, string | string[] | undefined> = {}): string {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, item);
      }
    } else {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function unexpected(problem: string): GmailError {
  return new GmailError(`Gmail returned an unexpected response at ${problem}`);
}

async function jsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GmailError("Gmail returned a non-JSON body");
  }
}

/** One Gmail API call: `method` on `path` with its query and JSON body, the JSON response decoded with `schema`. */
type GmailRequest<T extends TSchema> = {
  method: string;
  path: string;
  schema: T;
  params?: Record<string, string | string[] | undefined>;
  body?: unknown;
};

/** The response of `method` on `path`, as `schema` describes it; an empty body reads as `{}`. */
async function gmailRequest<T extends TSchema>(request: GmailRequest<T>, options: GmailOptions): Promise<Static<T>> {
  const token = options.accessToken.trim();
  if (!token) {
    throw new GmailError("Gmail access token is missing", 401);
  }
  const fetchFn = options.client ?? proxyFetch(options.proxyUrl ?? "");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  const init: RequestInit = { method: request.method, headers };
  if (request.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(request.body);
  }
  const response = await fetchFn(gmailUrl(request.path, request.params), init);
  if (response.status >= 400) {
    throw new GmailError(await errorDetail(response), response.status);
  }
  return decode(request.schema, await jsonBody(response), unexpected);
}

function composeFields(arguments_: Record<string, unknown>): OutgoingMessage {
  const to = argStr(arguments_, "to");
  const subject = argStr(arguments_, "subject");
  const body = argStr(arguments_, "body");
  if (!to) {
    throw new GmailError("to is required");
  }
  const fields: OutgoingMessage = { to, subject, body };
  const cc = argStr(arguments_, "cc");
  const bcc = argStr(arguments_, "bcc");
  if (cc) {
    fields.cc = cc;
  }
  if (bcc) {
    fields.bcc = bcc;
  }
  return fields;
}

function formatMessageHead(message: Message): string {
  const headers = headerMap(message.payload?.headers);
  return joinParts(
    message.id,
    headers.from,
    headers.to,
    headers.date,
    headers.subject,
  );
}

/** A message's headers, one line per attachment, then its text body. */
function formatMessage(message: Message): string {
  const attachments = messageAttachments(message.payload).map(attachmentLine);
  return [formatMessageHead(message), ...attachments, messageBody(message.payload)].filter(Boolean).join("\n");
}

function requiredArg(arguments_: Record<string, unknown>, key: string): string {
  const value = argStr(arguments_, key);
  if (!value) {
    throw new GmailError(`${key} is required`);
  }
  return value;
}

function findAttachment(message: Message, partId: string): MessageAttachment {
  const found = messageAttachments(message.payload).find((attachment) => attachment.partId === partId);
  if (!found) {
    throw new GmailError(`message has no attachment at part ${partId}`, 422);
  }
  return found;
}

async function attachmentBytes(
  messageId: string,
  attachment: MessageAttachment,
  options: GmailOptions,
): Promise<Buffer> {
  if (attachment.size > ATTACHMENT_CAP) {
    throw new GmailError("attachment is larger than 25 MB", 422);
  }
  if (!attachment.attachmentId) {
    return Buffer.from(attachment.data, "base64url");
  }
  const path = `/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.attachmentId)}`;
  const fetched = await gmailRequest({ method: "GET", path, schema: AttachmentResponse }, options);
  return Buffer.from(typeof fetched.data === "string" ? fetched.data : "", "base64url");
}

/** The attachment's filename as one name in the workspace root: no folders, controls, or leading dots. */
export function attachmentFileName(attachment: MessageAttachment): string {
  const name = attachment.filename.replace(/[\p{Cc}/\\]/gu, "-").replace(/^\.+/, "").trim();
  return (name || `attachment-${attachment.partId}`).slice(0, 200);
}

async function saveAttachment(workspaceDir: string, filePath: string, bytes: Buffer): Promise<string> {
  try {
    return await writeAgentFile(workspaceDir, filePath, bytes);
  } catch (error) {
    if (error instanceof AgentFileError) {
      throw new GmailError(error.message, 422);
    }
    throw error;
  }
}

export async function ping(accessToken: string, options: Omit<GmailOptions, "accessToken"> = {}): Promise<string> {
  const request = { method: "GET", path: "/users/me/profile", schema: ProfileResponse };
  const email = (await gmailRequest(request, { accessToken, ...options })).emailAddress;
  return typeof email === "string" && email.trim() ? email.trim() : "ok";
}

/** A thread's row: its id, the first message's sender, subject and date, and a snippet. */
async function threadRow(thread: ThreadSummary, options: GmailOptions): Promise<string | null> {
  const id = String(thread.id ?? "").trim();
  if (!id) {
    return null;
  }
  const detail = await gmailRequest(
    {
      method: "GET",
      path: `/users/me/threads/${encodeURIComponent(id)}`,
      schema: ThreadResponse,
      params: { format: "metadata", metadataHeaders: METADATA_HEADERS },
    },
    options,
  );
  const first = detail.messages?.[0] ?? {};
  const headers = headerMap(first.payload?.headers);
  return joinParts(id, headers.from, headers.subject, headers.date, clipText(first.snippet ?? thread.snippet, SNIPPET_CAP));
}

export async function searchThreadsTool(
  arguments_: Record<string, unknown>,
  options: GmailOptions,
): Promise<string> {
  const query = argStr(arguments_, "query");
  if (!query) {
    throw new GmailError("query is required");
  }
  const limit = rowLimit(arguments_);
  const listed = await gmailRequest(
    {
      method: "GET",
      path: "/users/me/threads",
      schema: ThreadListResponse,
      params: { q: query, maxResults: String(limit), pageToken: argStr(arguments_, "page_key") || undefined },
    },
    options,
  );
  const rows: string[] = [];
  for (const thread of (listed.threads ?? []).slice(0, limit)) {
    const row = await threadRow(thread, options);
    if (row !== null) {
      rows.push(row);
    }
  }
  const estimate = listed.resultSizeEstimate;
  const count = typeof estimate === "number" ? estimate : rows.length;
  const body = clipRows(rows, limit);
  if (body === "no results") {
    return joinParts(query, `n=${count}`);
  }
  const parts = [joinParts(query, `n=${count}`), body];
  const token = pageToken(listed.nextPageToken);
  if (token) {
    parts.push(`page=${token}`);
  }
  return parts.join("\n");
}

export async function getThreadTool(
  arguments_: Record<string, unknown>,
  options: GmailOptions,
): Promise<string> {
  const threadId = argStr(arguments_, "thread_id");
  if (!threadId) {
    throw new GmailError("thread_id is required");
  }
  const path = `/users/me/threads/${encodeURIComponent(threadId)}`;
  const payload = await gmailRequest({ method: "GET", path, schema: ThreadResponse, params: { format: "full" } }, options);
  const messages = payload.messages ?? [];
  const blocks = messages.map(formatMessage);
  const intro = joinParts(payload.id ?? threadId, `messages=${messages.length}`);
  return [intro, ...blocks].filter(Boolean).join("\n---\n") || "no results";
}

async function fullMessage(messageId: string, options: GmailOptions): Promise<Message> {
  const path = `/users/me/messages/${encodeURIComponent(messageId)}`;
  return gmailRequest({ method: "GET", path, schema: Message, params: { format: "full" } }, options);
}

export async function getMessageTool(
  arguments_: Record<string, unknown>,
  options: GmailOptions,
): Promise<string> {
  const messageId = argStr(arguments_, "message_id");
  if (!messageId) {
    throw new GmailError("message_id is required");
  }
  return formatMessage(await fullMessage(messageId, options)) || "no results";
}

export async function downloadAttachmentTool(
  arguments_: Record<string, unknown>,
  options: GmailOptions,
): Promise<string> {
  const workspaceDir = options.workspaceDir;
  if (!workspaceDir) {
    throw new GmailError("download_attachment is only available during an agent run", 422);
  }
  const messageId = requiredArg(arguments_, "message_id");
  const partId = requiredArg(arguments_, "part_id");
  const attachment = findAttachment(await fullMessage(messageId, options), partId);
  const bytes = await attachmentBytes(messageId, attachment, options);
  const filePath = argStr(arguments_, "file_path") || attachmentFileName(attachment);
  const resolved = await saveAttachment(workspaceDir, filePath, bytes);
  return joinParts(
    `file_path=${agentDisplayPath(workspaceDir, resolved)}`,
    attachment.mimeType,
    `bytes=${bytes.length}`,
  );
}

export async function listLabelsTool(
  _arguments: Record<string, unknown>,
  options: GmailOptions,
): Promise<string> {
  const payload = await gmailRequest({ method: "GET", path: "/users/me/labels", schema: LabelsResponse }, options);
  const rows = (payload.labels ?? []).map((label) =>
    joinParts(label.id, label.name, label.type),
  );
  return clipRows(rows.filter(Boolean), 100);
}

/** A draft's row: its id, its message's id, and the message's recipient and subject. */
async function draftRow(draft: DraftSummary, options: GmailOptions): Promise<string | null> {
  const id = String(draft.id ?? "").trim();
  if (!id) {
    return null;
  }
  const detail = await gmailRequest(
    {
      method: "GET",
      path: `/users/me/drafts/${encodeURIComponent(id)}`,
      schema: DraftResponse,
      params: { format: "metadata", metadataHeaders: METADATA_HEADERS },
    },
    options,
  );
  const message = detail.message ?? {};
  const headers = headerMap(message.payload?.headers);
  return joinParts(id, message.id, headers.to, headers.subject);
}

export async function listDraftsTool(
  arguments_: Record<string, unknown>,
  options: GmailOptions,
): Promise<string> {
  const limit = rowLimit(arguments_);
  const listed = await gmailRequest(
    {
      method: "GET",
      path: "/users/me/drafts",
      schema: DraftListResponse,
      params: { maxResults: String(limit), pageToken: argStr(arguments_, "page_key") || undefined },
    },
    options,
  );
  const rows: string[] = [];
  for (const draft of (listed.drafts ?? []).slice(0, limit)) {
    const row = await draftRow(draft, options);
    if (row !== null) {
      rows.push(row);
    }
  }
  const body = clipRows(rows, limit);
  const token = pageToken(listed.nextPageToken);
  if (body === "no results") {
    return body;
  }
  return token ? `${body}\npage=${token}` : body;
}

export async function createDraftTool(
  arguments_: Record<string, unknown>,
  options: GmailOptions,
): Promise<string> {
  const body = { message: { raw: rfc2822Raw(composeFields(arguments_)) } };
  const payload = await gmailRequest({ method: "POST", path: "/users/me/drafts", schema: DraftResponse, body }, options);
  return joinParts(`draft=${payload.id ?? ""}`, `message=${payload.message?.id ?? ""}`) || "ok";
}

export async function sendMessageTool(
  arguments_: Record<string, unknown>,
  options: GmailOptions,
): Promise<string> {
  const body = { raw: rfc2822Raw(composeFields(arguments_)) };
  const payload = await gmailRequest({ method: "POST", path: "/users/me/messages/send", schema: SentResponse, body }, options);
  return joinParts(`id=${payload.id ?? ""}`, `thread=${payload.threadId ?? ""}`) || "ok";
}

const HANDLERS: Record<string, (arguments_: Record<string, unknown>, options: GmailOptions) => Promise<string>> = {
  search_threads: searchThreadsTool,
  get_thread: getThreadTool,
  get_message: getMessageTool,
  download_attachment: downloadAttachmentTool,
  list_labels: listLabelsTool,
  list_drafts: listDraftsTool,
  create_draft: createDraftTool,
  send_message: sendMessageTool,
};

export async function callTool(
  name: string,
  arguments_: Record<string, unknown>,
  options: GmailOptions,
): Promise<string> {
  const handler = HANDLERS[name];
  if (!handler) {
    throw new GmailError(`unknown Gmail tool ${name}`);
  }
  return handler(arguments_, options);
}
